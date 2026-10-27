"""Fixed demo questions, beginner concepts, and rule-based recommendations."""

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Question:
    """A demo question with a stable ID for its prerequisite mapping."""

    id: str
    prompt: str
    options: tuple[str, ...]
    correct_answer: str


@dataclass(frozen=True)
class PrerequisiteConcept:
    """A short beginner learning card."""

    title: str
    explanation: str
    example: str
    research_relevance: str
    reflection_question: str


QUESTIONS_BY_TOPIC = {
    "Supervised Machine Learning": (
        Question(
            "ml_labeled_data",
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
            "ml_classification",
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
            "ml_generalization",
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
            "iot_connected_devices",
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
            "iot_sensors",
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
            "iot_security",
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


PREREQUISITES_BY_QUESTION = {
    "ml_labeled_data": PrerequisiteConcept(
        title="Labeled Data",
        explanation=(
            "Labeled data pairs an example with its known answer. A supervised "
            "learning model uses these pairs to learn patterns."
        ),
        example=(
            "Photos marked 'cat' or 'dog' give a model examples of each animal."
        ),
        research_relevance=(
            "A paper's labels tell you what the model is learning to predict. "
            "Incorrect labels can make its results less reliable."
        ),
        reflection_question="What label would you attach to an example spam email?",
    ),
    "ml_classification": PrerequisiteConcept(
        title="Classification",
        explanation=(
            "Classification means choosing a category for an example. "
            "The answer is a category, rather than a measured number."
        ),
        example="An email filter classifies a message as spam or not spam.",
        research_relevance=(
            "Recognizing a classification task helps you understand the "
            "categories a paper predicts and the mistakes it measures."
        ),
        reflection_question=(
            "Would sorting photos into 'cat' and 'dog' be classification? Why?"
        ),
    ),
    "ml_generalization": PrerequisiteConcept(
        title="Model Generalization",
        explanation=(
            "Generalization is how well a model handles new examples. "
            "Memorizing training examples does not guarantee useful predictions."
        ),
        example=(
            "A cat detector trained on one photo collection is tested on "
            "different cat photos it has never seen."
        ),
        research_relevance=(
            "Checking how a paper separates training and test data helps you "
            "judge whether its results may hold for new examples."
        ),
        reflection_question=(
            "Why might testing only on the training photos give a misleading result?"
        ),
    ),
    "iot_connected_devices": PrerequisiteConcept(
        title="Connected Devices",
        explanation=(
            "IoT devices are physical objects that exchange data through a "
            "network. They can report measurements or receive instructions."
        ),
        example=(
            "A smart thermostat sends room readings to an app and receives "
            "a new target temperature."
        ),
        research_relevance=(
            "Following which devices send and receive data helps you understand "
            "an IoT paper's system design."
        ),
        reflection_question=(
            "What information could a connected garden watering device send to a phone?"
        ),
    ),
    "iot_sensors": PrerequisiteConcept(
        title="Sensors",
        explanation=(
            "A sensor measures something in the physical world and turns it "
            "into data a device can use."
        ),
        example=(
            "A soil moisture sensor measures how wet the soil is so a garden "
            "system can decide when to water."
        ),
        research_relevance=(
            "Knowing what a sensor measures helps you understand where a paper's "
            "data comes from and what measurement errors could affect it."
        ),
        reflection_question="Which sensor could help detect that a room is too hot?",
    ),
    "iot_security": PrerequisiteConcept(
        title="IoT Security",
        explanation=(
            "IoT security protects connected devices and their data from "
            "unwanted access. Unique passwords and security updates help."
        ),
        example=(
            "A household changes a smart camera's default password and "
            "installs updates from its manufacturer."
        ),
        research_relevance=(
            "Security concepts help you identify who can access a paper's IoT "
            "system and how its device data is protected."
        ),
        reflection_question=(
            "Why could leaving a camera's default password unchanged be risky?"
        ),
    ),
}


def recommend_prerequisites(
    topic: str,
    answers: Mapping[str, str | None] | None = None,
    *,
    skipped: bool = False,
) -> list[PrerequisiteConcept]:
    """Return cards in question order for missed answers, or all cards if skipped.

    Answers are keyed by stable question IDs. Incomplete or mismatched answer
    sets are rejected; recommendations require submission or an explicit skip.
    """
    if topic not in QUESTIONS_BY_TOPIC:
        raise ValueError(f"Unknown assessment topic: {topic}")
    questions = QUESTIONS_BY_TOPIC[topic]
    if skipped:
        return [PREREQUISITES_BY_QUESTION[question.id] for question in questions]

    if answers is None or set(answers) != {question.id for question in questions}:
        raise ValueError("Provide one answer for each question in the selected topic.")
    if any(answers[question.id] not in question.options for question in questions):
        raise ValueError("Each question needs a selected answer from its options.")

    return [
        PREREQUISITES_BY_QUESTION[question.id]
        for question in questions
        if answers[question.id] != question.correct_answer
    ]
