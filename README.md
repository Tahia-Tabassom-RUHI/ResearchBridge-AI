# ResearchBridge AI — paper discovery

A beginner enters an everyday question, corrects the suggested research direction,
and gets a small shortlist of real source records with links and available abstracts.
Built for Shiney's paper-discovery branch in the STEM2Connect hackathon project.

## Run on this computer

```bash
cd "/Users/zuzi/My Projects/ResearchBridge-AI"
.venv-runtime/bin/python -m streamlit run app.py --server.address 127.0.0.1 --server.port 8502
```

Open http://localhost:8502. The previous prototype may still occupy port 8501. This local environment uses Python 3.12. The computer's
system Python 3.9 cannot install the pinned dependencies.

On another computer, use Python 3.11+, create a virtual environment, install
`requirements.txt`, and run `python -m streamlit run app.py`.

## What works without an account

- Live Crossref and Europe PMC searches in parallel, with source-specific failure
  recovery. Europe PMC's coverage focuses on life sciences; Crossref is broader.
- Source normalization, DOI deduplication, merging available abstracts and links,
  publication-year filters, and retraction flags where supplied.
- Guided examples for food storage, plant health, and memory. Other questions use
  editable keyword cleanup. This fallback is explicitly labelled; it is not AI.
- Two recommendations per page, with inspectable query-word matching. Help me
  start favours available abstracts and review metadata; other options show best
  keyword matches, recency or free-text links. This is not a quality assessment.
- Interest bubbles rerank records. Find more papers with my focus sends selected
  high-priority terms in an additional live search.
- Reading tray, optional research-activity maps, and selected-paper handoff.

The retrieval budget is two search phrases, each queried against Crossref and
Europe PMC, plus one optional OpenAlex request if configured. Requests time out,
results are cached for 15 minutes, and at most 80 unique records are shown. A DOI
is deduplicated; preprint and published versions with different DOIs remain distinct.
A scholarly record can be a review, article, preprint, chapter or other work: type
labels do not establish peer review. Missing metadata remains unknown.

## Optional live AI — one key

The sidebar **Demo setup** accepts a Gemini API key in a password field for the
current session. Enable **Use live AI guidance**, then submit your question.
The key is sent server-side to Google's API in a header; it is not written to a
source file. **Forget session key** clears this session's entered key. That button
does not remove a key configured in environment/deployment secrets.

Alternatively, copy `.streamlit/secrets.toml.example` to the ignored file
`.streamlit/secrets.toml` and enter a private `GEMINI_API_KEY`. The configured key
is not sent to the browser. Default model: `gemini-2.5-flash-lite`; `GEMINI_MODEL`
can select another supported Gemini model. The app does not load `.env` files.

- Gemini proposes 1–3 research directions, a clarification and general concept
  definitions. It never supplies citation metadata.
- Paper-specific help is requested only with **Explain this abstract simply** on
  a retrieved record with an abstract. One short orientation is displayed with an
  exact source passage and reading suggestion, labelled as abstract-based AI help.
- Output validation rejects wrong fields, invented links, missing evidence quotes
  and unsupported numeric details. Quote presence is not a proof of entailment;
  a student still needs to check the original abstract and source.
- Input questions and selected abstracts are sent to Google only when the
  corresponding AI feature is enabled and requested. Source text is treated as
  untrusted data. Calls are bounded and failures preserve ordinary paper search.

Google's free tier has account/model/region limits, and submitted content may be
used to improve its products. Use non-sensitive study questions. A key does not
itself guarantee zero charges if attached to a billing-enabled project; confirm the
project's tier and quota in AI Studio. No billing setup is required by this app.

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
[API keys](https://aistudio.google.com/api-keys)
[Crossref API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
[Europe PMC API](https://europepmc.org/RestfulWebService)

Optional `OPENALEX_API_KEY` supplements the public searches. It is no longer a
prerequisite for searching. No live Gemini call was possible during development
because no Gemini key was configured; the adapter and failure cases are tested
with mocked responses. Live scholarly retrieval was verified separately.

## Rehearse the demo

1. Enter “Why do I forget things I studied yesterday?”
2. Submit and choose the closest direction. Correct the wording if needed.
3. Select Find real papers; inspect three source cards and their matching terms.
4. Open an abstract, save one paper, and open its original source.
5. With Gemini enabled, request a simple abstract explanation and inspect the
   exact supporting passage. Explain that the full text was not analyzed.
6. Optionally expand the bubble board to refine interests or explore research
   activity. These are supporting tools, not the required search path.

If the network fails, **Rehearsal & example tools** contains saved real searches
for food storage, memory and plant health. `sample_data/verified_searches.json`
contains 45 genuinely retrieved records with source metadata and timestamps.
Loaded snapshots are explicitly labelled as saved, not fresh searches.
The separate example map contains invented, visibly labelled interface data; do
not present that map as scientific evidence or as a live search.

## Research activity maps

Topic volume, authors, citation attention, reviews, recent activity, free-to-read
links, institutions and publication years describe only retrieved records.
Counts are deduplicated per record; overlapping groups do not add to the sample
size. Identity is based on source IDs or ORCID; unresolved names are not merged
as if verified people. Citation counts from providers have differing coverage.
No count establishes consensus or how strongly a claim is supported. Review type
does not mean systematic review. Bubble area uses a disclosed logarithmic scale;
exact values and source-record drilldowns are available.

## Integration with the learning coach

`st.session_state.selected_paper` is a normalized dictionary containing the shared
paper fields plus discovery metadata. `topic` and `research_goal` are also retained.
The Learn button currently records selection and displays an integration notice.
Ru's classroom, quizzes and `services/teach.py` are not implemented or changed here.
The shared `models/schemas.py` remains unchanged. Agree on a conversion to the
shared Paper schema and wire navigation during joint integration.

## Validation

```bash
.venv-runtime/bin/python -m pytest -q
.venv-runtime/bin/python -m pip check
```

Tests cover metadata normalization, DOI merges, independent provider failures,
missing evidence, AI contracts, source-quote validation, secret headers, guided
search, rankings, bubble geometry, map counts, identity, saving and handoff.
Tests do not require API keys or a live network.

## Assistance disclosure

The students own and review the project. Codex assisted with the initial starter,
discovery implementation, source adapters, optional Gemini adapter, UI, tests and
documentation. Human review pending. Check the event's disclosure requirements.
Changes have not been committed or pushed.

## Tablet workspace navigation

The app now renders one step at a time: Question, Direction, Papers, Bubble map,
Saved and Sources. The touch-friendly sidebar can be collapsed with its header
arrow. Questions, edited search wording, filters and saved records survive step
changes. AI and rehearsal settings are grouped into sidebar expanders.

Results show two compact entries per page; Open paper opens a separate reading
screen with Abstract, Simple explanation and Source details tabs. Long abstract
text scrolls inside a bounded reading pane. The map has its own screen, its size
legend is expandable, and supporting record lists are paginated. This avoids
stacking the complete journey into one long page.
