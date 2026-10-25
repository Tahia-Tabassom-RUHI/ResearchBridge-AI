# ResearchBridge AI

An interactive research-learning web application intended to help students
explore scholarly research and build prerequisite knowledge.

**Hackathon:** STEM2Connect AI Hackathon 2026  
**Primary track:** Education

## Current development status

This repository contains the initial coding environment and a minimal Streamlit
starter. The app displays the project name, a short description, and a development
notice. Research retrieval, ranking, AI teaching, assessments, and a database
have not been implemented. Page design and navigation have not started.

The team's full requirements are documented in `ResearchBridge_STEM2Connect.docx`.
That document is not included in this initial repository. Consult the team's
copy before implementing future features.

## Technology stack

- Python 3.11 or newer; use a standard Python installation from python.org.
- Streamlit for the web application.
- pytest and Streamlit's built-in app testing tools for smoke tests.

Direct dependencies are pinned in `requirements.txt`. No AI SDKs, database
packages, or API client libraries are included.

## Project structure

```text
ResearchBridge-AI/
|-- app.py
|-- components/
|   `-- __init__.py
|-- screens/
|   `-- __init__.py
|-- services/
|   |-- __init__.py
|   |-- papers.py
|   |-- ranking.py
|   `-- teach.py
|-- models/
|   |-- __init__.py
|   `-- schemas.py
|-- sample_data/
|   `-- .gitkeep
|-- tests/
|   `-- test_setup.py
|-- .streamlit/
|   `-- config.toml
|-- requirements.txt
|-- .gitignore
|-- .env.example
`-- README.md
```

| Folder or file | Purpose |
| --- | --- |
| `app.py` | Entry point for the minimal Streamlit application. |
| `components/` | Future reusable interface components. |
| `screens/` | Future application screens; no screens are implemented yet. |
| `services/` | Future paper retrieval, ranking, and teaching logic. |
| `services/papers.py` | Future OpenAlex retrieval and metadata verification. |
| `services/ranking.py` | Future transparent ranking criteria and scoring. |
| `services/teach.py` | Future prerequisite teaching and explanation generation. |
| `models/` | Future shared data structures, defined in `schemas.py`. |
| `sample_data/` | Future verified sample data; currently empty. `.gitkeep` lets Git retain the folder. |
| `tests/` | Smoke tests for module imports and execution of the starter app. |
| `.streamlit/` | Simple Streamlit settings in `config.toml`. |
| `requirements.txt` | The application and test dependencies to install. |
| `.gitignore` | Keeps local environments, caches, and common secret files out of Git. |
| `.env.example` | Empty future configuration placeholders; no credentials are needed now. |

The `__init__.py` files mark Python packages. The service and schema files contain
documentation only, ready for later implementation.

## Installation

Open a terminal in this project folder. Check that `python --version` reports
Python 3.11 or newer. If your system uses `python3`, substitute that command when
creating the environment.

Create an isolated virtual environment:

```console
python -m venv .venv
```

Activate it on Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

Or activate it on macOS/Linux:

```bash
source .venv/bin/activate
```

Install the dependencies with the environment active:

```console
python -m pip install -r requirements.txt
```

If PowerShell prevents activation, use the environment's Python directly without
changing your execution policy:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

No environment variables or API keys are needed to run the starter. `.env.example`
documents future placeholders. The starter does not load `.env` files. Keep real
keys in local ignored configuration, and check staged files before committing.

## Run the starter application

With the virtual environment active, run from the project folder:

```console
python -m streamlit run app.py
```

On Windows, you can also run without activation:

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```

Open the local URL printed in the terminal, usually `http://localhost:8501`.
The simple configuration uses headless mode, so a browser may not open
automatically. Press `Ctrl+C` in the terminal to stop the server.

## Verify the setup

With the virtual environment active:

```console
python -m compileall -q app.py components screens services models tests
python -m pip check
python -m pytest -q
```

Without activation on Windows, replace `python` with
`.\.venv\Scripts\python.exe` in each command. The tests import the module
foundations and run the actual Streamlit script using `AppTest`. No API calls
or credentials are involved.

## Planned future phases

- OpenAlex paper retrieval and scholarly metadata verification.
- Transparent paper ranking with explainable criteria.
- AI-powered prerequisite teaching and explanation generation.
- Validated data structures for research and learning information.
- Application screens and reusable components, once the team agrees on the design.

To begin a future feature, review the requirements document, agree on a small
scope, and implement its logic in the matching service. Define shared structures
in `models/schemas.py`, add meaningful tests in `tests/`, and connect the feature
to a screen or component when interface work is authorized. Add dependencies and
configuration only when the feature needs them. Use verified scholarly data.

## AI development assistance disclosure

This section records tool assistance separately from human authorship. The
student team owns the project and remains responsible for reviewing the work.
Keep this record current and check the official hackathon disclosure requirements
before submission; this template does not establish compliance by itself.

| Scope | Tool used | Assistance | Human review |
| --- | --- | --- | --- |
| Initial coding foundation | Codex | Repository scaffolding, minimal Streamlit starter, environment setup, documentation, and verification support. | Pending student team review. |

For later assistance, record the date, tool/model where known, affected files or
tasks, suggestions accepted or changed, and how the team reviewed and verified
the result. Do not enter credentials or private prompts in this record.
