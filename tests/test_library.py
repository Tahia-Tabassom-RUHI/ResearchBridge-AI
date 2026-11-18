"""Offline application tests for the Library and its existing Vault storage."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from streamlit.testing.v1 import AppTest

from services.papers import normalize
from services.vault_store import load_vault, new_token, save_vault


APP = Path(__file__).resolve().parents[1] / "app.py"
ABSTRACT = (
    "This fixture describes a classroom exercise in reading study summaries. "
    "Students identify the problem, compare possible approaches, and discuss "
    "whether a conclusion is supported by the text."
)


@pytest.fixture(autouse=True)
def offline_library(monkeypatch):
    blocked = Mock(side_effect=AssertionError("Live services are disabled for Library tests"))
    monkeypatch.setattr("screens.home.secret", lambda name, default="": default)
    monkeypatch.setattr("screens.home.interpret_question", blocked)
    monkeypatch.setattr("screens.home.generate_explanations", blocked)
    monkeypatch.setattr("screens.home.explain_abstract", blocked)
    monkeypatch.setattr("screens.home.retrieve", blocked)
    yield
    blocked.assert_not_called()


def _app(token=None):
    app = AppTest.from_file(str(APP), default_timeout=15)
    if token:
        app.query_params["vault"] = token
    return app.run()


def _button(app, label):
    return next(button for button in app.button if button.label == label)


def _paper(number, title):
    return {
        **normalize({
            "id": f"https://openalex.org/W{number}",
            "title": title,
            "authorships": [{"author": {"display_name": "Fixture Author"}}],
            "publication_date": "2020-01-01",
            "primary_location": {
                "source": {"display_name": "Fixture Journal"},
                "landing_page_url": f"https://example.test/paper/{number}",
            },
        }),
        "abstract": ABSTRACT,
    }


def _open_library(app):
    app.sidebar.button(key="rail_My Library").click().run()
    assert not app.exception
    assert app.header[0].value == "All Papers"


def _listed(app):
    return [
        button.label for button in app.button
        if (button.key or "").startswith("paper_")
    ]


def _assert_source_preview(app, original_url, free_text_url):
    assert not app.exception
    assert free_text_url in [frame.proto.src for frame in app.get("iframe")]
    links = {link.proto.label: link.proto.url for link in app.get("link_button")}
    assert links["Open original in a new tab ↗"] == free_text_url
    assert links["Original source ↗"] == original_url
    assert links["Free text ↗"] == free_text_url
    assert any("publishers block embedded previews" in item.value for item in app.caption)


def test_library_is_available_before_search_and_empty_views_link_to_discovery():
    app = _app()
    assert not app.sidebar.button(key="rail_My Library").disabled
    _open_library(app)
    assert any("Save papers from Discovery" in item.value for item in app.info)
    app.button(key="nav_to_read").click().run()
    assert app.header[0].value == "To Read"
    _button(app, "Browse All Papers").click().run()
    app.button(key="library_discover").click().run()
    assert app.header[0].value == "Discover Papers"
    assert not app.exception


def test_vault_catalog_and_study_set_memberships_drive_library_views():
    loose, unfiled, filed, shared, legacy, result = (
        _paper(i, title) for i, title in enumerate(
            ["Loose list", "Saved directly", "Filed only", "Saved in both",
             "Legacy study member", "Unsaved result"], 1
        )
    )
    token = new_token()
    data = {
        "active_combo_id": 0,
        "saved_papers": {paper["id"]: paper for paper in (loose, unfiled, filed, shared)},
        "loose_reading_ids": [loose["id"], shared["id"]],
        "saved_combos": [
            {"name": "First study set", "papers": [legacy, result],
             "reading_ids": [filed["id"], shared["id"], legacy["id"]]},
            {"name": "Second study set", "reading_ids": [shared["id"]]},
            {"name": "Empty study set", "reading_ids": []},
        ],
    }
    assert save_vault(token, data)
    app = _app(token)
    _open_library(app)
    assert _listed(app) == [
        "Loose list", "Saved directly", "Filed only", "Saved in both", "Legacy study member",
    ]
    assert any("Fixture Journal" in item.value for item in app.caption)
    assert any(item.value == "Fixture Author" for item in app.text)
    app.checkbox(key="library_unassigned").check().run()
    assert len(_listed(app)) == 5
    app.session_state["papers"] = [{**shared, "title": "Different search metadata"}]
    _button(app, shared["title"]).click().run()
    app.button(key="workspace_open").click().run()
    assert app.session_state["reading_catalog"][shared["id"]] == shared
    assert app.session_state["active_combo_id"] == 0
    assert any(item.value == shared["title"] for item in app.subheader)
    _button(app, "← Back to My Library").click().run()
    assert load_vault(token) == data
    assert not app.exception


def test_discovery_save_can_be_reopened_and_read_in_new_session(monkeypatch):
    paper = _paper(10, "Classroom reading exercise")
    paper["oa_url"] = "https://example.test/paper/10/full-text"
    monkeypatch.setattr("screens.home.retrieve", lambda *args: [paper])
    first = _app()
    first.text_input(key="question").input("classroom reading exercise").run()
    _button(first, "Turn into search").click().run()
    _button(first, "Find real papers →").click().run()
    first.button(key="reading_add_0").click().run()
    token = first.session_state["vault_id"]
    stored = load_vault(token)
    assert stored["saved_papers"][paper["id"]] == paper
    assert stored["loose_reading_ids"] == [paper["id"]]
    first.button(key="reading_add_0_organize").click().run()
    assert first.session_state["library_selection"] == [paper["id"]]
    assert first.selectbox(key="status_" + paper["id"]).value == "To Read"
    first.sidebar.button(key="rail_Question").click().run()
    first.button(key="rail_Papers").click().run()
    first.button(key="reading_preview_0").click().run()
    _button(first, "Open reading mode ⤢").click().run()
    _assert_source_preview(first, paper["paper_url"], paper["oa_url"])
    assert any(p.proto.popover.label == "Saved to Library" for p in first.get("popover"))
    _button(first, "← Back to papers").click().run()
    assert first.session_state["ui_step"] == "Papers"

    second = _app(token)
    assert "papers" not in second.session_state
    _open_library(second)
    assert _listed(second) == [paper["title"]]
    second.button(key="workspace_open").click().run()
    assert second.session_state["reader_id"] == paper["id"]
    assert any(item.value == paper["title"] for item in second.subheader)
    _assert_source_preview(second, paper["paper_url"], paper["oa_url"])

    second.button(key=f"learn_{paper['id']}").click().run()
    assert second.session_state["paper_reader"]["paper"].id == paper["id"]
    answer_key = "_paper_reader_research_problem_answer"
    second.text_area(key=answer_key).set_value("A session reflection").run()
    _button(second, "Save Reflections").click().run()
    _button(second, "← Back to paper").click().run()
    _button(second, "← Back to My Library").click().run()
    assert _listed(second) == [paper["title"]]
    second.button(key="workspace_open").click().run()
    second.button(key=f"learn_{paper['id']}").click().run()
    assert second.text_area(key=answer_key).value == "A session reflection"
    assert load_vault(token) == stored
    assert not first.exception and not second.exception


def test_saved_paper_with_unusable_sources_has_no_external_actions():
    paper = {
        **_paper(11, "Record without a usable source"),
        "paper_url": "file:///private/paper",
        "oa_url": "javascript:alert(1)",
    }
    token = new_token()
    assert save_vault(token, {"saved_papers": {paper["id"]: paper}})
    app = _app(token)
    _open_library(app)
    app.button(key="workspace_open").click().run()
    assert any("did not provide a usable original-page link" in item.value for item in app.info)
    assert not app.get("link_button")
    assert not any(frame.proto.src for frame in app.get("iframe"))
    assert not app.exception

def test_folder_lifecycle_bulk_selection_status_and_persistence():
    token = new_token()
    papers = [_paper(21, "First paper"), _paper(22, "Second paper")]
    records = {p["id"]: p for p in papers}
    original = {"saved_papers": records, "saved_combos": [], "notes": {"existing": "kept"}}
    assert save_vault(token, original)
    app = _app(token)
    _open_library(app)
    for paper in papers:
        app.checkbox(key="select_" + paper["id"]).check().run()
    app.text_input(key="library_search").set_value("First").run()
    assert set(app.session_state["library_selection"]) == set(records)
    app.text_input(key="library_search").set_value("").run()
    form = app.get("form")
    create = next(f for f in form if f.proto.form.form_id == "bulk_create")
    create.text_input[0].set_value("Methods")
    create.text_area[0].set_value("Research methods")
    create.button[0].click().run()
    assert not app.exception
    folder_id = app.session_state["library_location"]
    saved = load_vault(token)
    assert saved["paper_folders"] == dict.fromkeys(records, folder_id)
    assert saved["folders"][folder_id]["description"] == "Research methods"
    edit = next(f for f in app.get("form") if f.proto.form.form_id == "edit_" + folder_id)
    edit.text_input[0].set_value("Fieldwork")
    edit.text_area[0].set_value("Field notes")
    edit.button[0].click().run()
    assert load_vault(token)["folders"][folder_id] == {"name": "Fieldwork", "description": "Field notes"}
    paper_id = papers[0]["id"]
    app.selectbox(key="status_" + paper_id).select("Finished").run()
    fresh = _app(token)
    fresh.button(key="folder_" + folder_id).click().run()
    assert _listed(fresh) == [p["title"] for p in papers]
    assert fresh.selectbox(key="status_" + paper_id).value == "Finished"
    fresh.button(key="library_guided").click().run()
    assert fresh.session_state["paper_reader"]["paper"].id == paper_id
    _button(fresh, "← Back to paper").click().run()
    _button(fresh, "← Back to My Library").click().run()
    assert fresh.header[0].value == "Fieldwork"
    fresh.checkbox(key="select_" + paper_id).check().run()
    _button(fresh, "Remove from Folder").click().run()
    assert paper_id not in load_vault(token)["paper_folders"]
    fresh.checkbox(key="select_" + paper_id).check().run()
    _button(fresh, "Clear Selection").click().run()
    assert not fresh.session_state["library_selection"]
    fresh.checkbox(key="select_" + paper_id).check().run()
    _button(fresh, "Move papers").click().run()
    assert load_vault(token)["paper_folders"][paper_id] == folder_id
    assert _button(fresh, "Delete folder").disabled
    fresh.checkbox(key="confirm_" + folder_id).check().run()
    _button(fresh, "Delete folder").click().run()
    saved = load_vault(token)
    assert saved["folders"] == saved["paper_folders"] == {}
    assert saved["notes"] == original["notes"]
    assert saved["saved_papers"] == records
    assert saved["reading_status"] == {paper_id: "Finished"}
    fresh.button(key="nav_to_read").click().run()
    assert _listed(fresh) == ["Second paper"]
    assert not fresh.exception


def test_concurrent_folder_edit_keeps_first_write():
    token = new_token()
    first = _app(token)
    second = _app(token)
    for app, name in ((first, "First folder"), (second, "Stale folder")):
        app.button(key="nav_new").click().run()
        app.text_input[0].input(name)
        _button(app, "Create folder").click().run()
    assert any("changed in another session" in e.value for e in second.error)
    assert [f["name"] for f in load_vault(token)["folders"].values()] == ["First folder"]

def test_manual_entry_and_paper_guidance_keep_distinct_drafts():
    paper = _paper(31, "Seminar reading")
    token = new_token()
    assert save_vault(token, {"saved_papers": {paper["id"]: paper}})
    app = _app(token)
    _open_library(app)
    app.button(key="library_guided").click().run()
    assert app.session_state["paper_reader"]["paper"].id == paper["id"]
    answer = "_paper_reader_research_problem_answer"
    app.text_area(key=answer).set_value("Draft for the seminar").run()
    _open_library(app)
    app.button(key="manual_entry").click().run()
    app.text_input(key="_paper_reader_title").set_value("My abstract")
    app.text_area(key="_paper_reader_abstract").set_value(ABSTRACT)
    _button(app, "Start Reading").click().run()
    manual_id = app.session_state["paper_reader"]["paper"].id
    app.text_area(key=answer).set_value("My own draft").run()
    _open_library(app)
    app.button(key="library_guided").click().run()
    assert app.text_area(key=answer).value == "Draft for the seminar"
    _open_library(app)
    app.button(key="manual_entry").click().run()
    assert app.session_state["paper_reader"]["paper"].id == manual_id
    assert app.text_area(key=answer).value == "My own draft"
    assert not app.exception

def test_drop_persists_only_the_dragged_rows_and_rejects_missing_targets():
    first, second = _paper(40, "First"), _paper(41, "Second")
    token = new_token()
    records = {p["id"]: p for p in (first, second)}
    assert save_vault(token, {"saved_papers": records, "folders": {"target": {"name": "Seminar"}}})
    app = AppTest.from_string("""
from components.library_drag import apply_drop
from services.vault_session import initialize_vault
import streamlit as st
initialize_vault()
ids = list(st.session_state.saved_papers)
handles = dict(zip(["row-a", "row-b"], ids))
if st.button("Invalid target"):
    apply_drop({"handle": "row-b", "folder": "deleted"}, handles, ids)
if st.button("Move second"):
    apply_drop({"handle": "row-b", "folder": "target"}, handles, [ids[0]])
if st.button("Move both"):
    apply_drop({"handle": "row-a", "folder": "target"}, handles, ids)
""")
    app.query_params["vault"] = token
    app.run()
    _button(app, "Invalid target").click().run()
    assert not load_vault(token).get("paper_folders")
    _button(app, "Move second").click().run()
    assert load_vault(token)["paper_folders"] == {second["id"]: "target"}
    _button(app, "Move both").click().run()
    assert load_vault(token)["paper_folders"] == dict.fromkeys(records, "target")
    assert load_vault(token)["saved_papers"] == records
    assert not app.exception
