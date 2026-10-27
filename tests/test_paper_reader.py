"""Pure-helper and Streamlit checks for session-only guided paper reading."""

from copy import deepcopy
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from services.paper_reader import (
    MIN_ABSTRACT_WORDS,
    REFLECTION_PROMPTS,
    excerpt_matches,
    validate_paper_input,
)


ROOT = Path(__file__).resolve().parents[1]
SCREEN_PATH = ROOT / "screens" / "paper_reader.py"
TITLE = "Synthetic reading-test fixture"
ABSTRACT = (
    "  This is a synthetic reading-test fixture, not a real paper abstract.\n"
    "It describes a classroom exercise about reading summaries and asks students "
    "to identify a problem, an approach, and information that a summary does not state.  "
)


def _button(app, label):
    return next(button for button in app.button if button.label == label)


def _widget(app, prompt_id, field):
    widgets = app.checkbox if field == "not_stated" else app.text_area
    key = f"_paper_reader_{prompt_id}_{field}"
    return next(widget for widget in widgets if widget.key == key)


def _new_app():
    app = AppTest.from_file(str(SCREEN_PATH)).run(timeout=15)
    assert not app.exception
    return app


def _load_paper(app, title=TITLE, abstract=ABSTRACT):
    next(w for w in app.text_input if w.key == "_paper_reader_title").set_value(title)
    next(w for w in app.text_area if w.key == "_paper_reader_abstract").set_value(abstract)
    _button(app, "Start Reading").click().run()
    assert not app.exception
    return app


@pytest.mark.parametrize("title", [None, "", "  \t\n", 17, [], {}])
def test_validation_rejects_missing_or_malformed_title(title):
    assert "Enter a nonempty paper title." in validate_paper_input(title, ABSTRACT)


@pytest.mark.parametrize("abstract", [None, "", " \t\n", 17, [], {}])
def test_validation_rejects_missing_or_malformed_abstract(abstract):
    assert validate_paper_input(TITLE, abstract)


@pytest.mark.parametrize("abstract", ["Too short.", "!!! " * 30, "123 " * 30])
def test_validation_rejects_short_or_nonword_abstracts(abstract):
    assert validate_paper_input(TITLE, abstract)


def test_validation_has_a_documented_minimum_length_and_accepts_real_text():
    assert validate_paper_input(TITLE, "word " * (MIN_ABSTRACT_WORDS - 1))
    assert validate_paper_input(TITLE, "word " * MIN_ABSTRACT_WORDS) == []
    assert validate_paper_input("  " + TITLE + "  ", ABSTRACT) == []


@pytest.mark.parametrize(
    "excerpt",
    [
        "classroom exercise about reading summaries",
        "CLASSROOM EXERCISE ABOUT READING SUMMARIES",
        "  classroom\t exercise\nabout   reading\u00a0summaries  ",
        "ABSTRACT. IT DESCRIBES",
    ],
)
def test_source_matching_ignores_case_and_whitespace_only(excerpt):
    assert excerpt_matches(ABSTRACT, excerpt)


@pytest.mark.parametrize(
    "excerpt",
    [None, "", " \t\n", 42, [], {}, "a finding not in the text", "abstract! It describes"],
)
def test_absent_malformed_or_unmatched_excerpts_do_not_match(excerpt):
    assert excerpt_matches(ABSTRACT, excerpt) is False


@pytest.mark.parametrize("abstract", [None, "", "  ", 42, [], {}])
def test_source_matching_safely_handles_invalid_abstract(abstract):
    assert excerpt_matches(abstract, "example") is False


def test_fixed_prompts_cover_four_reading_tasks_with_hints():
    assert [prompt.id for prompt in REFLECTION_PROMPTS] == [
        "research_problem", "approach", "finding", "limitation"
    ]
    assert all(prompt.question and prompt.hint for prompt in REFLECTION_PROMPTS)


def test_initial_screen_and_validation_block_loading():
    app = _new_app()
    assert app.title[0].value == "Guided Research Paper Reading"
    assert len(app.text_input) == 1
    assert len(app.text_area) == 1
    assert not app.expander
    _button(app, "Start Reading").click().run()
    assert not app.exception
    assert len(app.error) == 2
    assert app.session_state["paper_reader"]["paper"] is None

    app.text_input[0].set_value(TITLE)
    app.text_area[0].set_value("A very short abstract.")
    _button(app, "Start Reading").click().run()
    assert not app.exception
    assert "at least 20" in app.error[0].value
    assert app.session_state["paper_reader"]["paper"] is None
    assert app.text_input[0].value == TITLE
    assert app.text_area[0].value == "A very short abstract."


def test_loading_preserves_original_abstract_and_never_invents_answers_or_scores():
    app = _load_paper(_new_app())
    paper = app.session_state["paper_reader"]["paper"]
    assert paper.title == TITLE
    assert paper.abstract == ABSTRACT
    # Streamlit trims outer display whitespace; the stored source stays exact.
    assert ABSTRACT.strip() in [text.value for text in app.text]
    assert len(app.text_area) == 8
    assert len(app.checkbox) == 4
    assert all(not widget.value for widget in app.text_area)
    assert all(not checkbox.value for checkbox in app.checkbox)
    assert not app.metric
    assert not app.success
    assert not app.expander
    assert any("No AI is used" in caption.value for caption in app.caption)
    assert any("not proof" in caption.value for caption in app.caption)
    assert all(
        not item.value.startswith(("Score:", "Familiarity level:"))
        for item in app.markdown
    )

    app.run()
    assert not app.exception
    assert app.session_state["paper_reader"]["paper"] == paper
    assert all(not widget.value for widget in app.text_area)


def test_saving_reflections_and_source_checks_persist_on_rerun():
    app = _load_paper(_new_app())
    answer = "My own tentative interpretation, without a grade."
    evidence = "CLASSROOM\n exercise about  reading summaries"
    _widget(app, "research_problem", "answer").set_value(answer)
    _widget(app, "research_problem", "excerpt").set_value(evidence)
    _widget(app, "approach", "excerpt").set_value("This phrase does not occur.")
    _widget(app, "limitation", "not_stated").check().run()
    assert not app.exception
    _button(app, "Save Reflections").click().run()

    assert not app.exception
    assert app.success[0].value == "Reflections saved for this session."
    saved = deepcopy(app.session_state["paper_reader"]["saved_reflections"])
    assert saved["research_problem"]["answer"] == answer
    assert saved["research_problem"]["excerpt"] == evidence
    assert saved["limitation"]["not_stated"] is True
    assert [card.label for card in app.expander] == [
        prompt.title for prompt in REFLECTION_PROMPTS
    ]
    assert app.expander[0].text[0].value == answer
    assert app.expander[0].text[1].value == evidence
    assert "excerpt found" in app.expander[0].caption[0].value
    assert "excerpt not found" in app.expander[1].caption[0].value
    assert app.expander[2].text[0].value == "Not answered yet"
    assert app.expander[3].markdown[0].value == "Not stated in the abstract"
    assert not app.metric

    app.run()
    assert not app.exception
    assert app.session_state["paper_reader"]["saved_reflections"] == saved
    assert _widget(app, "research_problem", "answer").value == answer
    assert _widget(app, "research_problem", "excerpt").value == evidence
    assert app.success[0].value == "Reflections saved for this session."


def test_editing_a_saved_response_keeps_draft_and_previous_review_until_resaved():
    app = _load_paper(_new_app())
    _widget(app, "finding", "answer").set_value("First draft").run()
    _button(app, "Save Reflections").click().run()
    _widget(app, "finding", "answer").set_value("Revised draft").run()

    assert not app.exception
    state = app.session_state["paper_reader"]
    assert state["draft"]["finding"]["answer"] == "Revised draft"
    assert state["saved_reflections"]["finding"]["answer"] == "First draft"
    assert not app.success
    assert "Unsaved changes" in app.info[0].value
    assert app.expander[2].text[0].value == "First draft"
    app.run()
    assert not app.exception
    assert _widget(app, "finding", "answer").value == "Revised draft"
    assert app.expander[2].text[0].value == "First draft"

    _button(app, "Save Reflections").click().run()
    assert not app.exception
    assert app.expander[2].text[0].value == "Revised draft"
    assert app.success[0].value == "Reflections saved for this session."


def test_not_stated_is_available_for_every_prompt_without_erasing_typed_text():
    app = _load_paper(_new_app())
    _widget(app, "approach", "answer").set_value("An unfinished thought").run()
    _widget(app, "approach", "excerpt").set_value("classroom exercise").run()
    for checkbox in app.checkbox:
        checkbox.check()
    app.run()
    assert not app.exception
    assert all(area.disabled for area in app.text_area)
    _button(app, "Save Reflections").click().run()
    assert not app.exception
    assert all(
        card.markdown[0].value == "Not stated in the abstract"
        for card in app.expander
    )

    _widget(app, "approach", "not_stated").uncheck().run()
    assert not app.exception
    assert _widget(app, "approach", "answer").value == "An unfinished thought"
    assert _widget(app, "approach", "excerpt").value == "classroom exercise"
    assert not _widget(app, "approach", "answer").disabled


def test_explicit_reset_clears_only_reader_and_allows_a_new_paper():
    app = _load_paper(_new_app())
    _widget(app, "approach", "answer").set_value("Old draft").run()
    _button(app, "Save Reflections").click().run()
    app.session_state["unrelated_feature"] = "preserve me"
    _button(app, "Start Another Paper / Reset").click().run()

    assert not app.exception
    assert app.session_state["unrelated_feature"] == "preserve me"
    assert app.session_state["paper_reader"]["paper"] is None
    assert app.session_state["paper_reader"]["saved_reflections"] is None
    assert app.text_input[0].value == ""
    assert app.text_area[0].value == ""
    assert not app.expander
    assert not app.success

    _load_paper(app, title="Another supplied paper")
    assert app.session_state["paper_reader"]["paper"].title == "Another supplied paper"
    assert all(area.value == "" for area in app.text_area)
    assert app.session_state["paper_reader"]["saved_reflections"] is None


def test_imported_renderer_and_app_navigation_preserve_existing_flows():
    imported = AppTest.from_string(
        "from screens.paper_reader import render_paper_reader\nrender_paper_reader()"
    ).run(timeout=15)
    assert not imported.exception
    assert imported.title[0].value == "Guided Research Paper Reading"

    app = AppTest.from_file(str(ROOT / "app.py")).run(timeout=15)
    assert not app.exception
    assert [tab.label for tab in app.tabs] == [
        "Home", "Knowledge Check", "Guided Paper Reading"
    ]
    assert app.title[0].value == "ResearchBridge AI"
    assert len(app.radio) == 3
    app.radio[0].set_value("I don't know").run()
    _load_paper(app)
    assert app.radio[0].value == "I don't know"
    _widget(app, "research_problem", "answer").set_value("Keep this reflection").run()
    _button(app, "Save Reflections").click().run()
    saved = deepcopy(app.session_state["paper_reader"]["saved_reflections"])

    app.selectbox[0].select("Internet of Things (IoT)").run()
    assert not app.exception
    assert app.session_state["paper_reader"]["saved_reflections"] == saved
    assert _widget(app, "research_problem", "answer").value == "Keep this reflection"
    _button(app, "Skip assessment").click().run()
    assert not app.exception
    assert app.session_state["knowledge_check_skipped"] is True
    assert app.session_state["paper_reader"]["saved_reflections"] == saved
    _button(app, "Restart assessment").click().run()
    assert not app.exception
    assert len(app.radio) == 3
    assert app.session_state["paper_reader"]["saved_reflections"] == saved
