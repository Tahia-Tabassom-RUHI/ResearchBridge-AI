"""Session-only guided reading of a student-supplied paper abstract."""

import ipaddress
import re
from copy import deepcopy
from urllib.parse import urlsplit
from uuid import uuid4

import streamlit as st

from models.schemas import Paper
from services.paper_reader import (
    MIN_ABSTRACT_WORDS,
    REFLECTION_PROMPTS,
    excerpt_matches,
    validate_paper_input,
)


def _safe_original_url(value: object) -> bool:
    """Validate a manual link locally without resolving its destination."""
    if not isinstance(value, str) or not value:
        return False
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        return False
    if "\\" in value or re.search(r"%(?![0-9a-fA-F]{2})|%0[ad]", value, re.IGNORECASE):
        return False
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        if parsed.netloc.endswith(":") or (
            parsed.port is not None and not 1 <= parsed.port <= 65535
        ):
            return False

        host = parsed.hostname.rstrip(".")
        if ":" in host or re.fullmatch(r"[0-9.]+", host):
            ipaddress.ip_address(host)
        else:
            host = host.encode("idna").decode("ascii")
            label_pattern = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
            if len(host) > 253 or any(
                not re.fullmatch(label_pattern, label) for label in host.split(".")
            ):
                return False
    except ValueError:
        return False
    return True


def _new_reader_state() -> dict:
    return {
        "paper": None,
        "draft": {
            prompt.id: {"answer": "", "excerpt": "", "not_stated": False}
            for prompt in REFLECTION_PROMPTS
        },
        "saved_reflections": None,
    }


def load_retrieved_paper(record: dict) -> None:
    """Open a real discovery record in the existing guided reader."""
    errors = validate_paper_input(record.get("title"), record.get("abstract"))
    if errors:
        raise ValueError(errors[0])
    current = st.session_state.get("paper_reader")
    current_paper = current["paper"] if current else None
    paper_id = record["id"]
    if current_paper and current_paper.id == paper_id:
        return

    # Keep inactive retrieved papers separate from the active reader so Reset
    # can discard the open paper without affecting work on other papers.
    inactive = st.session_state.setdefault("paper_reader_inactive", {})
    state = inactive.pop(paper_id, None)
    if state is None:
        state = _new_reader_state()
        state["paper"] = Paper(
            id=paper_id, title=record["title"], abstract=record["abstract"],
            authors=record.get("authors"), doi=record.get("doi"),
            publication_date=record.get("publication_date"),
            source_name=record.get("source_name"), paper_url=record.get("paper_url"),
            oa_url=record.get("oa_url"), paper_type=record.get("paper_type"),
            is_retracted=record.get("is_retracted"),
            retrieved_at=record.get("retrieved_at"), provenance=record.get("provenance"),
        )
    if current_paper and not current_paper.id.startswith("manual:"):
        inactive[current_paper.id] = current
    elif current_paper:
        st.session_state["paper_reader_manual"] = current
    st.session_state["paper_reader"] = state
    for key in list(st.session_state):
        if key.startswith("_paper_reader_"):
            st.session_state.pop(key, None)


def open_manual_reader() -> None:
    current = st.session_state.get("paper_reader")
    paper = current.get("paper") if current else None
    if paper and not paper.id.startswith("manual:"):
        st.session_state.setdefault("paper_reader_inactive", {})[paper.id] = current
        _reset_reader()
    if not st.session_state.get("paper_reader") and "paper_reader_manual" in st.session_state:
        st.session_state["paper_reader"] = st.session_state.pop("paper_reader_manual")
    st.session_state.update(ui_step="Guided reading", guided_standalone=True, nav_panel_open=False)


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
            st.caption("Optional metadata is supplied by you and remains unverified.")
            original_url = st.text_input(
                "Original paper URL (optional)", key="_paper_reader_url"
            )
            doi = st.text_input("DOI (optional)", key="_paper_reader_doi")
            authors = st.text_input(
                "Authors (optional, separate with semicolons)", key="_paper_reader_authors"
            )
            year = st.text_input("Publication year (optional)", key="_paper_reader_year")
            start = st.form_submit_button("Start Reading")
        if start:
            errors = validate_paper_input(title, abstract)
            original_url = original_url.strip()
            year = year.strip()
            if original_url and not _safe_original_url(original_url):
                errors.append("Enter a valid HTTP or HTTPS original paper URL without credentials.")
            if year and not re.fullmatch(r"[1-9][0-9]{3}", year):
                errors.append("Enter a four-digit publication year, or leave it blank.")
            if errors:
                for error in errors:
                    st.error(error)
            else:
                state["paper"] = Paper(
                    id=f"manual:{uuid4()}",
                    title=title.strip(),
                    abstract=abstract,
                    paper_url=original_url or None,
                    doi=doi.strip() or None,
                    authors=[name.strip() for name in authors.split(";") if name.strip()] or None,
                    publication_date=year or None,
                    source_name="Manual entry",
                    provenance={"origin": "user_provided", "verification": "unverified"},
                )
                st.rerun()
        return

    paper = state["paper"]
    st.subheader(paper.title)
    is_manual = paper.id.startswith("manual:")
    if is_manual:
        st.caption("Manually entered paper and metadata are user-provided and unverified.")
        if paper.authors:
            st.text("Authors: " + "; ".join(paper.authors))
        if paper.publication_date:
            st.text("Publication year: " + paper.publication_date)
        if paper.doi:
            st.text("DOI: " + paper.doi)
        if paper.paper_url and _safe_original_url(paper.paper_url):
            st.text("Original source: " + paper.paper_url)
            st.link_button("Open user-provided paper ↗", paper.paper_url)
    elif paper.paper_url:
        st.link_button("Open original paper ↗", paper.paper_url)
    if paper.oa_url:
        st.link_button("Open free full text ↗", paper.oa_url)
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
