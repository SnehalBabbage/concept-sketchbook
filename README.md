# Concept Sketchbook

Type a topic and get an editable concept map drawn as a rough draft, not an authority. An LLM reached through [OpenRouter](https://openrouter.ai) writes the first sketch; the learner then guesses, checks, doubts, edits and extends it.

It is a static site with no build step and no backend: plain HTML, CSS and ES modules. Maps live in the browser's storage; the OpenRouter key lives in session storage for the open tab only.

## Run locally

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173 and add an OpenRouter key in Settings (a free key works), or use **Sign in with OpenRouter**.

## Deploy

Any static host works. On GitHub Pages: push this folder to a repository, then in the repository's Settings → Pages choose "Deploy from a branch", branch `main`, folder `/ (root)`.

## How it works

| File | Role |
| --- | --- |
| `js/config.js` | Model chain, limits, relations and search sites. The model list is configuration, not code. |
| `js/openrouter.js` | `ask()`: the single POST to `/api/v1/chat/completions` with strict JSON schema, `require_parameters`, response healing, retry and model fallback. Also PKCE sign-in and free-model discovery. |
| `js/pipeline.js` | The staged generation: outline → draft details (batches of 10) → links → code-only check and layout. Gates for schema, size, links, shape and sources. Finished stages are kept so Retry resumes. |
| `js/layout.js` | Deterministic force layout. |
| `js/map.js` | SVG map: pencil-style marks, drag, pan, zoom, keyboard moves. |
| `js/app.js` | Panel, guess-first, check/doubt, editing, dialogs, import/export. |
| `js/sources.js` | Real references per concept: Wikipedia articles, and papers with DOIs from OpenAlex (Crossref as fallback). The AI never supplies these. |
| `js/store.js` | localStorage maps and settings, session-only key, daily call counter. |

A map costs 4 calls when nothing fails, and is capped at 8 calls per run. The app counts calls made today and stops before the daily cap set in Settings (50 by default, matching OpenRouter's free tier).

## Sample maps

`samples/` is a small static database of 13 ready-made maps that anyone can open without a key: `samples/index.json` lists them and each map is one JSON file in the app's export format. They are written in `samples/src/*.mjs` (concepts as `[name, group, explanation, caveat, test question, search phrases]`, links as `[from, relation, to]`) and built with:

```bash
node scripts/build-samples.mjs
```

The build holds every sample to the same gates as a generated map (14 to 30 concepts, explanations of 300 characters or fewer, valid relations, no URLs, every concept linked) plus full connectivity, then precomputes the layout. To add a sample, add an entry to a source file and rebuild. Opening a sample gives the viewer their own copy in browser storage.

## Privacy

Requests carrying user text go to openrouter.ai (the topic and the app's instructions) and, when a concept is opened, its name and search phrase go to Wikipedia, OpenAlex or Crossref to find references. Free models may train on prompts. The key is never written to maps, exports, URLs or logs.
