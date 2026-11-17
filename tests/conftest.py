"""Keep UI tests offline; live preview retrieval is tested through its signals."""
import pytest


@pytest.fixture(autouse=True)
def offline_topic_preview(monkeypatch,tmp_path):
    monkeypatch.setattr('screens.home.preview_topic_sample',lambda question,plan: [])
    monkeypatch.setattr('screens.home.retrieve_background',lambda query: [])
    monkeypatch.setenv('RB_VAULT_DB',str(tmp_path/'vault.sqlite3'))
