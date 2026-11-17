# ResearchBridge AI — paper discovery

A beginner enters an everyday question, chooses topic bubbles, and explores real
research records, source links, and background articles beside interactive maps.
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
- Guided examples for food storage, plant health, and memory. Other questions
  gain topic bubbles from terms found in a live preview of source records.
  When source metadata is sparse, editable keyword search remains available.
  This path is labelled and does not claim to be AI.
- Initial topic bubbles sized by matching records in a small live preview sample.
  Teal indicates a closer wording match to the question; purple is a broader
  direction. Neither color nor size measures research quality.
- A split results view: reading type and bubble lens on the left, source-backed
  items on the right. Tapping a bubble filters the item list. Lenses include
  topics, authors, countries, institutions, venues, citations, reviews, and years.
  Result bubble color uses supporting records' wording match to the search.
- Plus adds an item to its combination's reading list, and Remove takes it out.
  Start here, Best match, Newest and Free text order results. About shows a short
  source excerpt. Preview opens a scrollable pane with a reading-mode button.
  Research papers show retrieved abstracts; Wikipedia background articles can
  show their full text with attribution and a link to the source. Original page
  can display within the app when its publisher allows embedding.
- Reading workspace and Tahia's guided reading prompts for research records.

The retrieval budget is two search phrases, each queried against Crossref and
Europe PMC, plus one optional OpenAlex request if configured. Requests time out,
results are cached for 15 minutes, and at most 80 unique records are shown. A DOI
is deduplicated; preprint and published versions with different DOIs remain distinct.
A scholarly record can be a review, article, preprint, chapter or other work: type
labels do not establish peer review. Missing metadata remains unknown.

## Optional live AI — free-account token

The **Optional live AI** sidebar offers Hugging Face Inference Providers or Gemini.
The public paper search, bubbles, abstract reading guide and guided reflections
need no token. Live topic interpretation and abstract explanation need an account
token because hosted providers authenticate each request. Hugging Face is the
default; a free account has small monthly credits, and the app limits Hugging
Face requests to two per session. Use an account without purchased credits or
billing for the zero-cost demo. Model availability and credit amounts can change.
Tokens entered in the password fields remain in this Streamlit session and are
sent to the chosen provider in a request header. **Forget session key** clears
entered tokens; it does not remove a server-configured token.

Alternatively, copy `.streamlit/secrets.toml.example` to the ignored file
`.streamlit/secrets.toml` and set `HF_TOKEN` or `GEMINI_API_KEY` privately.
The configured token is not sent to the browser. Default Hugging Face model:
`Qwen/Qwen3-4B-Thinking-2507`; Gemini default: `gemini-2.5-flash-lite`.
The app does not load `.env` files.

- The selected AI provider proposes research directions, a clarification and concept
  definitions. It never supplies citation metadata.
- Paper-specific help is requested only with **Explain this abstract simply** on
  a retrieved record with an abstract. One short orientation is displayed with an
  exact source passage and reading suggestion, labelled as abstract-based AI help.
- Output validation rejects wrong fields, invented links, missing evidence quotes
  and unsupported numeric details. Quote presence is not a proof of entailment;
  a student still needs to check the original abstract and source.
- Input questions and selected abstracts are sent to the selected provider only when the
  corresponding AI feature is enabled and requested. Source text is treated as
  untrusted data. Calls are bounded and failures preserve ordinary paper search.

Google's free tier has account/model/region limits, and submitted content may be
used to improve its products. Use non-sensitive study questions. A key does not
itself guarantee zero charges if attached to a billing-enabled project; confirm the
project's tier and quota in AI Studio. No billing setup is required by this app.

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
[Hugging Face pricing](https://huggingface.co/docs/inference-providers/pricing)
[API keys](https://aistudio.google.com/api-keys)
[Crossref API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
[Europe PMC API](https://europepmc.org/RestfulWebService)

Optional `OPENALEX_API_KEY` supplements the public searches. It is no longer a
prerequisite for searching. No live Gemini call was possible during development
because no provider token was configured; the adapters and failure cases are tested
with mocked responses. Live scholarly retrieval was verified separately.

## Rehearse the demo

1. Enter “Why do I forget things I studied yesterday?”
2. Submit and choose the closest direction. Correct the wording if needed.
3. Select Find real papers; switch between reading types and bubble lenses.
4. Tap an author or topic bubble, preview an item, and add it to the combo list.
5. With Gemini enabled, request a simple abstract explanation and inspect the
   exact supporting passage. Explain that the full text was not analyzed.
6. Open the Vault to switch combinations. In reading mode, file items, link
   notes, and draw.

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

`st.session_state.selected_paper` keeps the normalized discovery record. The Learn
button also converts a record with a usable abstract into Tahia's shared `Paper`
model and opens her guided reading screen. Reflections stay in the Streamlit
session. The knowledge-check module and versioned Learning Coach contracts are
included locally. The Worker is a mock prototype, not a deployed AI agent.
Tahia's evidence-checked explanation pack is wired into the paper view when a
confirmed free Cloudflare or Groq provider is configured server-side; the existing
optional Gemini route remains available otherwise. No provider credentials are
bundled with the repository.

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

The app renders one step at a time: Question, Direction, Papers, Saved and
Sources. A slim icon strip stays visible. Each icon opens its own small floating
panel; the Vault icon lists saved topic combinations and opens a selected study
set. The theme button switches between dark and white/teal. Selected topic
circles slide to the right of one board. Up to 30 combinations can be saved,
renamed, removed and restored with Undo. The local app stores the vault under
`.researchbridge/`; its random URL token identifies the study sets. Bookmark
that page to return to them. A deployed version needs persistent server storage.

The results screen puts bubble lenses and reading types beside the item list.
Four items fit in the scrolling list at once. Counts describe only the retrieved
sample and are not scientific trust scores. Reading mode has folders, linked
note cards, pen drawing, Markdown note export, and an Original page tab when a
source link can be embedded. Notes and drawings stay in this browser; the app
does not download or annotate full PDFs. Combos and their reading lists survive
a new browser session when reopened through their vault URL.
