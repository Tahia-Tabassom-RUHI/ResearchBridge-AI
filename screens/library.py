"""The student's folder-based Library workspace."""
from collections import Counter
from hashlib import sha256
from html import escape

import streamlit as st

from screens.journal import journal_header
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
        label = f"{folder['name']} **{counts[key]}**"
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
        with st.popover("Organize selection", disabled=not selected):
            st.write("New folder with selection")
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
                state.pop("guided_picker", None)
                state.pop("manual_picker", None)
                state.guided_standalone = False
                state.ui_step = "Guided reading"
                st.rerun()

    st.markdown("**Abstract**")
    st.text(paper.get("abstract") or "The source did not supply an abstract.")


def folder_shelf(papers):
    state = st.session_state
    st.subheader("Folders")
    counts = Counter(state.paper_folders.values())
    st.button(f"All papers **{len(papers)}**", key="shelf_all", width="stretch",
              icon=":material/library_books:", on_click=library.open_library, args=("collection",))
    for folder_id, folder in state.folders.items():
        st.button(f"{folder['name']} **{counts[folder_id]}**", key="shelf_" + folder_id,
                  width="stretch", icon=":material/folder:", on_click=library.open_library, args=(folder_id,))
    st.button("New Folder", icon=":material/create_new_folder:", key="shelf_new",
              on_click=library.open_library, args=("new",))


def feature_cards(papers, open_guided):
    state = st.session_state
    current = state.get("paper_reader", {}).get("paper")
    reading = next((p for p in papers.values() if state.reading_status.get(p["id"]) == "Reading"), None)
    first, second, third = st.columns(3, gap="small")
    with first.container(key="feature_continue"):
        st.subheader("Continue Reading")
        st.caption(current.title if current else reading["title"] if reading else "Pick a paper from your reading list.")
        if current:
            st.button("Resume reading", on_click=open_guided)
        elif reading:
            st.button("Open paper", on_click=choose_reader, args=(reading, "My Library"))
        else:
            st.button("View reading list", on_click=library.open_library, args=("to_read",))
    with second.container(key="feature_saved"):
        st.subheader("Saved Papers")
        count = len(papers)
        st.caption(f"{count} saved paper" + ("" if count == 1 else "s") + " in your library.")
        st.button("Browse collection", on_click=library.open_library, args=("collection",))
    with third.container(key="feature_guided"):
        st.subheader("Guided Reading")
        st.caption("Explore a paper, one abstract at a time.")
        st.button("Read an abstract", key="manual_entry", on_click=open_manual_reader)


def select_preview(paper_id):
    st.session_state.library_preview = paper_id
    if st.session_state.get("library_location", "all") == "all":
        st.session_state.library_location = "collection"


def folder_heading(location, folder, count):
    with st.container(key="folder_heading", horizontal=True, vertical_alignment="center"):
        with st.container(width="stretch", gap=None):
            st.header(folder["name"], anchor=False)
            description = escape(folder.get("description") or "")
            st.html(f'<div class="folder-summary"><span class="paper-count">{count}</span>'
                    f'<span>{description}</span></div>')
        with st.popover("Folder actions"):
            folder_form("edit_" + location, folder_id=location)
            st.caption("Deleting this folder keeps its papers in All Papers.")
            confirmed = st.checkbox("Confirm folder deletion", key="confirm_" + location)
            if st.button("Delete folder", disabled=not confirmed):
                if library.delete_folder(location):
                    finish("Folder deleted. Its papers are in All Papers.", "all")
                st.error(st.session_state.vault_error)


def render_library(navigate, open_guided):
    state = st.session_state
    papers = library.catalog()
    location = state.get("library_location", "all")
    folder = state.folders.get(location)
    overview = location == "all"
    members = [
        key for key in papers
        if (not folder or state.paper_folders.get(key) == location)
        and (location != "to_read" or state.reading_status.get(key, "To Read") == "To Read")
    ]
    count = f"{len(members)} paper" + ("" if len(members) == 1 else "s")
    if folder:
        folder_heading(location, folder, count)
    else:
        title = {"all": "My Library", "new": "New Folder",
                "to_read": "To Read"}.get(location, "Saved Papers")
        subtitle = {
            "new": "Give this collection a name and a place on your shelf.",
            "to_read": "Papers you’ve set aside for your next reading session.",
        }.get(location, "A home for your papers, reading lists, and research notes.")
        journal_header(title, subtitle, title, search=location != "new", collection_heading=not overview)
    if location == "new":
        folder_form("sidebar_create")
        return
    if overview:
        feature_cards(papers, open_guided)
    elif not folder:
        st.button("Read your own abstract", key="manual_entry", on_click=open_manual_reader)
    if notice := state.pop("library_notice", None):
        st.toast(notice)
    selected = [key for key in state.get("library_selection", []) if key in papers]
    state.library_selection = selected
    if overview:
        shelf, listing = st.columns([1, 2.65], gap="medium")
        with shelf.container(key="folder_shelf", border=True):
            folder_shelf(papers)
        body = listing.container(key="saved_collection", border=True)
    else:
        body = st.container(key="folder_collection")
    with body:
        if overview:
            with st.container(horizontal=True, vertical_alignment="center", key="collection_title"):
                st.header("All Papers")
                st.html(f'<span class="paper-count">{count}</span>')
        elif not folder:
            st.caption(count)
        if not members:
            st.info("Move papers here from All Papers." if folder else
                    "Papers marked To Read appear here." if location == "to_read" else
                    "Save papers from Discovery to start your Library.")
            if folder or location == "to_read":
                st.button("Browse All Papers", on_click=library.open_library)
            else:
                st.button("Discover Papers", key="library_discover", on_click=navigate, args=("Question",))
            return
        if overview:
            listing = st.container()
        else:
            listing, detail = st.container(key="library_panes").columns([5, 6], gap="medium")
        with listing.container(key="library_list", border=not overview):
            with st.container(horizontal=True, vertical_alignment="center", key="list_options"):
                if folder:
                    st.text_input("Search folder", key="library_search", placeholder="Search this folder…",
                                  icon=":material/search:", label_visibility="collapsed")
                order = st.selectbox("Sort papers", ["Library order", "Title A–Z", "Newest publication"],
                                     key="library_sort", width=176, label_visibility="collapsed")
                unassigned = (overview or location == "collection") and st.checkbox(
                    "Not in a folder", key="library_unassigned")
            bulk_toolbar(selected)
            search = state.get("library_search", "").strip().casefold()
            visible = [key for key in members if (not unassigned or key not in state.paper_folders)
                       and search in " ".join([papers[key]["title"], *(papers[key].get("authors") or []),
                           papers[key].get("source_name") or ""]).casefold()]
            if order == "Title A–Z":
                visible.sort(key=lambda key: papers[key]["title"].casefold())
            elif order == "Newest publication":
                visible.sort(key=lambda key: papers[key].get("publication_date") or "", reverse=True)
            handles = {}
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
                                  on_click=select_preview, args=(key,))
                        status = state.reading_status.get(key, "To Read")
                        byline = " · ".join(filter(None, [", ".join(paper.get("authors") or []),
                                             paper.get("source_name"), paper.get("publication_date")]))
                        st.html(f'<div class="paper-byline"><span class="reading-status" '
                                f'data-status="{escape(status, quote=True)}">{escape(status)}</span>'
                                f'{escape(byline)}</div>')
        if overview:
            detail = st.expander("Paper preview", expanded=bool(state.get("library_preview")))
        with detail.container(key="library_detail", border=not overview):
            if focus:
                preview(papers[focus])
            else:
                st.caption("Choose a paper to preview it here.")
    from components.library_drag import enable_drag
    enable_drag(handles, selected)
