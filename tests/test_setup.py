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
    """The permanent icon rail can hide and reopen its navigation panel."""
    app_path = Path(__file__).resolve().parents[1] / "app.py"
    app = AppTest.from_file(str(app_path)).run(timeout=15)

    assert not app.exception
    assert app.button(key='rail_Question')
    assert not any(button.key=='nav_close' for button in app.button)
    assert app.text_area[0].proto.placeholder == "wondering that…"
    app.button(key='rail_Vault').click().run()
    assert app.button(key='nav_close')
    app.button(key='nav_close').click().run()
    assert app.button(key='rail_Question')
    assert not any(button.key=='nav_close' for button in app.button)
    app.button(key='rail_Vault').click().run()
    assert app.button(key='nav_close')
    assert not any(b.key=='saved_Learning and memory' for b in app.button)
    app.button(key='rail_Settings').click().run()
    assert any(b.key=='saved_Learning and memory' for b in app.button)
    app.button(key='rail_Vault').click().run()
    assert not any(b.key=='saved_Learning and memory' for b in app.button)
    assert app.session_state['nav_panel_step']=='Vault'
    assert not app.exception
