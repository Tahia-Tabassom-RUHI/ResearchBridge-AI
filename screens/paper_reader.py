"""Session-only guided reading of a student-supplied paper abstract."""

from copy import deepcopy
from uuid import uuid4

import streamlit as st

from models.schemas import Paper
from services.paper_reader import (
    MIN_ABSTRACT_WORDS,
    REFLECTION_PROMPTS,
    excerpt_matches,
    validate_paper_input,
)


def _new_reader_state() -> dict:
    return {
        "paper": None,
        "draft": {
            prompt.id: {"answer": "", "excerpt": "", "not_stated": False}
            for prompt in REFLECTION_PROMPTS
        },
        "saved_reflections": None,
    }


def _reset_reader() -> None:
    """Discard only this reader's state, on an explicit reset action."""
    st.session_state.pop("paper_reader", None)
    for key in list(st.session_state):
        if key.startswith("_paper_reader_"):
            st.session_state.pop(key, None)


def _update_reflection(prompt_id: str, field: str, widget_key: str) -> None:
    st.session_state["paper_reader"]["draft"][prompt_id][field] = (
        st.session_state[widget_key]
    )


def _show_source_match(abstract: str, excerpt: str) -> None:
    if excerpt_matches(abstract, excerpt):
        st.caption("Source-matching check: excerpt found in the supplied abstract.")
    else:
        st.caption("Source-matching check: excerpt not found in the supplied abstract.")


def _render_saved_review(paper: Paper, reflections: dict) -> None:
    st.subheader("Saved reflection review")
    for prompt in REFLECTION_PROMPTS:
        reflection = reflections[prompt.id]
        with st.expander(prompt.title, expanded=True):
            if reflection["not_stated"]:
                st.write("Not stated in the abstract")
                continue
            st.write("Your answer")
            st.text(reflection["answer"] or "Not answered yet")
            if reflection["excerpt"].strip():
                st.write("Supporting excerpt")
                st.text(reflection["excerpt"])
                _show_source_match(paper.abstract, reflection["excerpt"])
            else:
                st.caption("No supporting excerpt provided.")


def render_paper_reader() -> None:
    """Render loading, editable reflections, and a persistent saved review."""
    st.title("Guided Research Paper Reading")
    st.caption(
        "Guided, rule-based demo. No AI is used and correctness is not "
        "automatically assessed. Work is kept only in this Streamlit session."
    )
    st.session_state.setdefault("paper_reader", _new_reader_state())
    state = st.session_state["paper_reader"]

    if state["paper"] is None:
        with st.form("paper_reader_load"):
            title = st.text_input("Paper title", key="_paper_reader_title")
            abstract = st.text_area(
                "Paste the abstract",
                height=220,
                help=f"Use at least {MIN_ABSTRACT_WORDS} words containing letters. "
                "This is a length check, not a scientific quality check.",
                key="_paper_reader_abstract",
            )
            start = st.form_submit_button("Start Reading")
        if start:
            errors = validate_paper_input(title, abstract)
            if errors:
                for error in errors:
                    st.error(error)
            else:
                state["paper"] = Paper(
                    id=f"manual:{uuid4()}", title=title.strip(), abstract=abstract
                )
                st.rerun()
        return

    paper = state["paper"]
    st.subheader(paper.title)
    st.write("Original abstract")
    st.text(paper.abstract)
    st.button("Start Another Paper / Reset", on_click=_reset_reader)
    st.subheader("Guided reflections")
    st.write(
        "Use your own words and stay within the supplied abstract. You can save "
        "an incomplete draft. If a point is absent, select 'Not stated in the abstract'."
    )
    st.caption(
        "A source-matching check only looks for the excerpt's text, ignoring "
        "case and whitespace differences. A match is not proof that your "
        "interpretation is correct; a non-match is not a grade."
    )

    for prompt in REFLECTION_PROMPTS:
        reflection = state["draft"][prompt.id]
        st.markdown(f"**{prompt.title}: {prompt.question}**")
        st.caption(prompt.hint)
        for field in ("not_stated", "answer", "excerpt"):
            widget_key = f"_paper_reader_{prompt.id}_{field}"
            # Restore widgets from the durable draft if they were not rendered
            # on a previous app rerun. Edits update the draft via callbacks.
            st.session_state.setdefault(widget_key, reflection[field])
            kwargs = {
                "key": widget_key,
                "on_change": _update_reflection,
                "args": (prompt.id, field, widget_key),
            }
            if field == "not_stated":
                st.checkbox("Not stated in the abstract", **kwargs)
            else:
                label = (
                    f"Your answer — {prompt.title}"
                    if field == "answer"
                    else f"Supporting excerpt (optional) — {prompt.title}"
                )
                st.text_area(label, disabled=reflection["not_stated"], **kwargs)
        if not reflection["not_stated"] and reflection["excerpt"].strip():
            _show_source_match(paper.abstract, reflection["excerpt"])

    if st.button("Save Reflections"):
        state["saved_reflections"] = deepcopy(state["draft"])

    saved = state["saved_reflections"]
    if saved is not None:
        if saved == state["draft"]:
            st.success("Reflections saved for this session.")
        else:
            st.info("Unsaved changes. Your previous saved review is shown below.")
        _render_saved_review(paper, saved)


if __name__ == "__main__":
    render_paper_reader()
