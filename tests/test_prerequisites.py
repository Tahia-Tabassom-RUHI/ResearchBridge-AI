"""Checks for fixed concept content and rule-based prerequisite recommendations."""

import pytest

from services.prerequisites import (
    PREREQUISITES_BY_QUESTION,
    QUESTIONS_BY_TOPIC,
    recommend_prerequisites,
)


EXPECTED_CONCEPTS = {
    "Supervised Machine Learning": (
        ("ml_labeled_data", "Labeled Data"),
        ("ml_classification", "Classification"),
        ("ml_generalization", "Model Generalization"),
    ),
    "Internet of Things (IoT)": (
        ("iot_connected_devices", "Connected Devices"),
        ("iot_sensors", "Sensors"),
        ("iot_security", "IoT Security"),
    ),
}
TOPICS = tuple(EXPECTED_CONCEPTS)


def _correct_answers(topic):
    return {
        question.id: question.correct_answer
        for question in QUESTIONS_BY_TOPIC[topic]
    }


@pytest.mark.parametrize("topic", TOPICS)
def test_stable_question_mapping_and_complete_concept_content(topic):
    questions = QUESTIONS_BY_TOPIC[topic]
    expected = EXPECTED_CONCEPTS[topic]
    assert [question.id for question in questions] == [item[0] for item in expected]
    for question_id, title in expected:
        concept = PREREQUISITES_BY_QUESTION[question_id]
        assert concept.title == title
        for content in (
            concept.explanation,
            concept.example,
            concept.research_relevance,
            concept.reflection_question,
        ):
            assert content.strip()
        assert concept.reflection_question.endswith("?")


@pytest.mark.parametrize("topic", TOPICS)
@pytest.mark.parametrize("question_index", range(3))
@pytest.mark.parametrize("answer_type", ["incorrect", "unknown"])
def test_each_missed_answer_recommends_its_corresponding_concept(
    topic, question_index, answer_type
):
    answers = _correct_answers(topic)
    question = QUESTIONS_BY_TOPIC[topic][question_index]
    answers[question.id] = (
        "I don't know"
        if answer_type == "unknown"
        else next(
            option
            for option in question.options
            if option not in (question.correct_answer, "I don't know")
        )
    )

    concepts = recommend_prerequisites(topic, answers)

    assert [concept.title for concept in concepts] == [
        EXPECTED_CONCEPTS[topic][question_index][1]
    ]


@pytest.mark.parametrize("topic", TOPICS)
def test_multiple_recommendations_follow_question_order_and_leave_answers_unchanged(topic):
    questions = QUESTIONS_BY_TOPIC[topic]
    # Reverse the response insertion order to ensure IDs, not positions, map answers.
    answers = {question.id: "I don't know" for question in reversed(questions)}
    answers[questions[1].id] = questions[1].correct_answer
    original = answers.copy()

    concepts = recommend_prerequisites(topic, answers)

    assert [concept.title for concept in concepts] == [
        EXPECTED_CONCEPTS[topic][0][1],
        EXPECTED_CONCEPTS[topic][2][1],
    ]
    assert answers == original


@pytest.mark.parametrize("topic", TOPICS)
def test_all_correct_answers_need_no_recommendations(topic):
    assert recommend_prerequisites(topic, _correct_answers(topic)) == []


@pytest.mark.parametrize("topic", TOPICS)
def test_skipped_assessment_offers_all_concepts_without_answers(topic):
    expected_titles = [title for _, title in EXPECTED_CONCEPTS[topic]]

    assert [
        concept.title for concept in recommend_prerequisites(topic, skipped=True)
    ] == expected_titles
    assert [
        concept.title
        for concept in recommend_prerequisites(
            topic, _correct_answers(topic), skipped=True
        )
    ] == expected_titles


@pytest.mark.parametrize("topic", TOPICS)
@pytest.mark.parametrize("invalid_case", ["missing", "partial", "unanswered", "invalid"])
def test_unsubmitted_or_invalid_answers_are_rejected(topic, invalid_case):
    answers = _correct_answers(topic)
    question_id = QUESTIONS_BY_TOPIC[topic][0].id
    if invalid_case == "missing":
        answers = None
    elif invalid_case == "partial":
        del answers[question_id]
    elif invalid_case == "unanswered":
        answers[question_id] = None
    else:
        answers[question_id] = "Not an offered option"

    with pytest.raises(ValueError):
        recommend_prerequisites(topic, answers)


def test_answers_from_another_topic_are_rejected():
    with pytest.raises(ValueError, match="selected topic"):
        recommend_prerequisites(TOPICS[0], _correct_answers(TOPICS[1]))


def test_unknown_topic_is_rejected():
    with pytest.raises(ValueError, match="Unknown assessment topic"):
        recommend_prerequisites("Unknown topic", skipped=True)
