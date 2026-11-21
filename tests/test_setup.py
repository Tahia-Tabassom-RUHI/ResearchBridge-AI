"""Smoke tests for the starter environment and minimal Streamlit app."""

from importlib import import_module
from pathlib import Path

from streamlit.testing.v1 import AppTest


def test_starter_modules_import():
    """Future module foundations should import without configuration or keys."""
    for module in (
        "components",
        "screens",
        "services.papers",
        "services.ranking",
        "services.teach",
        "models.schemas",
    ):
        import_module(module)


def test_starter_app_runs():
    """Students can read the navigation labels and open Sources before searching."""
    app_path = Path(__file__).resolve().parents[1] / "app.py"
    app = AppTest.from_file(str(app_path)).run(timeout=15)

    assert not app.exception
    assert [button.label for button in app.sidebar.button]==[
        'Discover','My Library','All Papers','To Read','+ New Folder',
        'Guided Reading','Learning Assistant','Notes','Workspace','Sources','Settings',
    ]
    assert app.text_input(key='question').proto.placeholder == "wondering that…"
    assert not any(b.key == 'rail_Papers' for b in app.button)
    assert not app.button(key='rail_Sources').disabled
    app.button(key='rail_Sources').click().run()
    assert app.header[0].value=='Sources & transparency'
    assert any('Search for papers' in prompt.value for prompt in app.info)
    app.button(key='rail_Settings').click().run()
    assert app.button(key='nav_close').label=='Close settings'
    assert any(b.key=='saved_Learning and memory' for b in app.button)
    app.button(key='nav_close').click().run()
    assert not any(button.key=='nav_close' for button in app.button)
    app.button(key='rail_My Library').click().run()
    assert app.header[0].value=='All Papers'
    assert not app.exception


def test_workspaces_open_and_switch_saved_papers_without_losing_reflections(monkeypatch):
    monkeypatch.setattr("screens.home.coach_configs", lambda: [])
    monkeypatch.setattr("screens.home.secret", lambda name, default="": default)
    app_path = Path(__file__).resolve().parents[1] / "app.py"
    app = AppTest.from_file(str(app_path)).run(timeout=15)

    def click(label):
        next(button for button in app.button if button.label == label).click().run()
        assert not app.exception

    assert app.sidebar.button(key="rail_workspace").label == "Workspace"
    app.sidebar.button(key="rail_workspace").click().run()
    assert app.header[0].value == "My Workspaces"
    assert any("Save a paper" in info.value for info in app.info)

    abstract = ("This classroom exercise asks students to identify a research problem, "
                "read the evidence, and discuss what the abstract leaves out.")
    first = {"id": "workshop", "title": "Reading workshop", "abstract": abstract,
             "authors": ["Sample Author"], "source_name": "Sample Journal"}
    second = {"id": "seminar", "title": "Evidence seminar", "abstract": abstract}
    papers = {paper["id"]: paper for paper in (first, second)}
    app.session_state["saved_papers"] = papers
    app.session_state["reading_status"] = {first["id"]: "Reading"}
    app.run()
    assert {paper["title"] for paper in papers.values()} <= {item.value for item in app.subheader}
    assert "Sample Author · Sample Journal" in [item.value for item in app.caption]
    assert "Reading" in [item.value for item in app.caption]
    assert len([button for button in app.button if button.label == "Open Workspace"]) == 2

    click("+ Add Paper")
    app.text_input(key="workspace_query").set_value("sample author").run()
    assert app.button(key="workspace_pick_workshop").label == "Open Paper Workspace"
    assert not any(b.key == "workspace_pick_seminar" for b in app.button)
    app.button(key="workspace_pick_workshop").click().run()
    assert app.session_state["reader_id"] == first["id"]
    assert app.session_state["ui_step"] == "Read paper"
    assert {"Workspace", "Abstract", "Read & Learn", "Source details", "Original page"} == {
        tab.label for tab in app.tabs
    }
    answer = "_paper_reader_research_problem_answer"
    click("Guided Reading & Reflections")
    app.text_area(key=answer).set_value("Workshop reflection").run()
    click("← Back to paper")

    click("+ Add Paper")
    app.button(key="workspace_pick_seminar").click().run()
    assert app.session_state["reader_id"] == second["id"]
    click("Guided Reading & Reflections")
    assert app.text_area(key=answer).value == ""
    app.text_area(key=answer).set_value("Seminar reflection").run()
    click("← Back to paper")
    click("← Back to Workspaces")
    assert app.header[0].value == "My Workspaces"
    app.button(key="workspace_open_workshop").click().run()
    click("Guided Reading & Reflections")
    assert app.text_area(key=answer).value == "Workshop reflection"

    app.sidebar.button(key="rail_Question").click().run()
    assert app.header[0].value == "Discover Papers"
    app.sidebar.button(key="rail_My Library").click().run()
    assert app.header[0].value == "All Papers"
    app.sidebar.button(key="rail_workspace").click().run()
    app.button(key="workspace_open_seminar").click().run()
    click("Guided Reading & Reflections")
    assert app.text_area(key=answer).value == "Seminar reflection"
    assert app.session_state["saved_papers"] == papers
