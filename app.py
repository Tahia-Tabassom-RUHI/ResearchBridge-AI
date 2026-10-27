"""Minimal Streamlit entry point for ResearchBridge AI."""

import streamlit as st

from screens.knowledge_check import render_knowledge_check
from screens.paper_reader import render_paper_reader


home, knowledge_check, paper_reader = st.tabs(
    ["Home", "Knowledge Check", "Guided Paper Reading"]
)

with home:
    st.title("ResearchBridge AI")
    st.write(
        "An interactive research-learning web application that helps students "
        "explore scholarly research and build prerequisite knowledge."
    )
    st.info("Development is currently in progress.")

with knowledge_check:
    render_knowledge_check()

with paper_reader:
    render_paper_reader()
