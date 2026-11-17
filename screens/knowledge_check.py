"""Standalone Streamlit preview for a simple demo knowledge assessment."""

import streamlit as st

from services.prerequisites import (
    QUESTIONS_BY_TOPIC,
    Question,
    recommend_prerequisites,
)


def _calculate_result(
    questions: tuple[Question, ...], answers: list[str | None]
) -> dict:
    """Score the fixed three-question demo, without interpreting ability."""
    score = sum(
        answer == question.correct_answer
        for question, answer in zip(questions, answers, strict=True)
    )
    familiarity = ("Beginner", "Beginner", "Developing", "Familiar")[score]
    return {
        "score": score,
        "familiarity": familiarity,
        "submitted_answers": answers.copy(),
    }


def _reset_assessment(skipped: bool = False) -> None:
    """Clear saved answers, results, and radio widgets before rendering."""
    st.session_state["knowledge_check_skipped"] = skipped
    st.session_state["knowledge_check_answers"] = [None, None, None]
    st.session_state["knowledge_check_result"] = None
    for index in range(3):
        st.session_state.pop(f"knowledge_check_question_{index}", None)


def _render_prerequisites(
    topic: str, submitted_answers: list[str | None] | None = None, *, skipped: bool = False
) -> None:
    """Derive current recommendations without storing a second copy of state."""
    answers_by_id = None
    if submitted_answers is not None:
        answers_by_id = {
            question.id: answer
            for question, answer in zip(
                QUESTIONS_BY_TOPIC[topic], submitted_answers, strict=True
            )
        }
    concepts = recommend_prerequisites(topic, answers_by_id, skipped=skipped)

    st.subheader("Beginner learning cards")
    st.caption(
        "Rule-based demo guidance, not an AI diagnosis or a validated evaluation."
    )
    if not concepts:
        st.success("This short demo found no immediate foundational gaps.")
        return

    for concept in concepts:
        with st.expander(concept.title):
            st.write(concept.explanation)
            st.write(f"**Real-world example:** {concept.example}")
            st.write(f"**Why it matters for research:** {concept.research_relevance}")
            st.write(f"**Reflection question:** {concept.reflection_question}")


def render_knowledge_check() -> None:
    """Render a topic assessment, persistent results, or skip confirmation."""
    st.title("Quick Knowledge Check")
    st.caption(
        "Simple demo assessment: this is not a validated measure of ability."
    )

    st.session_state.setdefault("knowledge_check_skipped", False)
    st.session_state.setdefault("knowledge_check_answers", [None, None, None])
    st.session_state.setdefault("knowledge_check_result", None)

    topic = st.selectbox(
        "Topic",
        options=list(QUESTIONS_BY_TOPIC),
        key="knowledge_check_topic",
        on_change=_reset_assessment,
    )

    if st.session_state["knowledge_check_skipped"]:
        st.success("Assessment skipped")
        st.button("Restart assessment", on_click=_reset_assessment)
        _render_prerequisites(topic, skipped=True)
        return

    questions = QUESTIONS_BY_TOPIC[topic]
    answers = []
    for index, question in enumerate(questions):
        answers.append(
            st.radio(
                f"{index + 1}. {question.prompt}",
                options=question.options,
                index=None,
                key=f"knowledge_check_question_{index}",
            )
        )

    if answers != st.session_state["knowledge_check_answers"]:
        st.session_state["knowledge_check_result"] = None
    st.session_state["knowledge_check_answers"] = answers

    if st.button("Submit assessment", disabled=any(a is None for a in answers)):
        st.session_state["knowledge_check_result"] = _calculate_result(
            questions, answers
        )

    result = st.session_state["knowledge_check_result"]
    if result is not None:
        st.success("Assessment submitted")
        st.write(f"Score: **{result['score']} out of 3**")
        st.write(f"Familiarity level: **{result['familiarity']}**")
        _render_prerequisites(topic, result["submitted_answers"])

    st.button("Skip assessment", on_click=_reset_assessment, args=(True,))


if __name__ == "__main__":
    render_knowledge_check()
