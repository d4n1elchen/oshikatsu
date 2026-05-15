import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import {
  eventResolutionDecisions,
  extractedEvents,
  normalizedEventSources,
  normalizedEvents,
} from "../db/schema";
import { tagged } from "./logger";
import { titleSimilarity } from "./titleSimilarity";

const log = tagged("AnnotationReconciler");

type DbInstance = typeof defaultDb;

export type AnnotationReconcilerThresholds = {
  /** Minimum similarity for an annotation to attach to a parent event. */
  matchThreshold: number;
  /** Required margin between top-1 and top-2 similarity. Below this, defer. */
  ambiguityMargin: number;
};

const DEFAULT_THRESHOLDS: AnnotationReconcilerThresholds = {
  matchThreshold: 0.6,
  ambiguityMargin: 0.05,
};

type AnnotationRow = {
  id: string;
  artistId: string | null;
  parentEventHint: string | null;
};

/**
 * Attaches annotation extracted_events (record_kind='annotation') to their
 * parent normalized_event by fuzzy-matching `parent_event_hint` against the
 * canonical title within the same artist. Writes a `normalized_event_sources`
 * row with role='annotation' and an `event_resolution_decisions` row keyed
 * by the same `candidate_extracted_event_id`.
 *
 * Idempotent: an annotation with either an attached source row or a
 * persisted no_match decision is skipped. Annotations whose candidate set
 * is empty (artist has no normalized events yet) stay deferred and retry
 * on the next tick.
 */
export class AnnotationReconciler {
  private db: DbInstance;
  private thresholds: AnnotationReconcilerThresholds;

  constructor(db: DbInstance = defaultDb, thresholds?: Partial<AnnotationReconcilerThresholds>) {
    this.db = db;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  async processBatch(
    limit = 50,
    signal?: AbortSignal
  ): Promise<{ attached: number; noMatch: number; deferred: number; failed: number }> {
    const unattached = await this.loadUnattachedAnnotations(limit);

    let attached = 0;
    let noMatch = 0;
    let deferred = 0;
    let failed = 0;

    for (const row of unattached) {
      if (signal?.aborted) {
        log.info(
          `Aborted; ${attached} attached, ${noMatch} no_match, ${deferred} deferred, ${failed} failed before bail-out`
        );
        break;
      }
      try {
        const outcome = await this.reconcile(row);
        if (outcome === "attached") attached++;
        else if (outcome === "no_match") noMatch++;
        else deferred++;
      } catch (e) {
        log.error(`Failed to reconcile annotation ${row.id}:`, e);
        failed++;
      }
    }

    if (attached > 0 || noMatch > 0 || failed > 0) {
      log.info(
        `Attached ${attached}; no_match ${noMatch}; deferred ${deferred}; failed ${failed}`
      );
    }

    return { attached, noMatch, deferred, failed };
  }

  private async loadUnattachedAnnotations(limit: number): Promise<AnnotationRow[]> {
    // An annotation is unattached if it has no normalized_event_sources row
    // (role='annotation') AND no terminal decision row. We pick deferred and
    // never-seen rows; rows that already attached or earned a permanent
    // no_match are filtered out.
    return this.db
      .select({
        id: extractedEvents.id,
        artistId: extractedEvents.artistId,
        parentEventHint: extractedEvents.parentEventHint,
      })
      .from(extractedEvents)
      .where(
        sql`${extractedEvents.recordKind} = 'annotation'
            AND ${extractedEvents.id} NOT IN (
              SELECT ${normalizedEventSources.extractedEventId}
              FROM ${normalizedEventSources}
              WHERE ${normalizedEventSources.role} = 'annotation'
            )
            AND ${extractedEvents.id} NOT IN (
              SELECT ${eventResolutionDecisions.candidateExtractedEventId}
              FROM ${eventResolutionDecisions}
              WHERE ${eventResolutionDecisions.decision} = 'annotation_no_match'
            )`
      )
      .limit(limit);
  }

  private async reconcile(row: AnnotationRow): Promise<"attached" | "no_match" | "deferred"> {
    // Without an artist anchor or hint we cannot safely match — defer.
    // The hint is required for annotation rows at extraction time, but
    // be defensive in case the contract slips.
    if (!row.artistId || !row.parentEventHint || !row.parentEventHint.trim()) {
      return "deferred";
    }

    const candidates = await this.db
      .select({ id: normalizedEvents.id, title: normalizedEvents.title })
      .from(normalizedEvents)
      .where(eq(normalizedEvents.artistId, row.artistId));

    if (candidates.length === 0) {
      // Brand-new artist with no canonical events yet. Stay deferred so a
      // future tick (once events exist) can attach this annotation. We
      // deliberately do not write annotation_no_match here — that would
      // permanently strand annotations that arrive ahead of their events.
      return "deferred";
    }

    const scored = candidates
      .map((c) => ({ id: c.id, title: c.title, score: titleSimilarity(row.parentEventHint!, c.title) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0]!;
    const runnerUp = scored[1];

    const aboveThreshold = best.score >= this.thresholds.matchThreshold;
    const ambiguous =
      runnerUp !== undefined &&
      runnerUp.score >= this.thresholds.matchThreshold &&
      best.score - runnerUp.score < this.thresholds.ambiguityMargin;

    if (!aboveThreshold) {
      await this.recordNoMatch(row, best, scored.slice(0, 5));
      return "no_match";
    }

    if (ambiguous) {
      // Top two candidates are within the margin — likely a tour with
      // multiple near-identical stops. Defer rather than guess; a stronger
      // hint or new tiebreaker signal may resolve it on a future tick.
      return "deferred";
    }

    await this.attach(row, best, scored.slice(0, 5));
    return "attached";
  }

  private async attach(
    row: AnnotationRow,
    best: { id: string; title: string; score: number },
    topCandidates: { id: string; title: string; score: number }[]
  ): Promise<void> {
    const now = new Date();
    await this.db.transaction((tx) => {
      tx.insert(normalizedEventSources).values({
        id: randomUUID(),
        normalizedEventId: best.id,
        extractedEventId: row.id,
        role: "annotation",
        createdAt: now,
      }).run();

      tx.insert(eventResolutionDecisions).values({
        id: randomUUID(),
        candidateExtractedEventId: row.id,
        matchedNormalizedEventId: best.id,
        decision: "annotation_attached",
        score: best.score,
        signals: {
          parent_event_hint: row.parentEventHint,
          candidates: topCandidates.map((c) => ({ id: c.id, title: c.title, score: c.score })),
        },
        reason: `Hint "${row.parentEventHint}" matched "${best.title}" (sim=${best.score.toFixed(2)}).`,
        createdAt: now,
      }).run();
    });
    log.info(`Attached annotation ${row.id} → normalized ${best.id} (sim=${best.score.toFixed(2)})`);
  }

  private async recordNoMatch(
    row: AnnotationRow,
    best: { id: string; title: string; score: number },
    topCandidates: { id: string; title: string; score: number }[]
  ): Promise<void> {
    await this.db.insert(eventResolutionDecisions).values({
      id: randomUUID(),
      candidateExtractedEventId: row.id,
      matchedNormalizedEventId: null,
      decision: "annotation_no_match",
      score: best.score,
      signals: {
        parent_event_hint: row.parentEventHint,
        candidates: topCandidates.map((c) => ({ id: c.id, title: c.title, score: c.score })),
      },
      reason: `No canonical event scored above threshold; best was "${best.title}" (sim=${best.score.toFixed(2)}).`,
      createdAt: new Date(),
    }).run();
  }
}

