"""Shared research and learning data structures."""

from dataclasses import dataclass


@dataclass
class Paper:
    """Paper metadata with optional fields left unknown until supplied.

    Dates and URLs are stored as strings without format validation.
    """

    id: str
    title: str
    authors: list[str] | None = None
    doi: str | None = None
    publication_date: str | None = None
    source_name: str | None = None
    abstract: str | None = None
    paper_url: str | None = None
    oa_url: str | None = None
    paper_type: str | None = None
    is_retracted: bool | None = None
    retrieved_at: str | None = None
    provenance: dict[str, str] | None = None

    def __post_init__(self) -> None:
        for name in ("id", "title"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")
