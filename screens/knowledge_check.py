"""Standalone Streamlit preview for a quick knowledge check."""

import streamlit as st


def render_knowledge_check() -> None:
    """Render the quick knowledge check and skip confirmation."""
    st.title("Quick Knowledge Check")

    st.radio(
        "In supervised Machine Learning, what does a model learn from?",
        options=[
            "Labeled examples with known answers",
            "Unlabeled data with no known answers",
            "Rewards and penalties from interacting with an environment",
            "I don't know",
        ],
        index=None,
    )

    if st.button("Skip assessment"):
        st.success("Assessment skipped.")


if __name__ == "__main__":
    render_knowledge_check()
