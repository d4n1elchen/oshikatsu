# Oshikatsu Tech Stack

This document defines the core technology stack for the Oshikatsu project. The platform is built entirely in **TypeScript / Node.js** to allow for strict type sharing across the ingestion pipeline, terminal interfaces, and future web frontends.

## Core Platform

- **Language:** TypeScript
- **Runtime:** Node.js (v20+)
- **Package Manager:** `npm` (or `pnpm`)
- **Validation & Typing:** `zod` (Used across the entire app for defining schemas, particularly the `Unified Event Schema`)

## Pipeline Components

### 1. Ingestion / Source Connectors
- **Scraping Engine:** `playwright` (Native Node.js API)
- **Why:** Best-in-class for headful browser automation, handles CDP network interception easily for extracting raw JSON/GraphQL from platforms like Twitter/X.

### 2. Normalization / LLM Parsing
- **Local Models:** `ollama` (Official Node.js SDK)
- **Structured Output:** We use Ollama's native structured output feature combined with Zod 4's built-in `z.toJSONSchema()` to guarantee the local model returns valid JSON matching our Zod schemas. (Earlier drafts of this doc referenced the standalone `zod-to-json-schema` package, which is no longer needed once Zod 4 ships the conversion natively.)
- **Validation Loop:** Currently a single-pass validation against the Zod schema, with strategy-level fallbacks for malformed output. An `instructor-js`-style retry/repair loop was considered but not adopted; see `TECH_DEBTS.md` for the open follow-up.

### 3. Storage
- **Database:** SQLite
- **Driver:** `better-sqlite3` (Extremely fast, synchronous driver perfect for local Node.js applications)
- **ORM / Query Builder:** `drizzle-orm` (Provides end-to-end type safety directly from database to TypeScript models).

### 4. Orchestration / Scheduling
- **Task Runner:** `node-cron` or native `setInterval` workers.

## User Interfaces

### Terminal UI (TUI)
- **Framework:** `ink`
- **Why:** `ink` brings the React component model (JSX, Hooks, State) to the terminal. This lets us build interactive dashboards in the same mental model and component shape we use for the Web UI, so logic stays portable across surfaces.

### Web UI (Phase 8)
- **Frontend Framework:** `Next.js` or `Vite + React`
- **Backend API:** `Hono` or `Express` (or Next.js Server Actions if going Next.js).
- **Why:** The TUI and the Web UI **coexist** — neither replaces the other. Both surfaces read and write the same SQLite database through the same `core/` modules (`WatchListManager`, `EventResolver`, `ExportRunner`, etc.); each adds only its own thin presentation layer. Choosing React for both keeps state and component patterns shareable.

## Environment & User Rules Override

*Note: While the global user rules mention using `.venv` and `requirements.txt`, an explicit architectural decision was made on 2026-04-23 to build Oshikatsu in Node.js/TypeScript due to its superior Playwright integration, shared types with the future Web UI, and the excellent `ink` TUI framework.*
