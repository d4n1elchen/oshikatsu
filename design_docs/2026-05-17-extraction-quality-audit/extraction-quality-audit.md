# Extraction Quality Audit

> **Status:** Proposed — findings from a 2026-05-17 review of the current `extracted_events` corpus (45 events + 11 annotations across 18 normalized events). No code changes yet; this doc proposes prompt and pipeline changes for discussion.
> **Follow-ups:** Each numbered proposal below should land as its own TECH_DEBTS.md entry once accepted.

## Scope

Reviewed every row in `extracted_events` against its source `raw_items.rawData` and the prompt rules in [src/core/ExtractionStrategy.ts:131](../../src/core/ExtractionStrategy.ts). The corpus is small but homogenous (all 花譜 / KAMITSUBAKI Twitter posts), so the same defects repeat and the failure modes are easy to see.

## Headline numbers

| Metric | Value | Notes |
|---|---|---|
| Events with `start_time` | 16 / 45 (36%) | Of those, **10 / 16 (63%) carry the wrong year** — see F1. |
| `release` events with `start_time` | 2 / 17 (12%) | F2 |
| `concert` events with `start_time` | 3 / 10 (30%) | F2 |
| Events with `venue_url` | 2 / 45 (4%) | F4 |
| Events with `venue_name` | 12 / 45 (27%) | F4 |
| Annotations attached to a parent | 2 / 11 (18%) | F3 — `annotation_no_match` decided for 9 of 11. |

## Findings, severity-ordered

### F1 — CRITICAL: wrong year on every inferred date

10 of the 16 events that have a `start_time` resolved to **2024** even though the source tweets were posted in **2026**. The LLM has no current-date anchor in the prompt, so it falls back on training-cutoff defaults.

Examples (`start_time` → what it should be):

| Source post | LLM emitted | Calendar truth |
|---|---|---|
| `5/16(土曜)19:00（日本時間）` | `2024-05-16 19:00 JST` | 2026-05-16 is a Saturday; 2024-05-16 was a Thursday |
| `4月30日(木) 20:00~` (#琶舞1周年) | `2024-04-30 20:00` | 2026-04-30 is a Thursday |
| `5/18(月)19時から` (神椿TCG倶楽部) | `2024-05-18 19:00` | 2026-05-18 is a Monday |
| `5/1-5/7の毎日12時` (GW特別投稿) | `2024-05-01 12:00` | Posted 2026-04-30, run is GW 2026 |

Every wrong-year row is silently wrong: the timestamp parses, the timezone is correct, only the year is off — and that's exactly the kind of error that survives all downstream validation.

**Proposal P1:** Inject the source post's `created_at` into the prompt as an explicit anchor, and require the LLM to resolve year-less dates *relative to that anchor* (next future occurrence within 12 months). Concretely:

- Add a `Source posted at: 2026-05-17T18:00:00+09:00` line to [buildPrompt](../../src/core/ExtractionStrategy.ts:130) above "Input text".
- Add a rule under "Event branch": *"When the source omits a year, choose the next occurrence of the stated month/day on or after the source post date. Do not emit a date that precedes the source post date by more than 7 days."*
- Add a sanitizer guard in [DefaultExtractionStrategy.sanitize](../../src/core/ExtractionStrategy.ts:193) that rejects `start_time` more than 7 days before `publishTime` (defensive against future model drift).

### F2 — CRITICAL: explicit dates and venues dropped from concerts and releases

Concerts where the source post states the date and venue inline are still landing with `start_time = NULL`:

| Source fragment | Extracted `start_time` | Extracted `venue_name` |
|---|---|---|
| `9 / 5 (土) 「KAMITSUBAKI FES '26 FIELD OF RESONANCE」　@パシフィコ横浜 国立大ホール` | NULL | "パシフィコ横浜 国立大ホール" ✓ |
| `9.6 Sun. パシフィコ横浜 国立大ホール 花譜 5th ONE-MAN LIVE` | NULL | "パシフィコ横浜 国立大ホール" ✓ |
| `7/24-26にカルフォルニア州サンノゼ` (OffKai Expo) | NULL | NULL |
| `9.5 Sat. / 9.6 Sun. パシフィコ横浜 国立大ホール` (#神椿横浜戦線2026) | NULL | "パシフィコ横浜 国立大ホール" ✓ |

The venue capture works most of the time when the venue is named explicitly with a clear marker (`@`, `at`). The date capture does not — even when the month/day are explicit (`9.5 Sat.`, `9 / 5 (土)`). This is closely tied to F1: the LLM seems to be refusing to emit dates it can't anchor to a year, instead of emitting the next-occurrence year per P1.

**Proposal P2:** Adopt P1 first; re-measure. If concert `start_time` rates don't lift to >80%, add a worked example to the prompt:

> *Source: "9.5 Sat. パシフィコ横浜 国立大ホール" (posted 2026-05-17)*
> *start_time: "2026-09-05T00:00:00+09:00"* (date-only, midnight JST; end_time omitted)

The current prompt has no time-only/date-only example. Multi-day events (e.g. `7/24-26`) also have no example — should produce `start_time = day 1 midnight`, `end_time = day 3 23:59`. Add that too.

### F3 — HIGH: annotation reconciliation 82% failure rate

Of 11 annotations, 9 land in `event_resolution_decisions.decision = 'annotation_no_match'`. The root causes are structural, not tuning:

| `parent_event_hint` | Why no match |
|---|---|
| `GW特別投稿` | Series umbrella — every clip in the run was extracted as its *own* event ("「私論理」━「宿声 / 深愛」Live Ver.━" etc.). The umbrella has no row, so milestones/recaps for the series have nothing to attach to. |
| `ヰ世界情緒ちゃんのワンマンライブ「Anima Re:birth」` | Different artist's event — no watch_target → no parent in our DB. |
| `コラボ企画「#組曲2」第九弾` / `…「放課後ボーダーライン」` / `#組曲2` / 5 variants total | Hint phrasing drifts per post. Resolver does exact-ish matching; "コラボ企画「#組曲2」第九弾" doesn't match the row titled "コラボ企画「#組曲2」第九弾「放課後ボーダーライン」プレイリストイン". |

Three distinct problems, three proposals:

#### P3a — Series membership via `series_name`, not parent hierarchy

GW特別投稿 (7-episode Golden Week run), Singing My Favorite Songs (#1–#145+), コラボ企画「#組曲2」 (multi-installment collab), 未確認少女観測部 (membership stream vol.N) — all share the shape *"N siblings that belong together, sometimes with an announcement post, sometimes recurring open-endedly."*

A parent-event hierarchy (using `normalizedEvents.parentEventId`) works in theory but breaks in practice for two reasons:

1. **Open-ended series** (Singing My Favorite Songs) have no useful parent event — the "series" doesn't happen at a time. A 145-deep chain with a semantically empty root adds no value.
2. **Cold-start** — when we begin scraping mid-campaign, the announcement post is already gone. The would-be parent never gets extracted. Synthesizing a parent at the resolver from N orphans introduces sync drift (what happens when one child is cancelled? when the synthesized parent's "expected count" turns out wrong?).

Instead, add `series_name: text` to both `extracted_events` and `normalized_events`. No `series` table — series metadata (date range, episode count, "is complete") is derived on read by aggregating siblings sharing a `series_name`. If that aggregation ever gets expensive, promote `series_name` to an FK against a real table; the migration is mechanical.

Prompt changes:
- *"When a title contains a series marker (`#N`, `vol.N`, `第N回`, `第N弾`, `N本目`), extract the series name into `series_name`. Keep `event_scope=main`; the series is a grouping, not a parent event."*
- *"Examples of `series_name`: `Singing My Favorite Songs`, `GW特別投稿`, `未確認少女観測部`, `コラボ企画「#組曲2」`. Strip the episode number; keep series-defining quoted titles."*

Cold-start consequence accepted explicitly: a campaign joined mid-flight will be shown as "GW特別投稿 · episodes 3–7 seen", missing 1–2 and any end-date from the announcement. This is the same gap any fan calendar has when joining a fandom mid-campaign, and it doesn't compound — each new episode arrives complete in itself.

#### P3b — Annotation matching falls back to `series_name`

Once `series_name` exists, annotations whose `parent_event_hint` references a series umbrella can match. New resolver order:

1. Title-similarity match against existing event titles (current behavior, plus P3c fuzziness fix below).
2. If no title match: fuzzy-match `parent_event_hint` against `series_name` across events. If hit, attach to the *most recent* event in that series at the time of the annotation's `publish_time`. Final-episode markers ("ラスト", "最終回") prefer the matched episode if the LLM flagged it.
3. If still no match: `annotation_no_match`, as today.

Concrete: "GW特別投稿ラスト" (publish 2026-05-07) → no title match → series_name match on "GW特別投稿" → attach to 7本目 (final episode, posted same day).

#### P3c — Cross-artist hints should not enter the annotation queue

`ヰ世界情緒ちゃんのワンマンライブ「Anima Re:birth」` will never match because Anima Re:birth's artist isn't in `watch_targets`. Leaving these in `annotation_no_match` permanently pollutes the queue and never resolves.

Two choices:
- **Drop at extraction time:** the LLM tells us when a `parent_event_hint` references a different artist (we can pass the watch-list artist names into the prompt as context, and ask the LLM to flag `parent_is_external=true`). Those rows skip annotation extraction entirely and become `not_an_event` with a new category `external_event_reference`.
- **Defer to admin surface:** keep them as `annotation_no_match` but expose a "cross-artist references" view so an operator can decide.

Recommend the first — cheaper, doesn't grow an admin queue.

#### P3d — Asymmetric containment in `titleSimilarity` (LANDED)

**Audit's original framing was wrong.** I claimed the annotation matcher "doesn't use titleSimilarity at all" — it always did, at the same 0.6 threshold the event resolver uses. The real bug was at the scoring level: `substringScore` divided by the **longer** string's length, so a hint that was a strict prefix of a full event title was penalized for the title's added detail.

The F3 case `コラボ企画「#組曲2」第九弾` vs `コラボ企画「#組曲2」第九弾「放課後ボーダーライン」プレイリストイン` scored ~0.54 (= 19/35), just below 0.6. Asymmetric containment — score full containment of the shorter string in the longer one as 1 — fixes it. Shipped in [602e73e](../../src/core/titleSimilarity.ts).

The same fix applies to event-merge scoring (single shared function), which is the right tradeoff — event resolution has other signals (artist, time, venue) that dampen over-merge risk, and the audit's other findings note the resolver is *under-*merging more than over-merging.

#### Bonus that landed alongside: AnnotationReconciler merged into EventResolver

While auditing P3d, the two passes turned out to be doing the same thing with different downstream actions: load extracted rows → find best same-artist normalized event by hint similarity → write a source row + decision row. They lived as separate classes only because annotation reconciliation [landed later](../2026-05-14-annotation-reconciliation/) as its own pass. The daemon already ran them back-to-back in the same scheduled task with a comment explaining why the order mattered — a workaround for the split.

`AnnotationReconciler` is now folded into `EventResolver`, with `findParentByHint` ([titleSimilarity.ts](../../src/core/titleSimilarity.ts)) as the shared matcher used by both annotation attachment and sub-event hierarchy. The daemon's Resolution task is a single `processBatch` call. This isn't a "fix" per the original audit, but it eliminated the duplication that made my P3d framing wrong in the first place.

### F4 — HIGH: `venue_url` set on 4% of events

`venue_name` is captured 27% of the time; `venue_url` only 4%. The two events that *do* have URLs both used `t.co/...` shortlinks (the post's embedded URL) — there's no enrichment step that resolves "パシフィコ横浜 国立大ホール" → `https://www.pacifico.co.jp/`.

The `venues` table and `venueAliases` table exist for exactly this. Looking at the schema, the resolver/sanitizer doesn't appear to consult `venue_aliases` to upgrade a freshly-extracted `venue_name` into a known venue with a known URL.

**Proposal P4:** In the extraction pipeline (after sanitize, before insert), look up `extracted.venue_name` against `venue_aliases.alias`. If a match exists, populate `venue_id` and inherit `venue_url` / `city` / etc. from the matched `venues` row. Net-new venues (no alias match) stay as free-text `venue_name`, status `discovered`, for admin review. This is what the venue tables are for — they're not being read in the extraction path right now (verify in [VenueResolver.ts](../../src/core/VenueResolver.ts)).

### F5 — MEDIUM: tag normalization is absent

The sanitizer only trims tags ([ExtractionStrategy.ts:213](../../src/core/ExtractionStrategy.ts:213)). Observed in the corpus:

- Hash prefix inconsistency: `#神椿フェス2026` and `神椿フェス` coexist; `#花譜` and `花譜`; `#interfm` and `interfm`.
- Casing drift: `OffKai Expo` and `Offkai Expo` are stored as distinct tags.
- Curly vs straight quotes: `KAMITSUBAKI FES '26` (curly) and `KAMITSUBAKI FES '26` (straight) — straight from the same event, two different rows.
- Tag taxonomy is undefined: artist names, song titles, hashtags, platform names, and campaign names are all mixed into one flat list.

**Proposal P5 (low-cost):** Add to the sanitizer:
- Strip leading `#`.
- NFKC-normalize (collapses curly→straight quotes, full-width→half-width).
- Case-fold *for dedup only*, preserve original case for display.

**Proposal P5b (deferred):** Decide whether tags need a typed structure (artist / song / platform / hashtag / campaign) or stay flat. The current data doesn't strongly motivate it, but the web UI's filter design (see [2026-05-08-phase6-web-ui](../2026-05-08-phase6-web-ui/)) might.

### F6 — MEDIUM: `type` column holds annotation categories

All 11 annotation rows have `type` set to `recap` or `milestone` — values not in `EVENT_TYPES`. The schema column [extractedEvents.type](../../src/db/schema.ts:108) is unconstrained `text`, and the persistence layer is reusing it for annotation categories.

This works, but it means:
- Any query like `WHERE type = 'release'` silently excludes annotations correctly only because nobody chose to call an annotation category `release` (yet).
- Adding a new annotation category that collides with an event type would corrupt downstream filters silently.
- Readers of the schema reasonably assume `type` is the 7-type taxonomy.

**Proposal P6:** Add an `annotation_category` column ([schema.ts:97](../../src/db/schema.ts:97)) typed as the `ANNOTATION_CATEGORIES` enum, and keep `type` for events only (null for annotations). Migration is mechanical: backfill from existing `type` values where `record_kind='annotation'`, then null out `type` for annotation rows.

### F7 — LOW: related-link deduplication

The "Singing My Favorite Songs # 145" row has both `https://t.co/w4D7rYl7Oe` *and* its resolved target `https://youtu.be/y7K40RsT824` in `related_links`. The Twitter strategy already extracts both the shortlink and the expanded URL — the merger ([mergeRelatedLinks](../../src/core/ExtractionStrategy.ts:209)) keys on raw URL and doesn't know they're equivalent.

**Proposal P7:** In `mergeRelatedLinks`, prefer the expanded URL when both are present (the Twitter GraphQL payload always provides both via `expanded_url` / `url`). Also: drop `t.co/...` links whose only purpose is to attach an embedded image (no event-relevant destination).

### F8 — LOW: release-type `start_time` blocked by overly-strict rule

The Singing My Favorite Songs cover went live on YouTube *at the moment of the tweet*. The current rule ([ExtractionStrategy.ts:154](../../src/core/ExtractionStrategy.ts:154)) — *"Do not use the source publish time as start_time"* — was written for the scheduled-concert case where a tweet days in advance shouldn't anchor the event to itself. For a release that *is* the announcement of a just-published artifact, the publish time IS the event time.

**Proposal P8:** Carve out a `type=release` exception in the prompt: *"For `release` events whose source post links to the released artifact (YouTube upload, music platform link, etc.) and contains no separate scheduled time, set `start_time` to the source post time."* Sanitizer can leave this enforcement to the LLM.

## Recommended landing order

1. ✅ **P1 (date anchor)** — landed [723cbae](../../src/core/ExtractionStrategy.ts). Single prompt addition + sanitizer guard.
2. **P2 (worked examples)** — measure against P1 first; only land if P1 alone doesn't lift concert/release `start_time` rates.
3. **P4 (venue alias lookup)** — wires up existing tables, no model changes. High-impact on UI usability.
4. ✅ **P3d (asymmetric containment)** — landed [602e73e](../../src/core/titleSimilarity.ts) alongside the resolver merge.
5. **P3a + P3b (series_name + series-fallback annotation match)** — schema + prompt + resolver. Biggest structural gain on annotation rate; together because P3b depends on P3a's column.
6. **P3c (cross-artist drop)** — only land if cross-artist annotations remain a meaningful slice of the no-match queue after P3a+b. Possibly never needed.
7. **P6 (annotation_category column)** — schema hygiene; do before any downstream consumer starts reading `type` for annotations.
8. **P5, P7, P8** — quality-of-life; bundle.

## What this audit did not cover

- Cross-source corpus (only Twitter posts exist today).
- Resolver merge correctness beyond annotation matching — duplicates seem to merge well (3→1 for FIELD OF RESONANCE, 4→1 for 私論理) but a deeper false-merge / false-split audit is its own doc.
- Embedding-based similarity (`event_embeddings` is populated but I didn't sample similarity quality).
- Export queue / iCal output fidelity.
