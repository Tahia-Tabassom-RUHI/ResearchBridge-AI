"""Organization of saved Vault records by paper ID."""
from uuid import uuid4

import streamlit as st

from services.vault_session import persist_vault


STATUSES = ("To Read", "Reading", "Finished")


def catalog():
    papers = dict(st.session_state.saved_papers)
    for search in st.session_state.saved_combos:
        members = set(search.get("reading_ids", []))
        for paper in [*search.get("papers", []), *search.get("articles", [])]:
            if paper["id"] in members:
                papers.setdefault(paper["id"], paper)
    return papers


def validate_papers(ids):
    if not set(ids).issubset(catalog()):
        raise ValueError("A selected paper is no longer in your Library.")


def save_folder(name, description, ids=(), folder_id=None):
    name = name.strip()
    folders = st.session_state.folders
    if not name or len(name) > 80:
        raise ValueError("Enter a folder name of 1 to 80 characters.")
    if any(key != folder_id and f["name"].casefold() == name.casefold() for key, f in folders.items()):
        raise ValueError("A folder with that name already exists.")
    if folder_id is not None and folder_id not in folders:
        raise ValueError("That folder is no longer available.")
    validate_papers(ids)
    folder_id = folder_id or uuid4().hex
    folders[folder_id] = {"name": name, "description": description.strip()}
    st.session_state.paper_folders.update(dict.fromkeys(ids, folder_id))
    return folder_id if persist_vault(fields=("folders", "paper_folders")) else None


def move_papers(ids, folder_id):
    validate_papers(ids)
    if folder_id is not None and folder_id not in st.session_state.folders:
        raise ValueError("Choose an existing folder.")
    for paper_id in ids:
        if folder_id is None:
            st.session_state.paper_folders.pop(paper_id, None)
        else:
            st.session_state.paper_folders[paper_id] = folder_id
    return persist_vault(fields=("paper_folders",))


def delete_folder(folder_id):
    del st.session_state.folders[folder_id]
    st.session_state.paper_folders = {
        key: value for key, value in st.session_state.paper_folders.items() if value != folder_id
    }
    return persist_vault(fields=("folders", "paper_folders"))


def set_status(paper_id, status):
    validate_papers([paper_id])
    if status not in STATUSES:
        raise ValueError("Choose a reading status.")
    st.session_state.reading_status[paper_id] = status
    return persist_vault(fields=("reading_status",))


def open_library(view="all", paper_id=None, *, selected=None):
    if selected is None:
        selected = [paper_id] if paper_id else []
    st.session_state.update(ui_step="My Library", library_location=view,
                            library_selection=list(selected),
                            library_preview=paper_id, nav_panel_open=False)
    st.session_state.pop("library_search", None)
    st.session_state.pop("library_unassigned", None)
