"""Research matrix fields and storage for Library papers."""
from collections import Counter
import csv
from datetime import datetime, timezone
from io import StringIO
import re
from uuid import uuid4

import streamlit as st

from services.library import validate_papers
from services.scholarly import publication_date
from services.vault_session import persist_vault


FIELDS = {
    "title": "Paper Title",
    "authors": "Authors",
    "year": "Publication Year",
    "url_doi": "Paper URL / DOI",
    "problem": "Research Problem",
    "data": "Dataset / Data Used",
    "methodology": "Methodology",
    "findings": "Key Results / Findings",
    "metrics": "Evaluation Metrics",
    "limitations": "Limitations",
    "observations": "My Observations",
    "question": "Authors' Research Question",
    "citation": "Full Citation",
    "evidence": "Evidence Location / Supporting Excerpt",
}


FORMULA_PREFIX = re.compile(r"^[\s\ufeff\u200b]*[=+\-@＝＋－＠]")


def spreadsheet_text(value):
    if value.startswith(("\t", "\r", "\n")) or FORMULA_PREFIX.match(value):
        return "'" + value
    return value


def comparison_csv(entries, library_titles):
    """Export saved entries in the displayed paper order."""
    titles = [
        spreadsheet_text(entry["title"].strip() or library_titles[paper_id])
        for paper_id, entry in entries.items()
    ]
    reserved = set(titles) | {"Research field"}
    used = {"Research field"}
    counts = Counter()
    headers = []
    for title in titles:
        label = title
        if label in used:
            while label in reserved or label in used:
                counts[title] += 1
                label = f"{title} ({counts[title] + 1})"
        headers.append(label)
        used.add(label)

    output = StringIO(newline="")
    writer = csv.writer(output, quoting=csv.QUOTE_ALL)
    writer.writerow(["Research field", *headers])
    for field, label in FIELDS.items():
        writer.writerow([label, *(spreadsheet_text(entry[field]) for entry in entries.values())])
    return output.getvalue().encode("utf-8-sig")


def entry(paper_id, paper):
    date = publication_date(paper.get("publication_date") or paper.get("year"))
    prefill = {
        "title": paper.get("title") or "",
        "authors": ", ".join(paper.get("authors") or []),
        "year": date[:4] if date else "",
        "url_doi": paper.get("paper_url") or paper.get("doi") or "",
        "citation": paper.get("citation") or "",
    }
    saved = st.session_state.research_matrices.get(paper_id, {})
    return {field: saved.get(field, prefill.get(field, "")) for field in FIELDS}


def save(entries):
    validate_papers(entries)
    st.session_state.research_matrices = {**st.session_state.research_matrices, **entries}
    return persist_vault(fields=("research_matrices",))


def save_comparison(name, paper_ids, comparison_id=None):
    name = name.strip()
    if not name:
        raise ValueError("Enter a name for the comparison.")
    validate_papers(paper_ids)
    comparisons = st.session_state.research_comparisons
    previous = comparisons[comparison_id] if comparison_id is not None else {}
    comparison_id = comparison_id or uuid4().hex
    timestamp = datetime.now(timezone.utc).isoformat()
    st.session_state.research_comparisons = {
        **comparisons,
        comparison_id: {
            "name": name,
            "paper_ids": list(dict.fromkeys(paper_ids)),
            "created_at": previous.get("created_at", timestamp),
            "updated_at": timestamp,
        },
    }
    return comparison_id if persist_vault(fields=("research_comparisons",)) else None


def delete_comparison(comparison_id):
    comparisons = st.session_state.research_comparisons
    st.session_state.research_comparisons = {
        key: comparison for key, comparison in comparisons.items() if key != comparison_id
    }
    return persist_vault(fields=("research_comparisons",))
