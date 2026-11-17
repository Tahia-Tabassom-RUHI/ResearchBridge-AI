"""Pure helpers for guided reading of student-supplied abstracts."""

from dataclasses import dataclass


MIN_ABSTRACT_WORDS = 20


@dataclass(frozen=True)
class ReflectionPrompt:
    """A fixed reading question and a hint, without an inferred answer."""

    id: str
    title: str
    question: str
    hint: str


REFLECTION_PROMPTS = (
    ReflectionPrompt(
        "research_problem",
        "Research problem",
        "What problem or need does this research try to address?",
        "Look for the motivation: what is difficult, missing, or worth studying?",
    ),
    ReflectionPrompt(
        "approach",
        "Approach or method",
        "How did the researchers try to address the problem?",
        "Look for what they built, tested, compared, measured, or analyzed.",
    ),
    ReflectionPrompt(
        "finding",
        "Reported finding or contribution",
        "What finding or contribution does the abstract report?",
        "Look for a stated result or something introduced by the study. "
        "A goal is not necessarily a result; do not assume it was achieved.",
    ),
    ReflectionPrompt(
        "limitation",
        "Limitation or open question",
        "What limitation or unanswered question is stated in the abstract?",
        "Look for an explicit restriction, uncertainty, or future work. "
        "If none is mentioned, choose 'Not stated in the abstract'.",
    ),
)


def validate_paper_input(title: object, abstract: object) -> list[str]:
    """Return input errors using a transparent minimum-length demo rule.

    Word-like tokens must contain a letter. This rejects empty or very short
    text and punctuation-only input; it does not validate scientific content.
    """
    errors = []
    if not isinstance(title, str) or not title.strip():
        errors.append("Enter a nonempty paper title.")
    if not isinstance(abstract, str) or not abstract.strip():
        errors.append("Paste the paper's abstract.")
    elif sum(any(char.isalpha() for char in word) for word in abstract.split()) < (
        MIN_ABSTRACT_WORDS
    ):
        errors.append(
            f"Paste a meaningful abstract with at least {MIN_ABSTRACT_WORDS} "
            "words containing letters for this demo."
        )
    return errors


def excerpt_matches(abstract: object, excerpt: object) -> bool:
    """Check a literal substring after case folding and whitespace normalization.

    Missing, blank, or nonstring inputs never match. Punctuation and wording
    must still match; this checks the source text, not an interpretation.
    """
    if not isinstance(abstract, str) or not isinstance(excerpt, str):
        return False
    normalized_abstract = " ".join(abstract.casefold().split())
    normalized_excerpt = " ".join(excerpt.casefold().split())
    return bool(normalized_abstract and normalized_excerpt) and (
        normalized_excerpt in normalized_abstract
    )
