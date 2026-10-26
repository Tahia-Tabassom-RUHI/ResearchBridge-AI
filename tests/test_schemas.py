"""Focused tests for the shared paper schema."""

from dataclasses import asdict

import pytest

from models.schemas import Paper


def test_paper_requires_only_id_and_title():
    paper = Paper(id="paper-1", title="A research paper")

    values = asdict(paper)
    assert values.pop("id") == "paper-1"
    assert values.pop("title") == "A research paper"
    assert all(value is None for value in values.values())


def test_paper_preserves_supplied_metadata():
    metadata = {
        "id": "paper-1",
        "title": "A research paper",
        "authors": ["Example Author"],
        "doi": "10.1234/example",
        "publication_date": "2026-01-15",
        "source_name": "Example Journal",
        "abstract": "An example abstract.",
        "paper_url": "https://example.org/paper-1",
        "oa_url": "https://example.org/paper-1.pdf",
        "paper_type": "article",
        "is_retracted": False,
        "retrieved_at": "2026-10-27T00:00:00Z",
        "provenance": {"provider": "example"},
    }

    assert asdict(Paper(**metadata)) == metadata


@pytest.mark.parametrize("field", ["id", "title"])
@pytest.mark.parametrize("value", ["", " ", "\t\n", None, 123])
def test_paper_rejects_invalid_required_values(field, value):
    metadata = {"id": "paper-1", "title": "A research paper"}
    metadata[field] = value

    with pytest.raises(ValueError, match=f"^{field} must be a non-empty string$"):
        Paper(**metadata)


@pytest.mark.parametrize("field", ["id", "title"])
def test_paper_requires_both_id_and_title(field):
    metadata = {"id": "paper-1", "title": "A research paper"}
    del metadata[field]

    with pytest.raises(TypeError, match=field):
        Paper(**metadata)
