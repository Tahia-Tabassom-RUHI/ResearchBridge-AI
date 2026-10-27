"""Standalone Streamlit preview for a simple demo knowledge assessment."""

from dataclasses import dataclass

import streamlit as st


@dataclass(frozen=True)
class Question:
    """A fixed demo question and its answer key."""

    prompt: str
    options: tuple[str, ...]
    correct_answer: str


QUESTIONS_BY_TOPIC = {
    "Supervised Machine Learning": (
        Question(
            "In supervised Machine Learning, what does a model learn from?",
            (
                "Labeled examples with known answers",
                "Unlabeled data with no known answers",
                "Rewards and penalties from interacting with an environment",
                "I don't know",
            ),
            "Labeled examples with known answers",
        ),
        Question(
            "Which task is an example of classification?",
            (
                "Predicting tomorrow's temperature as a number",
                "Labeling an email as spam or not spam",
                "Storing emails in a database",
                "I don't know",
            ),
            "Labeling an email as spam or not spam",
        ),
        Question(
            "Why test a model on examples it did not train on?",
            (
                "To make the training examples disappear",
                "To guarantee it will always be correct",
                "To check how well it handles new examples",
                "I don't know",
            ),
            "To check how well it handles new examples",
        ),
    ),
    "Internet of Things (IoT)": (
        Question(
            "What is a common purpose of an Internet of Things (IoT) system?",
            (
                "Connecting physical devices so they can exchange data",
                "Keeping every device permanently disconnected",
                "Replacing all physical devices with websites",
                "I don't know",
            ),
            "Connecting physical devices so they can exchange data",
        ),
        Question(
            "What does a temperature sensor in a smart room do?",
            (
                "Choose a Wi-Fi password",
                "Measure the room's temperature",
                "Display a movie",
                "I don't know",
            ),
            "Measure the room's temperature",
        ),
        Question(
            "Which action helps keep an internet-connected device secure?",
            (
                "Share its password publicly",
                "Keep its default password forever",
                "Install security updates from its manufacturer",
                "I don't know",
            ),
            "Install security updates from its manufacturer",
        ),
    ),
}


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
        return

    questions = QUESTIONS_BY_TOPIC[topic]
    answers = []
    for index, question in enumerate(questions):
        saved_answer = st.session_state["knowledge_check_answers"][index]
        answers.append(
            st.radio(
                f"{index + 1}. {question.prompt}",
                options=question.options,
                index=(
                    question.options.index(saved_answer)
                    if saved_answer in question.options
                    else None
                ),
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

    st.button("Skip assessment", on_click=_reset_assessment, args=(True,))


if __name__ == "__main__":
    render_knowledge_check()
