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
    """Execute the actual app and check its title and development notice."""
    app_path = Path(__file__).resolve().parents[1] / "app.py"
    app = AppTest.from_file(str(app_path)).run(timeout=15)

    assert not app.exception
    assert app.title[0].value == "ResearchBridge AI"
    assert app.markdown[0].value
    assert app.info[0].value == "Development is currently in progress."
