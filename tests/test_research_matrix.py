import csv
from io import StringIO
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from services import research_matrix
from services.research_matrix import FIELDS
from services.vault_store import load_vault, new_token, save_vault


APP = Path(__file__).resolve().parents[1] / "app.py"
LABELS = [
    "Paper Title", "Authors", "Publication Year", "Paper URL / DOI",
    "Research Problem", "Dataset / Data Used", "Methodology", "Key Results / Findings",
    "Evaluation Metrics", "Limitations", "My Observations", "Authors' Research Question",
    "Full Citation", "Evidence Location / Supporting Excerpt",
]


def button(app, label):
    return next(button for button in app.button if button.label == label)


def open_notes(token):
    app = AppTest.from_file(str(APP))
    app.query_params["vault"] = token
    app.run().sidebar.button(key="rail_notes").click().run()
    assert app.session_state.ui_step == "Notes"
    assert not app.exception
    return app


def open_matrix(token):
    app = open_notes(token)
    return app.radio(key="notes_section").set_value("Research Matrix").run()


@pytest.fixture
def vault():
    token = new_token()
    papers = {
        f"paper-{i}": {"id": f"paper-{i}", "title": f"Field study {i:02}"}
        for i in range(12)
    }
    papers["paper-0"].update(authors=["A. Lim", "B. Lee"], publication_date="2024-06",
                             paper_url="https://example.org/paper", citation="Lim and Lee (2024).")
    papers["paper-1"].update(title=papers["paper-0"]["title"], doi="10.1234/field")
    data = {"saved_papers": papers, "reading_status": {"paper-0": "Reading"}}
    assert save_vault(token, data)
    return token, data


def test_single_paper_prefills_available_metadata_and_round_trips_all_fields(vault):
    token, original = vault
    app = open_matrix(token)
    app.selectbox(key="matrix_single_paper").set_value("paper-0").run()
    assert [area.label for area in app.text_area] == LABELS
    assert [area.value for area in app.text_area] == [
        "Field study 00", "A. Lim, B. Lee", "2024", "https://example.org/paper",
        "", "", "", "", "", "", "", "", "Lim and Lee (2024).", "",
    ]
    values = [f"Student entry {i}\nSecond line" for i in range(len(LABELS))]
    values[1] = ""
    for area, value in zip(app.text_area, values):
        area.set_value(value)
    button(app, "Save Research Matrix").click().run()
    assert app.success[0].value == "Research matrix saved."
    assert load_vault(token) == {**original, "research_matrices": {"paper-0": dict(zip(FIELDS, values))}}

    reopened = open_matrix(token)
    reopened.selectbox(key="matrix_single_paper").set_value("paper-0").run()
    assert [area.value for area in reopened.text_area] == values
    reopened.selectbox(key="matrix_single_paper").set_value("paper-1").run()
    assert [area.value for area in reopened.text_area[:4]] == ["Field study 00", "", "", "10.1234/field"]


@pytest.mark.parametrize("count", [2, 12])
def test_comparison_edits_write_to_the_same_independent_paper_entries(vault, count):
    token, original = vault
    app = open_matrix(token)
    app.radio(key="matrix_view").set_value("Compare Papers").run()
    ids = list(original["saved_papers"])[:count]
    app.multiselect(key="matrix_paper_selection").set_value(ids).run()
    assert not app.text_area
    button(app, "Compare Selected Papers").click().run()
    assert len(app.text_area) == count * len(LABELS)
    assert [row.value for row in app.text][count + 1:] == LABELS

    app.text_area(key=f"matrix_compare_{ids[0]}_findings").set_value("First result")
    app.text_area(key=f"matrix_compare_{ids[-1]}_findings").set_value("Last result")
    button(app, "Save Comparison Edits").click().run()
    assert app.success[0].value == "Research matrix saved."
    stored = load_vault(token)
    assert stored["saved_papers"] == original["saved_papers"]
    assert set(stored["research_matrices"]) == {ids[0], ids[-1]}

    app.radio(key="matrix_view").set_value("Single Paper").run()
    for paper_id, expected in ((ids[0], "First result"), (ids[-1], "Last result")):
        app.selectbox(key="matrix_single_paper").set_value(paper_id).run()
        assert app.text_area(key=f"matrix_single_{paper_id}_findings").value == expected


def test_my_notes_still_opens_the_existing_note_board(vault):
    token, _ = vault
    app = open_notes(token)
    assert app.radio(key="notes_section").value == "My Notes"
    button(app, "Choose Paper from Library").click().run()
    app.button(key="workspace_pick_paper-0").click().run()
    assert any("Linked notes" in frame.proto.srcdoc for frame in app.get("iframe"))
    app.radio(key="notes_section").set_value("Research Matrix").run()
    app.radio(key="notes_section").set_value("My Notes").run()
    assert any("Linked notes" in frame.proto.srcdoc for frame in app.get("iframe"))


def test_failed_save_shows_error_and_keeps_draft(vault, monkeypatch):
    token, original = vault
    app = open_matrix(token)
    app.selectbox(key="matrix_single_paper").set_value("paper-0").run()
    app.text_area(key="matrix_single_paper-0_problem").set_value("Draft problem")
    with monkeypatch.context() as failure:
        failure.setattr("services.vault_store.MAX_VAULT_SIZE", 1)
        button(app, "Save Research Matrix").click().run()
    assert any("storage limit reached" in error.value for error in app.error)
    assert app.text_area(key="matrix_single_paper-0_problem").value == "Draft problem"
    assert load_vault(token) == original
    button(app, "Save Research Matrix").click().run()
    assert app.success[0].value == "Research matrix saved."
    assert not app.error
    assert load_vault(token)["research_matrices"]["paper-0"]["problem"] == "Draft problem"


def open_comparisons(token):
    return open_matrix(token).radio(key="matrix_view").set_value("Compare Papers").run()


def select_papers(app, paper_ids):
    app.multiselect(key="matrix_paper_selection").set_value(paper_ids).run()
    return button(app, "Compare Selected Papers").click().run()


def save_comparison(app, name=None):
    if name is not None:
        app.text_input(key="matrix_comparison_name").set_value(name)
    return button(app, "Save Comparison").click().run()


def reopen_comparison(app, comparison_id):
    app.selectbox(key="matrix_saved_comparison").set_value(comparison_id).run()
    return button(app, "Open Comparison").click().run()


def column_keys(app):
    return [area.key for area in app.text_area if area.key.endswith("_title")]


def move(app, paper_id, direction):
    return app.button(key=f"matrix_{direction}_{paper_id}").click().run()


def test_named_comparison_reopens_stage_one_data_and_saves_rename_and_membership(vault):
    token, original = vault
    stage_one = {**original, "research_matrices": {"paper-0": {"findings": "Stage 1 result"}}}
    assert save_vault(token, stage_one)
    app = select_papers(open_comparisons(token), ["paper-2", "paper-0"])
    save_comparison(app, "Literature Review")
    assert app.success[0].value == "Comparison saved."
    (comparison_id, saved), = load_vault(token)["research_comparisons"].items()
    assert saved["name"] == "Literature Review"
    assert saved["paper_ids"] == ["paper-2", "paper-0"]
    assert saved["created_at"] == saved["updated_at"]
    assert load_vault(token) == {**stage_one, "research_comparisons": {comparison_id: saved}}

    reopened = reopen_comparison(open_comparisons(token), comparison_id)
    assert reopened.text_input(key="matrix_comparison_name").value == "Literature Review"
    assert reopened.multiselect(key="matrix_paper_selection").value == ["paper-2", "paper-0"]
    assert reopened.text_area(key="matrix_compare_paper-0_findings").value == "Stage 1 result"
    reopened.multiselect(key="matrix_paper_selection").set_value(["paper-0", "paper-3"]).run()
    save_comparison(reopened, "Updated Review")
    updated = load_vault(token)["research_comparisons"][comparison_id]
    assert updated["name"] == "Updated Review"
    assert updated["paper_ids"] == ["paper-0", "paper-3"]
    assert updated["created_at"] == saved["created_at"]
    assert updated["updated_at"] >= saved["updated_at"]
    assert column_keys(reopened) == ["matrix_compare_paper-0_title", "matrix_compare_paper-3_title"]


def test_reordering_twelve_columns_and_reopening_preserves_papers_and_order(vault):
    token, original = vault
    ids = list(original["saved_papers"])
    app = select_papers(open_comparisons(token), ids)
    move(app, "paper-0", "right")
    move(app, "paper-11", "left")
    expected = [ids[1], ids[0], *ids[2:10], ids[11], ids[10]]
    assert column_keys(app) == [f"matrix_compare_{paper_id}_title" for paper_id in expected]
    save_comparison(app, "Ordered Research")
    (comparison_id, saved), = load_vault(token)["research_comparisons"].items()
    assert saved["paper_ids"] == expected
    reopened = reopen_comparison(open_comparisons(token), comparison_id)
    assert reopened.multiselect(key="matrix_paper_selection").value == expected
    assert column_keys(reopened) == column_keys(app)


def test_quick_comparison_keeps_unsaved_edits_identity_and_selection(vault):
    token, _ = vault
    ids = ["paper-0", "paper-2"]
    app = select_papers(open_comparisons(token), ids)
    save_comparison(app, "Revision")
    app.text_area(key="matrix_compare_paper-0_authors").set_value("Full-only draft")
    app.text_area(key="matrix_compare_paper-0_findings").set_value("Draft finding")
    button(app, "Quick Comparison").click().run()
    assert [area.label.split(" · ")[0] for area in app.text_area[::2]] == [
        "Paper Title", "Research Problem", "Methodology", "Key Results / Findings", "Limitations", "My Observations",
    ]
    assert app.text_area(key="matrix_compare_paper-0_findings").value == "Draft finding"
    assert app.multiselect(key="matrix_paper_selection").value == ids
    assert app.text_input(key="matrix_comparison_name").value == "Revision"
    assert "research_matrices" not in load_vault(token)

    app.text_area(key="matrix_compare_paper-2_observations").set_value("Quick draft")
    button(app, "Full Matrix").click().run()
    assert len(app.text_area) == 28
    assert app.text_area(key="matrix_compare_paper-0_authors").value == "Full-only draft"
    assert app.text_area(key="matrix_compare_paper-2_observations").value == "Quick draft"
    button(app, "Quick Comparison").click().run()
    button(app, "Save Comparison Edits").click().run()
    stored = load_vault(token)["research_matrices"]
    assert stored["paper-0"]["authors"] == "Full-only draft"
    assert stored["paper-0"]["findings"] == "Draft finding"
    assert stored["paper-2"]["observations"] == "Quick draft"
    assert all(len(entry) == 14 for entry in stored.values())


def test_shared_papers_survive_confirmed_comparison_deletion(vault):
    token, original = vault
    original = {**original, "research_matrices": {"paper-0": {"observations": "Shared observation"}}}
    assert save_vault(token, original)
    app = select_papers(open_comparisons(token), ["paper-0", "paper-1"])
    save_comparison(app, "First Review")
    button(app, "New Comparison").click().run()
    assert not app.multiselect(key="matrix_paper_selection").value
    select_papers(app, ["paper-2", "paper-0"])
    save_comparison(app, "Second Review")
    stored = load_vault(token)["research_comparisons"]
    first_id, second_id = stored
    assert all("paper-0" in comparison["paper_ids"] for comparison in stored.values())
    reopen_comparison(app, first_id)
    assert app.text_area(key="matrix_compare_paper-0_observations").value == "Shared observation"
    assert load_vault(token)["research_comparisons"] == stored
    button(app, "Confirm Deletion").click().run()
    assert app.success[0].value == "Comparison deleted."
    assert load_vault(token) == {**original, "research_comparisons": {second_id: stored[second_id]}}
    reopen_comparison(app, second_id)
    assert app.text_area(key="matrix_compare_paper-0_observations").value == "Shared observation"


@pytest.fixture
def exported_csv(monkeypatch):
    exports = []
    encode = research_matrix.comparison_csv

    def capture(*args):
        data = encode(*args)
        assert data.startswith(b"\xef\xbb\xbf")
        exports.append(list(csv.reader(StringIO(data.decode("utf-8-sig"), newline=""))))
        return data

    monkeypatch.setattr(research_matrix, "comparison_csv", capture)
    return exports


def test_csv_exports_all_fields_in_displayed_order_without_writing_to_vault(vault, exported_csv):
    token, original = vault
    ids = list(original["saved_papers"])
    entries = {
        "paper-0": {"title": "Étude", "findings": '森林, "quoted"\nRésumé', "limitations": ""},
        "paper-1": {"title": "Étude"},
        "paper-2": {"title": "Étude (2)"},
        "paper-3": {"title": "=2+2", "problem": "  +SUM(2,3)", "observations": "＝20"},
        "paper-4": {"title": "", "metrics": "\t-1", "methodology": "\ufeff@SUM(A1)"},
    }
    comparisons = {"saved-id": {"name": "Twelve studies", "paper_ids": ids}}
    saved = {**original, "research_matrices": entries, "research_comparisons": comparisons}
    assert save_vault(token, saved)
    app = reopen_comparison(open_comparisons(token), "saved-id")
    move(app, "paper-0", "right")
    button(app, "Quick Comparison").click().run()
    assert len(app.text_area) == 6 * len(ids)
    assert [item.proto.label for item in app.get("download_button")] == ["Export CSV"]

    header, *rows = exported_csv[-1]
    assert header[:6] == ["Research field", "Étude", "Étude (3)", "Étude (2)", "'=2+2", "Field study 04"]
    assert header[6:] == [f"Field study {i:02}" for i in range(5, 12)]
    assert len(set(header)) == 13
    assert [row[0] for row in rows] == LABELS
    assert all(len(row) == 13 for row in rows)
    values = {row[0]: row[1:] for row in rows}
    assert values["Paper Title"][:5] == ["Étude", "Étude", "Étude (2)", "'=2+2", ""]
    assert values["Key Results / Findings"][:2] == ["", '森林, "quoted"\nRésumé']
    assert values["Limitations"] == [""] * 12
    assert values["Research Problem"][3] == "'  +SUM(2,3)"
    assert values["My Observations"][3] == "'＝20"
    assert values["Evaluation Metrics"][4] == "'\t-1"
    assert values["Methodology"][4] == "'\ufeff@SUM(A1)"
    assert load_vault(token) == saved


@pytest.mark.parametrize("value", ["@SUM(A1)", "-1+1", "\rplain", "\n=1", "\u200b\t+12", "＠SUM(A1)"])
def test_csv_escapes_spreadsheet_formula_prefixes(value):
    assert research_matrix.spreadsheet_text(value) == "'" + value


def test_drafts_survive_paper_and_view_switches_and_export_uses_saved_values(vault, exported_csv):
    token, _ = vault
    app = select_papers(open_comparisons(token), ["paper-0", "paper-2"])
    assert not app.warning
    app.text_area(key="matrix_compare_paper-0_findings").set_value("Pending finding").run()
    assert any("Unsaved matrix edits" in message.value for message in app.warning)
    assert exported_csv[-1][8][1] == ""

    select_papers(app, ["paper-2"])
    assert app.warning
    app.radio(key="matrix_view").set_value("Single Paper").run()
    app.selectbox(key="matrix_single_paper").set_value("paper-0").run()
    assert app.text_area(key="matrix_single_paper-0_findings").value == "Pending finding"
    app.text_area(key="matrix_single_paper-0_problem").set_value("Single Paper draft")
    app.selectbox(key="matrix_single_paper").set_value("paper-2").run()
    assert app.warning

    app.radio(key="notes_section").set_value("My Notes").run()
    app.radio(key="notes_section").set_value("Research Matrix").run()
    app.radio(key="matrix_view").set_value("Compare Papers").run()
    assert app.warning
    button(app, "Save Comparison Edits").click().run()
    assert app.success[0].value == "Research matrix saved."
    assert not app.warning
    assert load_vault(token)["research_matrices"]["paper-0"]["problem"] == "Single Paper draft"
    select_papers(app, ["paper-0", "paper-2"])
    assert exported_csv[-1][8][2] == "Pending finding"


def test_reverting_a_cell_to_its_saved_value_clears_unsaved_indicator(vault):
    token, _ = vault
    app = select_papers(open_comparisons(token), ["paper-0"])
    key = "matrix_compare_paper-0_findings"
    app.text_area(key=key).set_value("Draft").run()
    assert app.warning
    app.text_area(key=key).set_value("").run()
    assert not app.warning
    assert "research_matrices" not in load_vault(token)
