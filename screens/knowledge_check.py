"""Standalone Streamlit preview for a quick knowledge check."""

import streamlit as st


def render_knowledge_check() -> None:
    """Render the quick knowledge check and skip confirmation."""
    st.title("Quick Knowledge Check")

    st.session_state.setdefault("knowledge_check_skipped", False)
    st.session_state.setdefault("knowledge_check_answer", None)
    st.session_state.setdefault("knowledge_check_submitted_answer", None)

    if st.session_state["knowledge_check_skipped"]:
        st.success("Assessment skipped")
        if st.button("Restart assessment"):
            st.session_state["knowledge_check_skipped"] = False
            st.session_state["knowledge_check_answer"] = None
            st.session_state["knowledge_check_submitted_answer"] = None
            st.rerun()
        return

    st.session_state["knowledge_check_answer"] = st.radio(
        "In supervised Machine Learning, what does a model learn from?",
        options=[
            "Labeled examples with known answers",
            "Unlabeled data with no known answers",
            "Rewards and penalties from interacting with an environment",
            "I don't know",
        ],
        index=None,
    )

    answer = st.session_state["knowledge_check_answer"]
    if st.session_state["knowledge_check_submitted_answer"] != answer:
        st.session_state["knowledge_check_submitted_answer"] = None

    if st.button("Submit answer", disabled=answer is None):
        st.session_state["knowledge_check_submitted_answer"] = answer

    if st.session_state["knowledge_check_submitted_answer"] is not None:
        st.success("Answer submitted")

    if st.button("Skip assessment"):
        st.session_state["knowledge_check_skipped"] = True
        st.session_state["knowledge_check_answer"] = None
        st.session_state["knowledge_check_submitted_answer"] = None
        st.rerun()


if __name__ == "__main__":
    render_knowledge_check()
