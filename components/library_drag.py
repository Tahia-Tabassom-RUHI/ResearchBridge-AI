"""Attach HTML5 drag events to the Library's native paper and folder buttons."""
from pathlib import Path

import streamlit as st

from services.library import move_papers, open_library


drag = st.components.v2.component(
    "library_drag", js=Path(__file__).with_suffix(".js").read_text(encoding="utf-8")
)


def apply_drop(event, handles, selected):
    if not isinstance(event, dict):
        return
    handle, destination = event.get("handle"), event.get("folder")
    if not isinstance(handle, str) or not isinstance(destination, str):
        return
    paper = handles.get(handle)
    folders = st.session_state.folders
    if paper and destination in folders:
        ids = selected if paper in selected else [paper]
        if move_papers(ids, destination):
            open_library(destination, paper, selected=ids)
            st.session_state.library_notice = f"Moved {len(ids)} to {folders[destination]['name']}."


def enable_drag(handles, selected):
    def on_drop():
        apply_drop(st.session_state.library_drag["move"], handles, selected)

    drag(key="library_drag", data={"papers": handles, "folders": list(st.session_state.folders),
                                  "selected": selected}, on_move_change=on_drop)
