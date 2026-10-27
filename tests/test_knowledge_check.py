"""Scoring and Streamlit interaction checks for the demo assessment."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from screens.knowledge_check import QUESTIONS_BY_TOPIC, _calculate_result


SCREEN_PATH = Path(__file__).resolve().parents[1] / "screens" / "knowledge_check.py"
TOPICS = tuple(QUESTIONS_BY_TOPIC)


def _button(app, label):
    return next(button for button in app.button if button.label == label)


def _new_app(topic):
    app = AppTest.from_file(str(SCREEN_PATH)).run(timeout=15)
    if app.selectbox[0].value != topic:
        app.selectbox[0].select(topic).run()
    assert not app.exception
    return app


def _assert_reset(app):
    assert not app.exception
    assert len(app.radio) == 3
    assert all(radio.value is None for radio in app.radio)
    assert app.session_state["knowledge_check_answers"] == [None, None, None]
    assert app.session_state["knowledge_check_result"] is None
    assert app.session_state["knowledge_check_skipped"] is False
    assert _button(app, "Submit assessment").disabled
    assert not app.success


@pytest.mark.parametrize("topic", TOPICS)
def test_each_topic_has_three_complete_demo_questions(topic):
    questions = QUESTIONS_BY_TOPIC[topic]
    assert len(questions) == 3
    assert len({question.prompt for question in questions}) == 3
    for question in questions:
        assert question.prompt.strip()
        assert len(question.options) == len(set(question.options))
        assert question.options.count("I don't know") == 1
        assert question.options.count(question.correct_answer) == 1
        assert question.correct_answer != "I don't know"


@pytest.mark.parametrize("topic", TOPICS)
@pytest.mark.parametrize(
    ("score", "familiarity"),
    [(0, "Beginner"), (1, "Beginner"), (2, "Developing"), (3, "Familiar")],
)
def test_score_and_familiarity(topic, score, familiarity):
    questions = QUESTIONS_BY_TOPIC[topic]
    answers = [
        question.correct_answer if index < score else "I don't know"
        for index, question in enumerate(questions)
    ]

    result = _calculate_result(questions, answers)

    assert result["score"] == score
    assert result["familiarity"] == familiarity
    assert result["submitted_answers"] == answers
    answers[0] = None
    assert result["submitted_answers"][0] is not None


@pytest.mark.parametrize("topic", TOPICS)
def test_incorrect_choices_do_not_score(topic):
    questions = QUESTIONS_BY_TOPIC[topic]
    answers = [
        next(
            option
            for option in question.options
            if option not in (question.correct_answer, "I don't know")
        )
        for question in questions
    ]

    assert _calculate_result(questions, answers)["score"] == 0


@pytest.mark.parametrize("topic", TOPICS)
@pytest.mark.parametrize(
    ("score", "familiarity"),
    [(0, "Beginner"), (1, "Beginner"), (2, "Developing"), (3, "Familiar")],
)
def test_streamlit_submission_and_persistent_results(topic, score, familiarity):
    app = _new_app(topic)
    _assert_reset(app)
    assert "not a validated measure of ability" in app.caption[0].value

    for index, question in enumerate(QUESTIONS_BY_TOPIC[topic]):
        answer = question.correct_answer if index < score else "I don't know"
        app.radio[index].set_value(answer).run()
        assert not app.exception
        assert _button(app, "Submit assessment").disabled == (index < 2)

    _button(app, "Submit assessment").click().run()
    assert not app.exception
    result = app.session_state["knowledge_check_result"]
    assert result["score"] == score
    assert result["familiarity"] == familiarity
    assert result["submitted_answers"] == app.session_state["knowledge_check_answers"]
    assert app.success[0].value == "Assessment submitted"
    assert f"Score: **{score} out of 3**" in [item.value for item in app.markdown]
    assert f"Familiarity level: **{familiarity}**" in [
        item.value for item in app.markdown
    ]

    app.run()
    assert not app.exception
    assert app.session_state["knowledge_check_result"] == result
    assert [radio.value for radio in app.radio] == result["submitted_answers"]
    assert app.success[0].value == "Assessment submitted"


@pytest.mark.parametrize("topic", TOPICS)
def test_selection_topic_skip_and_restart_reset_state(topic):
    app = _new_app(topic)
    for radio in app.radio:
        radio.set_value("I don't know")
    app.run()
    _button(app, "Submit assessment").click().run()
    assert app.session_state["knowledge_check_result"]["score"] == 0

    app.radio[0].set_value(QUESTIONS_BY_TOPIC[topic][0].correct_answer).run()
    assert not app.exception
    assert app.session_state["knowledge_check_result"] is None
    assert not app.success
    _button(app, "Submit assessment").click().run()
    assert app.session_state["knowledge_check_result"]["score"] == 1

    other_topic = next(other for other in TOPICS if other != topic)
    app.selectbox[0].select(other_topic).run()
    _assert_reset(app)
    assert [radio.label for radio in app.radio] == [
        f"{index + 1}. {question.prompt}"
        for index, question in enumerate(QUESTIONS_BY_TOPIC[other_topic])
    ]
    app.radio[0].set_value("I don't know").run()
    app.selectbox[0].select(topic).run()
    _assert_reset(app)

    # Skipping a partial assessment clears answers and stays skipped on reruns.
    app.radio[0].set_value("I don't know").run()
    _button(app, "Skip assessment").click().run()
    assert not app.exception
    assert not app.radio
    assert app.session_state["knowledge_check_answers"] == [None, None, None]
    assert app.session_state["knowledge_check_result"] is None
    assert app.success[0].value == "Assessment skipped"
    assert [button.label for button in app.button] == ["Restart assessment"]
    app.run()
    assert not app.exception
    assert not app.radio
    assert app.success[0].value == "Assessment skipped"
    _button(app, "Restart assessment").click().run()
    _assert_reset(app)
    assert app.selectbox[0].value == topic

    # Skipping a submitted assessment also discards the result.
    for index, question in enumerate(QUESTIONS_BY_TOPIC[topic]):
        app.radio[index].set_value(question.correct_answer)
    app.run()
    _button(app, "Submit assessment").click().run()
    assert app.session_state["knowledge_check_result"]["score"] == 3
    _button(app, "Skip assessment").click().run()
    assert not app.exception
    assert app.session_state["knowledge_check_result"] is None
    assert app.session_state["knowledge_check_answers"] == [None, None, None]
    app.selectbox[0].select(other_topic).run()
    _assert_reset(app)


def test_imported_render_function_works():
    app = AppTest.from_string(
        "from screens.knowledge_check import render_knowledge_check\n"
        "render_knowledge_check()"
    ).run(timeout=15)

    _assert_reset(app)
