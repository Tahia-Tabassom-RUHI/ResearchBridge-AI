"""The student's folder-based Library workspace."""
from collections import Counter
from hashlib import sha256

import streamlit as st

from screens.discovery_workspace import choose_reader
from screens.paper_reader import load_retrieved_paper, open_manual_reader
from services import library
from services.papers import doi_url, safe_url


def finish(message, location=None, paper_id=None, *, selected=None):
    if location is not None:
        library.open_library(location, paper_id, selected=selected)
    st.session_state.library_notice = message
    st.rerun()


def folder_form(key, ids=(), folder_id=None):
    folder = st.session_state.folders.get(folder_id, {})
    with st.form(key):
        name = st.text_input("Folder name", value=folder.get("name", ""), max_chars=80)
        description = st.text_area("Description (optional)", value=folder.get("description", ""))
        if st.form_submit_button("Save changes" if folder_id else "Create folder"):
            try:
                saved = library.save_folder(name, description, ids, folder_id)
            except ValueError as error:
                st.error(str(error))
            else:
                if saved:
                    if folder_id:
                        finish("Folder updated.")
                    finish("Folder created.", saved, selected=ids)
                st.error(st.session_state.vault_error)


def library_sidebar():
    state = st.session_state
    active = state.get("library_location", "all") if state.ui_step == "My Library" and not state.nav_panel_open else None
    for location, label in [("all", "All Papers"), ("to_read", "To Read")]:
        st.button(label, key="nav_" + location, type="primary" if active == location else "tertiary",
                  on_click=library.open_library, args=(location,), width="stretch")
    st.caption("My Folders")
    counts = Counter(state.paper_folders.values())
    for key, folder in state.folders.items():
        label = f"{folder['name']} ({counts[key]})"
        st.button(label, key="folder_" + key, width="stretch",
                  type="primary" if active == key else "tertiary",
                  on_click=library.open_library, args=(key,))
    st.button("+ New Folder", type="tertiary", width="stretch", key="nav_new", on_click=library.open_library, args=("new",))


def toggle_selection(paper_id, widget):
    selected = st.session_state.library_selection
    if st.session_state[widget] and paper_id not in selected:
        selected.append(paper_id)
    elif not st.session_state[widget] and paper_id in selected:
        selected.remove(paper_id)


def bulk_toolbar(selected):
    state = st.session_state
    with st.container(horizontal=True, vertical_alignment="center", gap="small", key="library_toolbar"):
        st.write(f"{len(selected)} selected")
        with st.popover("Move to Folder", disabled=not selected or not state.folders):
            names = {key: folder["name"] for key, folder in state.folders.items()}
            target = st.selectbox("Destination folder", list(names), format_func=names.__getitem__)
            if st.button("Move papers"):
                if library.move_papers(selected, target):
                    finish("Papers moved.", target, selected[0], selected=selected)
                st.error(state.vault_error)
        with st.popover("New Folder with Selection", disabled=not selected):
            folder_form("bulk_create", selected)
        if st.button("Remove from Folder", disabled=not any(i in state.paper_folders for i in selected)):
            if library.move_papers(selected, None):
                finish("Papers removed from their folder.", "all")
            st.error(state.vault_error)
        if st.button("Clear Selection", disabled=not selected):
            state.library_selection = []
            st.rerun()


def preview(paper):
    state = st.session_state
    paper_id = paper["id"]
    st.subheader(paper["title"])
    if paper.get("authors"):
        st.text(", ".join(paper["authors"]))
    metadata = [paper.get("source_name"), paper.get("publication_date"),
                (paper.get("provenance") or {}).get("source")]
    if any(metadata):
        st.caption(" · ".join(filter(None, metadata)))
    if paper.get("is_retracted"):
        st.warning("The source marks this paper as retracted.")
    with st.container(horizontal=True):
        if url := doi_url(paper.get("doi")):
            st.link_button("DOI", url, help=paper["doi"])
        if url := safe_url(paper.get("paper_url")):
            st.link_button("Original source", url)

    status = state.reading_status.get(paper_id, "To Read")
    widget = "status_" + paper_id
    def update_status():
        if library.set_status(paper_id, state[widget]):
            state.library_notice = "Reading status updated."
        else:
            state[widget] = state.reading_status.get(paper_id, "To Read")
    st.selectbox("Reading status", library.STATUSES, index=library.STATUSES.index(status),
                 key=widget, on_change=update_status)
    with st.container(horizontal=True):
        st.button("Open Paper Workspace", key="workspace_open", type="primary",
                  on_click=choose_reader, args=(paper, "My Library"))
        current = state.get("paper_reader", {}).get("paper")
        continued = (current and current.id == paper_id) or paper_id in state.get("paper_reader_inactive", {})
        if paper.get("paper_type") not in ("Background article", "Source link") and st.button(
            "Continue Guided Reading" if continued else "Start Guided Reading", key="library_guided"
        ):
            try:
                load_retrieved_paper(paper)
            except ValueError as error:
                st.info(str(error))
            else:
                choose_reader(paper, "My Library")
                state.guided_standalone = False
                state.ui_step = "Guided reading"
                st.rerun()

    st.markdown("**Abstract**")
    st.text(paper.get("abstract") or "The source did not supply an abstract.")


def render_library(navigate):
    state = st.session_state
    papers = library.catalog()
    location = state.get("library_location", "all")
    if location == "new":
        st.header("New Folder")
        folder_form("sidebar_create")
        return
    folder = state.folders.get(location)
    with st.container(horizontal=True, vertical_alignment="center", key="library_heading"):
        st.header(folder["name"] if folder else "To Read" if location == "to_read" else "All Papers")
        if not folder:
            st.button("Read your own abstract", key="manual_entry", type="tertiary",
                      icon=":material/edit_note:", on_click=open_manual_reader)
    if notice := state.pop("library_notice", None):
        st.toast(notice)
    if folder:
        if folder["description"]:
            st.caption(folder["description"])
        with st.popover("Folder actions"):
            folder_form("edit_" + location, folder_id=location)
            st.caption("Deleting this folder keeps its papers in All Papers.")
            confirmed = st.checkbox("Confirm folder deletion", key="confirm_" + location)
            if st.button("Delete folder", disabled=not confirmed):
                if library.delete_folder(location):
                    finish("Folder deleted. Its papers are in All Papers.", "all")
                st.error(state.vault_error)
    members = [
        key for key in papers
        if (not folder or state.paper_folders.get(key) == location)
        and (location != "to_read" or state.reading_status.get(key, "To Read") == "To Read")
    ]
    st.caption(f"{len(members)} paper" + ("" if len(members) == 1 else "s"))
    if not members:
        st.info("Move papers here from All Papers." if folder else
                "Papers marked To Read appear here." if location == "to_read" else
                "Save papers from Discovery to start your Library.")
        if folder or location == "to_read":
            st.button("Browse All Papers", on_click=library.open_library)
        else:
            st.button("Discover Papers", key="library_discover", on_click=navigate, args=("Question",))
        return
    selected = [key for key in state.get("library_selection", []) if key in papers]
    state.library_selection = selected
    bulk_toolbar(selected)
    left, right = st.container(key="library_panes").columns([5, 6], gap="small")
    handles = {}
    with left.container(key="library_list", border=True):
        search = st.text_input("Search papers", key="library_search", placeholder="Title, author or source")
        unassigned = location == "all" and st.checkbox("Not in a folder", key="library_unassigned")
        visible = [key for key in members if (not unassigned or key not in state.paper_folders)
                   and search.casefold() in " ".join([papers[key]["title"], *(papers[key].get("authors") or []),
                       papers[key].get("source_name") or ""]).casefold()]
        if not visible:
            st.info("No matching papers.")
        focus = state.get("library_preview")
        if focus not in visible:
            focus = visible[0] if visible else None
        for key in visible:
            paper = papers[key]
            handle = "paper_" + sha256(key.encode()).hexdigest()
            handles[handle] = key
            with st.container(key="librow_" + handle, horizontal=True, gap="small", vertical_alignment="center"):
                widget = "select_" + key
                state[widget] = key in selected
                st.checkbox("Select " + paper["title"], key=widget, label_visibility="collapsed",
                            on_change=toggle_selection, args=(key, widget), width="content")
                with st.container(width="stretch", gap=None):
                    st.button(paper["title"], key=handle, width="stretch",
                              type="secondary" if focus == key else "tertiary",
                              icon=":material/drag_indicator:" if state.folders else None,
                              on_click=state.update, kwargs={"library_preview": key})
                    st.caption(" · ".join(filter(None, [state.reading_status.get(key, "To Read"),
                                                       paper.get("source_name"), paper.get("publication_date")])))
    with right.container(key="library_detail", border=True):
        if focus:
            preview(papers[focus])
        else:
            st.caption("Choose a paper to preview it here.")
    from components.library_drag import enable_drag
    enable_drag(handles, selected)
