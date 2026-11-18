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
        'Research question','Search topics','Paper results','Vault · Study sets',
        'Sources & transparency','Settings',
    ]
    assert app.text_input(key='question').proto.placeholder == "wondering that…"
    assert app.button(key='rail_Papers').disabled
    assert not app.button(key='rail_Sources').disabled
    app.button(key='rail_Sources').click().run()
    assert app.header[0].value=='Sources & transparency'
    assert any('Search for papers' in prompt.value for prompt in app.info)
    app.button(key='rail_Settings').click().run()
    assert app.button(key='nav_close').label=='Close settings'
    assert any(b.key=='saved_Learning and memory' for b in app.button)
    app.button(key='nav_close').click().run()
    assert not any(button.key=='nav_close' for button in app.button)
    app.button(key='rail_Vault').click().run()
    assert app.header[0].value=='Vault'
    assert not app.exception
