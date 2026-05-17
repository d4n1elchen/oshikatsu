# oshikatsu

A local-first pipeline that tracks fan-favorite artists (singers, Vtubers, idols, voice actors), collects their announcements from social sources, and resolves them into a unified canonical event feed for downstream automation (calendars, notifications, …).

Everything runs on your machine: scraping via headful Playwright, structured extraction via local LLMs through [Ollama](https://ollama.com), SQLite for storage, and an opt-in local embedding signal for cross-script duplicate detection.

See [PROJECT_VISION.md](PROJECT_VISION.md) for goals and [ARCHITECTURE.md](ARCHITECTURE.md) for the pipeline shape.

## Prerequisites

- **Node.js ≥ 22** (uses `Intl.Segmenter` and `node --test --import tsx/esm`). An `.nvmrc` pins 22.
- **Ollama** running locally — needed for LLM extraction and (optionally) embeddings.
- **Playwright** browsers — `npx playwright install chromium` after `npm install`.

## Quick start

```bash
npm install
cp config.yaml.example config.yaml      # edit as needed
npm run db:migrate

# Pull the LLM used for extraction (default model name is set in config.yaml)
ollama pull llama3

# Sign into Twitter/X once (headful — opens a browser)
npm run login:twitter

# Run the daemon (ingestion + extraction + resolution loops)
npm run start:backend
```

There's also a TUI and a web admin surface:

```bash
npm run start:tui      # ink-based terminal UI
npm run web:dev        # vite + hono dev server
```

One-shot scripts for debugging:

```bash
npm run extract:once    # process unextracted raw_items once and exit
npm run resolve:once    # run a single resolution pass
npm run reset           # interactive DB reset (per-table flags also available, see package.json)
```

## Embedding model (optional)

The resolver has an opt-in embedding-based similarity signal that catches **cross-script duplicates** the deterministic tokenizer can't see (e.g. "花譜" ↔ "KAF", "ぼっち・ざ・ろっく" ↔ "Bocchi the Rock"). It runs entirely locally through Ollama, so there is no external API cost.

**Default model: [`bge-m3`](https://ollama.com/library/bge-m3)** — multilingual (strong Japanese + English), 1024-dim, ~1.2 GB. On Apple Silicon it runs on Metal automatically.

To enable:

```bash
ollama pull bge-m3
```

```yaml
# config.yaml
embeddings:
  enabled: true
  model: "bge-m3"        # any Ollama embedding model
  cosineThreshold: 0.75  # cosine below this contributes nothing to the score
```

**How it's used:**

- After the resolver creates a new normalized event, it embeds `title | venue_name` via Ollama and caches the vector in the `event_embeddings` SQLite table.
- During each resolution, the extracted event's text is embedded once; cached vectors for same-artist candidates are batch-loaded; cosine is computed in JS (no vector index — candidate sets are tiny after artist + time filtering).
- The cosine contributes to `scoreMatch` only when same-artist holds and the time window is plausible. Weights and thresholds: see [design_docs/2026-04-25-phase3-event-resolution/event-resolution.md](design_docs/2026-04-25-phase3-event-resolution/event-resolution.md#embedding-signal).

**Failure mode:** if Ollama is unreachable or the model isn't pulled, the signal is silently skipped and resolution falls back to deterministic signals. Nothing crashes; you just get the pre-embedding behavior.

**Cache invalidation:** the `model` is stored alongside each cached vector. Switching `embeddings.model` causes stale rows to be ignored on read; they'll be replaced as events are touched again. There is no scheduled backfill — see [TECH_DEBTS.md](TECH_DEBTS.md) for that follow-up.

## Configuration

All runtime config lives in `config.yaml` at the repo root (gitignored). `config.yaml.example` is the documented template. Defaults are in [src/config.ts](src/config.ts).

Notable sections:

- `llm.model` — Ollama model used for structured extraction.
- `resolution` — thresholds for auto-merge / needs-review / candidate window.
- `embeddings` — see above.
- `export.ical` — when enabled, the resolver writes per-artist `.ics` files.
- `defaultTimezone` — fallback IANA TZ for offset-less timestamps the LLM emits.

## Repo layout

```
src/
  core/            pipeline modules (ingestion, extraction, resolution, export)
  db/              drizzle schema + migrations
  web/             hono API + vite + react admin surface
  tui/             ink-based TUI
  scripts/         one-shot CLIs
  daemon.ts        main entry point — runs scheduler loops
design_docs/       phase-by-phase design notes
data/              SQLite database + iCal output (gitignored)
```

## Tests

```bash
npm run test         # typecheck + unit tests
npm run typecheck    # tsc --noEmit only
npm run test:unit    # node --test (no typecheck)
```

The test suite is hermetic — uses in-memory SQLite, deterministic fixtures, no network. The embedding signal is tested with `FixedEmbeddingService` (deterministic vectors), not by hitting Ollama.

## Further reading

- [PROJECT_VISION.md](PROJECT_VISION.md) — goals and target focus
- [ARCHITECTURE.md](ARCHITECTURE.md) — pipeline shape, signals, persistence
- [TECH_STACK.md](TECH_STACK.md) — language/library choices and rationale
- [TECH_DEBTS.md](TECH_DEBTS.md) — known follow-ups
- [design_docs/](design_docs/) — phase-by-phase design records
