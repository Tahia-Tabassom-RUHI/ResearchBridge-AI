"""Shared chrome for the Library and Guided Reading journal surfaces."""
from html import escape

import streamlit as st

from services.library import open_library


def _search_library():
    query = st.session_state.guided_library_query.strip()
    if query:
        open_library("collection")
        st.session_state.library_search = query


def journal_header(title, subtitle, section, *, search=True, guided=False, collection_heading=False):
    with st.container(key="journal_topbar", horizontal=True, vertical_alignment="center"):
        st.html(f'<nav class="journal-crumb" aria-label="Location">Research workspace'
                f'<span aria-hidden="true">/</span><b>{escape(section)}</b></nav>')
        if search:
            st.text_input("Search papers", key="guided_library_query" if guided else "library_search",
                          icon=":material/search:", placeholder="Search your library…",
                          label_visibility="collapsed", width=310,
                          on_change=_search_library if guided else None)
    with st.container(key="journal_hero"):
        if collection_heading:
            st.header(title, anchor=False)
        else:
            st.title(title, anchor=False)
        st.html(f'<p class="journal-subtitle">{escape(subtitle)}</p>')
