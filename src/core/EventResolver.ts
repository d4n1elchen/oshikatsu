import { randomUUID } from "crypto";
import { and, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import {
  extractedEventRelatedLinks,
  extractedEvents,
  eventResolutionDecisions,
  normalizedEvents,
  normalizedEventSources,
} from "../db/schema";
import { ExportQueueRepo } from "./ExportQueueRepo";
import { titleSimilarity } from "./titleSimilarity";
import type { ResolutionSignals, ResolutionDecisionType } from "./types";
import { getConfig } from "../config";
import { tagged } from "./logger";
import { EmbeddingsRepo } from "./EmbeddingsRepo";
import { cosineSimilarity } from "./EmbeddingService";

const log = tagged("EventResolver");

export type EventResolverThresholds = {
  titleSimilarityThreshold: number;
  autoMergeScoreThreshold: number;
  needsReviewScoreThreshold: number;
  candidateWindowMs: number;
};

function defaultThresholds(): EventResolverThresholds {
  const cfg = getConfig().resolution;
  return {
    titleSimilarityThreshold: cfg.titleSimilarityThreshold,
    autoMergeScoreThreshold: cfg.autoMergeScoreThreshold,
    needsReviewScoreThreshold: cfg.needsReviewScoreThreshold,
    candidateWindowMs: cfg.candidateWindowHours * 60 * 60 * 1000,
  };
}

type ExtractedEventRow = typeof extractedEvents.$inferSelect;
type NormalizedEventRow = typeof normalizedEvents.$inferSelect;
type RelatedLinkRow = typeof extractedEventRelatedLinks.$inferSelect;
type DbInstance = typeof defaultDb;

type ResolutionResult = {
  decision: ResolutionDecisionType;
  normalizedEventId: string | null;
  signals: ResolutionSignals;
  reason: string;
  score: number;
  /** Optional free-text note carried through to the audit row. Used by
   *  operator-initiated decisions; auto-resolver leaves this undefined. */
  note?: string | null;
};

export class EventResolver {
  private db: DbInstance;
  private thresholds: EventResolverThresholds;
  private exportQueue: ExportQueueRepo | null;
  private embeddings: EmbeddingsRepo | null;

  constructor(
    db: DbInstance = defaultDb,
    thresholds?: Partial<EventResolverThresholds>,
    exportQueue: ExportQueueRepo | null = null,
    embeddings: EmbeddingsRepo | null = null
  ) {
    this.db = db;
    this.thresholds = { ...defaultThresholds(), ...thresholds };
    this.exportQueue = exportQueue;
    this.embeddings = embeddings;
  }
  /**
   * Resolve a single extracted event: match against existing normalized events,
   * create a new canonical event, or flag for review.
   */
  async resolve(extractedEventId: string): Promise<void> {
    const [candidate] = await this.db
      .select()
      .from(extractedEvents)
      .where(eq(extractedEvents.id, extractedEventId))
      .limit(1);

    if (!candidate) {
      log.warn(`Extracted event ${extractedEventId} not found`);
      return;
    }

    // Skip if already resolved
    const existing = await this.db
      .select({ id: eventResolutionDecisions.id })
      .from(eventResolutionDecisions)
      .where(eq(eventResolutionDecisions.candidateExtractedEventId, extractedEventId))
      .limit(1);

    if (existing.length > 0) {
      log.info(`Event ${extractedEventId} already resolved; skipping`);
      return;
    }

    const candidateLinks = await this.getRelatedLinks(extractedEventId);
    const normalizedCandidates = await this.selectNormalizedCandidates(candidate, candidateLinks);

    // Embedding signal: compute query vector once, batch-load candidates'
    // cached vectors. Best-effort — failures degrade to "no cosine signal".
    let extractedVec: Float32Array | null = null;
    let candidateVecs = new Map<string, Float32Array>();
    if (this.embeddings && this.embeddings.enabled() && normalizedCandidates.length > 0) {
      extractedVec = await this.embeddings.embedQuery({
        title: candidate.title,
        venueName: candidate.venueName,
      });
      if (extractedVec) {
        candidateVecs = this.embeddings.loadForNormalizedEvents(
          normalizedCandidates.map((c) => c.id)
        );
      }
    }

    let result = await this.decideResolution(candidate, candidateLinks, normalizedCandidates, extractedVec, candidateVecs);

    // Phase 3.1 hierarchy resolution: if no merge match, try sub-event linking.
    if (
      (result.decision === "new" || result.decision === "no_match") &&
      candidate.eventScope === "sub"
    ) {
      const hierarchyResult = await this.tryHierarchyResolution(candidate);
      if (hierarchyResult) {
        result = hierarchyResult;
      }
    }

    await this.applyDecision(candidate, candidateLinks, result);
  }

  /**
   * Manually accept a needs_review item as a merge into the matched
   * normalized event. Supersedes any prior decision for this extracted
   * event (the prior row stays, marked with `superseded_at`).
   */
  async acceptAsMerge(
    extractedEventId: string,
    normalizedEventId: string,
    note?: string | null
  ): Promise<void> {
    const [candidate] = await this.db
      .select()
      .from(extractedEvents)
      .where(eq(extractedEvents.id, extractedEventId))
      .limit(1);
    if (!candidate) throw new Error(`Extracted event ${extractedEventId} not found`);

    const candidateLinks = await this.getRelatedLinks(extractedEventId);

    await this.applyDecision(candidate, candidateLinks, {
      decision: "merged",
      normalizedEventId,
      score: 1,
      signals: { manual_override: true },
      reason: "Manually accepted as merge from review queue.",
      note: note ?? null,
    });
  }

  /**
   * Manually mark a needs_review item as a new canonical event.
   * Supersedes any prior decision (the prior row stays, marked with
   * `superseded_at`).
   */
  async acceptAsNew(extractedEventId: string, note?: string | null): Promise<void> {
    const [candidate] = await this.db
      .select()
      .from(extractedEvents)
      .where(eq(extractedEvents.id, extractedEventId))
      .limit(1);
    if (!candidate) throw new Error(`Extracted event ${extractedEventId} not found`);

    const candidateLinks = await this.getRelatedLinks(extractedEventId);

    await this.applyDecision(candidate, candidateLinks, {
      decision: "new",
      normalizedEventId: null,
      score: 1,
      signals: { manual_override: true },
      reason: "Manually accepted as new canonical event from review queue.",
      note: note ?? null,
    });
  }

  /**
   * Phase 3.1: try to attach a sub-event candidate to a canonical main event.
   * Returns null if no plausible parent is found and the candidate has no hint
   * (i.e. fall through to "new"). Returns a `linked_as_sub`, or `needs_review`
   * result when the candidate has a sub-event hint but parent identification
   * is ambiguous.
   */
  private async tryHierarchyResolution(
    candidate: ExtractedEventRow
  ): Promise<ResolutionResult | null> {
    if (!candidate.artistId) {
      // Without an artist anchor we can't safely identify a parent.
      return candidate.parentEventHint
        ? {
            decision: "needs_review",
            normalizedEventId: null,
            score: 0.2,
            signals: { event_scope: "sub", parent_event_hint_matched: false },
            reason: "Sub-event hint present but candidate has no artist_id to anchor parent search.",
          }
        : null;
    }

    // Select main-event candidates: same artist, parent_event_id IS NULL.
    const mainCandidates = await this.db
      .select()
      .from(normalizedEvents)
      .where(
        and(
          eq(normalizedEvents.artistId, candidate.artistId),
          sql`${normalizedEvents.parentEventId} IS NULL`
        )
      );

    if (mainCandidates.length === 0) {
      // No parent exists yet; do not invent one.
      return candidate.parentEventHint
        ? {
            decision: "needs_review",
            normalizedEventId: null,
            score: 0.2,
            signals: { event_scope: "sub", parent_event_hint_matched: false },
            reason: `Sub-event hint "${candidate.parentEventHint}" present but no main events exist for this artist yet.`,
          }
        : null;
    }

    // Score each main candidate for hierarchy attachment
    type Scored = { main: NormalizedEventRow; score: number; reasons: string[]; hintMatched: boolean };
    const scored: Scored[] = [];

    for (const main of mainCandidates) {
      let score = 0;
      const reasons: string[] = [];
      let hintMatched = false;

      // Hint match: parent_event_hint vs main.title
      if (candidate.parentEventHint) {
        const hintSim = titleSimilarity(candidate.parentEventHint, main.title);
        if (hintSim >= this.thresholds.titleSimilarityThreshold) {
          score += 0.6;
          hintMatched = true;
          reasons.push(`hint matches main title (sim=${hintSim.toFixed(2)})`);
        }
      }

      // Same venue
      if (candidate.venueId && main.venueId && candidate.venueId === main.venueId) {
        score += 0.25;
        reasons.push("same venue_id");
      }

      // Time alignment: candidate start within main event window (±48h)
      if (candidate.startTime && main.startTime) {
        const diffMs = Math.abs(candidate.startTime.getTime() - main.startTime.getTime());
        if (diffMs <= this.thresholds.candidateWindowMs) {
          score += 0.2;
          reasons.push("start_time within main event window");
        }
      } else if (!candidate.startTime && hintMatched) {
        // Sub-event with no time but hint-matched parent: acceptable
        score += 0.1;
      }

      if (score > 0) {
        scored.push({ main, score, reasons, hintMatched });
      }
    }

    if (scored.length === 0) {
      return candidate.parentEventHint
        ? {
            decision: "needs_review",
            normalizedEventId: null,
            score: 0.2,
            signals: { event_scope: "sub", parent_event_hint_matched: false },
            reason: `Sub-event hint "${candidate.parentEventHint}" present but no main event matched.`,
          }
        : null;
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;

    // Ambiguous: multiple plausible parents within a small score margin
    const ambiguous =
      scored.length > 1 && scored[1]!.score >= best.score - 0.1 && scored[1]!.score >= 0.5;

    const signals: ResolutionSignals = {
      event_scope: "sub",
      parent_event_hint_matched: best.hintMatched,
      venue_id_match: candidate.venueId != null && candidate.venueId === best.main.venueId,
    };

    if (ambiguous) {
      return {
        decision: "needs_review",
        normalizedEventId: best.main.id,
        score: best.score,
        signals,
        reason: `Multiple plausible parent events; top score ${best.score.toFixed(2)}, runner-up ${scored[1]!.score.toFixed(2)}.`,
      };
    }

    if (best.score >= this.thresholds.autoMergeScoreThreshold) {
      return {
        decision: "linked_as_sub",
        normalizedEventId: best.main.id,
        score: best.score,
        signals,
        reason: `Linked as sub-event of "${best.main.title}": ${best.reasons.join("; ")}.`,
      };
    }

    return {
      decision: "needs_review",
      normalizedEventId: best.main.id,
      score: best.score,
      signals,
      reason: `Sub-event candidate but signals weak (score ${best.score.toFixed(2)}): ${best.reasons.join("; ")}.`,
    };
  }

  /**
   * Process all unresolved extracted events in batch. If `signal` aborts
   * mid-batch, the loop exits at the next event boundary.
   */
  async processBatch(limit: number = 50, signal?: AbortSignal): Promise<{ resolved: number; failed: number }> {
    // Find extracted events without a resolution decision. Filter out
    // annotation rows (record_kind='annotation') — those don't go
    // through normalization; a future reconciliation step will attach
    // them to their parent event by parent_event_hint.
    const unresolved = await this.db
      .select({ id: extractedEvents.id })
      .from(extractedEvents)
      .where(
        sql`${extractedEvents.recordKind} = 'event' AND ${extractedEvents.id} NOT IN (
          SELECT ${eventResolutionDecisions.candidateExtractedEventId}
          FROM ${eventResolutionDecisions}
        )`
      )
      .limit(limit);

    let resolved = 0;
    let failed = 0;

    for (const row of unresolved) {
      if (signal?.aborted) {
        log.info(`Aborted; ${resolved} resolved, ${failed} failed before bail-out`);
        break;
      }
      try {
        await this.resolve(row.id);
        resolved++;
      } catch (e) {
        log.error(`Failed to resolve event ${row.id}:`, e);
        failed++;
      }
    }

    if (resolved > 0 || failed > 0) {
      log.info(`Resolved ${resolved} event(s); ${failed} failed`);
    }

    return { resolved, failed };
  }

  private async getRelatedLinks(extractedEventId: string): Promise<RelatedLinkRow[]> {
    return this.db
      .select()
      .from(extractedEventRelatedLinks)
      .where(eq(extractedEventRelatedLinks.extractedEventId, extractedEventId));
  }

  /**
   * Select candidate normalized events to compare against.
   * Broadly inclusive; decision logic applies conservative rules.
   */
  private async selectNormalizedCandidates(
    candidate: ExtractedEventRow,
    candidateLinks: RelatedLinkRow[]
  ): Promise<NormalizedEventRow[]> {
    const conditions = [];

    // Same artist when available
    if (candidate.artistId) {
      // Time window filter (events within ±48 hours of candidate start_time)
      if (candidate.startTime) {
        const windowStart = new Date(candidate.startTime.getTime() - this.thresholds.candidateWindowMs);
        const windowEnd = new Date(candidate.startTime.getTime() + this.thresholds.candidateWindowMs);
        conditions.push(
          and(
            eq(normalizedEvents.artistId, candidate.artistId),
            or(
              // normalized event falls within window
              and(
                gte(normalizedEvents.startTime, windowStart),
                lte(normalizedEvents.startTime, windowEnd)
              ),
              // normalized event has no start time (possible match)
              sql`${normalizedEvents.startTime} IS NULL`
            )
          )
        );
      } else {
        // No start time — candidate by artist only
        conditions.push(eq(normalizedEvents.artistId, candidate.artistId));
      }
    }

    // Events sharing a related link URL
    if (candidateLinks.length > 0) {
      const linkUrls = candidateLinks.map((l) => l.url);
      // Find normalized events that have any of these URLs as related links
      const normalizedWithLinks = await this.db
        .selectDistinct({ normalizedEventId: normalizedEventSources.normalizedEventId })
        .from(normalizedEventSources)
        .innerJoin(
          extractedEventRelatedLinks,
          eq(normalizedEventSources.extractedEventId, extractedEventRelatedLinks.extractedEventId)
        )
        .where(
          and(
            inArray(extractedEventRelatedLinks.url, linkUrls),
            ne(normalizedEventSources.role, "annotation")
          )
        );

      if (normalizedWithLinks.length > 0) {
        const ids = normalizedWithLinks.map((r) => r.normalizedEventId);
        conditions.push(inArray(normalizedEvents.id, ids));
      }
    }

    if (conditions.length === 0) return [];

    const orConditions = conditions.length === 1 ? conditions[0]! : or(...conditions);
    return this.db
      .select()
      .from(normalizedEvents)
      .where(orConditions!)
      .limit(50);
  }

  /**
   * Score each candidate normalized event and pick the best match.
   */
  private async decideResolution(
    candidate: ExtractedEventRow,
    candidateLinks: RelatedLinkRow[],
    normalizedCandidates: NormalizedEventRow[],
    extractedVec: Float32Array | null,
    candidateVecs: Map<string, Float32Array>
  ): Promise<ResolutionResult> {
    if (normalizedCandidates.length === 0) {
      return {
        decision: "new",
        normalizedEventId: null,
        signals: {},
        reason: "No candidate normalized events found within selection window.",
        score: 0,
      };
    }

    let bestResult: ResolutionResult | null = null;

    for (const norm of normalizedCandidates) {
      const cosine =
        extractedVec && candidateVecs.has(norm.id)
          ? cosineSimilarity(extractedVec, candidateVecs.get(norm.id)!)
          : null;
      const result = await this.scoreMatch(candidate, candidateLinks, norm, cosine);
      if (!bestResult || result.score > bestResult.score) {
        bestResult = result;
      }
    }

    return bestResult!;
  }

  private async scoreMatch(
    candidate: ExtractedEventRow,
    candidateLinks: RelatedLinkRow[],
    norm: NormalizedEventRow,
    cosine: number | null
  ): Promise<ResolutionResult> {
    const signals: ResolutionSignals = {};
    let score = 0;
    const reasons: string[] = [];

    // --- Strong signal: same source URL ---
    const normSources = await this.db
      .select({ extractedEventId: normalizedEventSources.extractedEventId })
      .from(normalizedEventSources)
      .where(
        and(
          eq(normalizedEventSources.normalizedEventId, norm.id),
          ne(normalizedEventSources.role, "annotation")
        )
      );

    const normExtractedIds = normSources.map((r) => r.extractedEventId);

    if (normExtractedIds.length > 0) {
      const normExtracted = await this.db
        .select({ sourceUrl: extractedEvents.sourceUrl })
        .from(extractedEvents)
        .where(inArray(extractedEvents.id, normExtractedIds));

      const normSourceUrls = new Set(normExtracted.map((e) => e.sourceUrl));
      if (candidate.sourceUrl && normSourceUrls.has(candidate.sourceUrl)) {
        signals.same_source_url = true;
        score += 0.9;
        reasons.push("same source URL");
      } else {
        signals.same_source_url = false;
      }
    }

    // --- Strong signal: related link overlap + close time ---
    if (candidateLinks.length > 0) {
      const normLinks = await this.db
        .select({ url: extractedEventRelatedLinks.url })
        .from(normalizedEventSources)
        .innerJoin(
          extractedEventRelatedLinks,
          eq(normalizedEventSources.extractedEventId, extractedEventRelatedLinks.extractedEventId)
        )
        .where(
          and(
            eq(normalizedEventSources.normalizedEventId, norm.id),
            ne(normalizedEventSources.role, "annotation")
          )
        );

      const normLinkUrls = new Set(normLinks.map((l) => l.url));
      const overlap = candidateLinks.some((l) => normLinkUrls.has(l.url));

      if (overlap) {
        signals.related_link_overlap = true;
        const timeWindowLabel = timeWindowSignal(candidate.startTime, norm.startTime, this.thresholds.candidateWindowMs);
        signals.time_window = timeWindowLabel;

        if (timeWindowLabel === "within_window" || timeWindowLabel === "same_event_no_time") {
          score += 0.8;
          reasons.push("shared related link + close time");
        } else {
          // Overlap but times differ — review candidate
          score += 0.3;
          reasons.push("shared related link but time diff > 48h");
        }
      } else {
        signals.related_link_overlap = false;
      }
    }

    // --- Strong signal: same venue + close time + similar title ---
    let titleCreditedViaVenue = false;
    if (
      candidate.venueId &&
      norm.venueId &&
      candidate.venueId === norm.venueId
    ) {
      signals.venue_id_match = true;
      const timeWindowLabel = timeWindowSignal(candidate.startTime, norm.startTime, this.thresholds.candidateWindowMs);
      signals.time_window = signals.time_window ?? timeWindowLabel;

      const titSim = titleSimilarity(candidate.title, norm.title);
      signals.title_similarity = titSim;

      if (
        (timeWindowLabel === "within_window" || timeWindowLabel === "same_event_no_time") &&
        titSim >= this.thresholds.titleSimilarityThreshold
      ) {
        score += 0.75;
        reasons.push(`same venue + close time + title similarity ${titSim.toFixed(2)}`);
        titleCreditedViaVenue = true;
      } else if (timeWindowLabel === "within_window") {
        // Same venue + close time but title doesn't match
        score += 0.2;
        reasons.push("same venue + close time but title mismatch");
      }
    } else {
      signals.venue_id_match = false;

      // Moderate: title similarity alone
      if (!signals.title_similarity) {
        const titSim = titleSimilarity(candidate.title, norm.title);
        signals.title_similarity = titSim;
      }
    }

    // --- Moderate: time window ---
    if (!signals.time_window) {
      signals.time_window = timeWindowSignal(candidate.startTime, norm.startTime, this.thresholds.candidateWindowMs);
    }

    // --- Moderate: same-artist + title similarity (independent signal) ---
    // Many extracted events from posts have no venue and no start_time, so the
    // strong signals above can't fire even on clear duplicates. When the artist
    // matches and titles are similar in a plausible time window, credit it here.
    // Same-artist is usually guaranteed by candidate selection, but related-link
    // candidates can be cross-artist, so check explicitly. Skipped when the venue
    // branch already credited the title-sim signal to avoid double-counting.
    const sameArtist = !!candidate.artistId && candidate.artistId === norm.artistId;
    signals.same_artist = sameArtist;
    if (sameArtist && !titleCreditedViaVenue) {
      const titSim = signals.title_similarity!;
      if (titSim >= this.thresholds.titleSimilarityThreshold) {
        // Weight by time-window confidence. within_window auto-merges at
        // titSim≥0.7; weaker time signals stay below the merge threshold so
        // they surface for review instead of silently collapsing recurring
        // events like weekly streams.
        let weight = 0;
        if (signals.time_window === "within_window") weight = 1.0;
        else if (signals.time_window === "same_event_no_time") weight = 0.5;
        else if (signals.time_window === "within_7d") weight = 0.3;
        if (weight > 0) {
          score += weight * titSim;
          reasons.push(`same artist + title similarity ${titSim.toFixed(2)} (${signals.time_window})`);
        }
      }
    }

    // --- Moderate: same-artist + embedding cosine ---
    // Catches cross-script aliases (e.g. 花譜 ↔ KAF) the deterministic
    // tokenizer can't see. Independent of titleSimilarity — both signals
    // can stack when both fire. Gated by same-artist + plausible time
    // window for the same reasons as the title-sim branch.
    if (cosine !== null) {
      signals.embedding_cosine = cosine;
      signals.embedding_model = this.embeddings?.modelId();
      if (
        sameArtist &&
        this.embeddings &&
        cosine >= this.embeddings.cosineThreshold()
      ) {
        let weight = 0;
        if (signals.time_window === "within_window") weight = 0.7;
        else if (signals.time_window === "same_event_no_time") weight = 0.5;
        else if (signals.time_window === "within_7d") weight = 0.3;
        if (weight > 0) {
          score += weight * cosine;
          reasons.push(`same artist + embedding cosine ${cosine.toFixed(2)} (${signals.time_window})`);
        }
      }
    }

    // Determine final decision based on score
    let decision: ResolutionDecisionType;
    let reason: string;

    if (score >= this.thresholds.autoMergeScoreThreshold) {
      decision = "merged";
      reason = `Auto-merge: ${reasons.join("; ")}.`;
    } else if (score >= this.thresholds.needsReviewScoreThreshold) {
      decision = "needs_review";
      reason = `Ambiguous signals (score ${score.toFixed(2)}): ${reasons.join("; ")}.`;
    } else {
      decision = "no_match";
      reason = `No strong signals found (score ${score.toFixed(2)}).`;
    }

    return { decision, normalizedEventId: norm.id, signals, reason, score };
  }

  private async applyDecision(
    candidate: ExtractedEventRow,
    candidateLinks: RelatedLinkRow[],
    result: ResolutionResult
  ): Promise<void> {
    const { decision, normalizedEventId, signals, reason, score, note } = result;
    const decisionId = randomUUID();

    if (decision === "new" || decision === "no_match") {
      // Create a new normalized event from this candidate
      const newNormId = randomUUID();
      const effectiveDecision: ResolutionDecisionType = "new";

      await this.db.transaction((tx) => {
        supersedePriorDecisions(tx, candidate.id, decisionId);

        tx.insert(normalizedEvents).values({
          id: newNormId,
          parentEventId: null,
          artistId: candidate.artistId,
          title: candidate.title,
          description: candidate.description,
          startTime: candidate.startTime,
          endTime: candidate.endTime,
          venueId: candidate.venueId,
          venueName: candidate.venueName,
          venueUrl: candidate.venueUrl,
          type: candidate.type,
          isCancelled: candidate.isCancelled,
          tags: candidate.tags,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).run();

        tx.insert(normalizedEventSources).values({
          id: randomUUID(),
          normalizedEventId: newNormId,
          extractedEventId: candidate.id,
          role: "primary",
          createdAt: new Date(),
        }).run();

        tx.insert(eventResolutionDecisions).values({
          id: decisionId,
          candidateExtractedEventId: candidate.id,
          matchedNormalizedEventId: newNormId,
          decision: effectiveDecision,
          score,
          signals,
          reason: decision === "new" ? reason : `No strong signals (score ${score.toFixed(2)}); created as new.`,
          createdAt: new Date(),
          note: note ?? null,
        }).run();

        this.exportQueue?.enqueueSync(tx, newNormId, candidate.isCancelled ? "cancelled" : "created");
      });

      await this.embeddings?.embedAndStore({
        normalizedEventId: newNormId,
        title: candidate.title,
        venueName: candidate.venueName,
      });

      log.info(`Created new normalized event ${newNormId} for extracted ${candidate.id}`);

    } else if (decision === "linked_as_sub" && normalizedEventId) {
      // Phase 3.1: create a new normalized event as a sub-event of the matched main event.
      // Sub-events are independent canonical records linked back via parent_event_id;
      // they do not edit the parent's canonical fields.
      const subId = randomUUID();
      await this.db.transaction((tx) => {
        supersedePriorDecisions(tx, candidate.id, decisionId);

        tx.insert(normalizedEvents).values({
          id: subId,
          parentEventId: normalizedEventId,
          artistId: candidate.artistId,
          title: candidate.title,
          description: candidate.description,
          startTime: candidate.startTime,
          endTime: candidate.endTime,
          venueId: candidate.venueId,
          venueName: candidate.venueName,
          venueUrl: candidate.venueUrl,
          type: candidate.type,
          isCancelled: candidate.isCancelled,
          tags: candidate.tags,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).run();

        tx.insert(normalizedEventSources).values({
          id: randomUUID(),
          normalizedEventId: subId,
          extractedEventId: candidate.id,
          role: "primary",
          createdAt: new Date(),
        }).run();

        tx.insert(eventResolutionDecisions).values({
          id: decisionId,
          candidateExtractedEventId: candidate.id,
          matchedNormalizedEventId: normalizedEventId,
          decision: "linked_as_sub",
          score,
          signals,
          reason,
          createdAt: new Date(),
          note: note ?? null,
        }).run();

        this.exportQueue?.enqueueSync(tx, subId, candidate.isCancelled ? "cancelled" : "created");
      });

      await this.embeddings?.embedAndStore({
        normalizedEventId: subId,
        title: candidate.title,
        venueName: candidate.venueName,
      });

      log.info(`Linked extracted ${candidate.id} as sub-event ${subId} of ${normalizedEventId}`);

    } else if (decision === "merged" && normalizedEventId) {
      // Merge into existing normalized event
      await this.db.transaction((tx) => {
        supersedePriorDecisions(tx, candidate.id, decisionId);

        // Link candidate to existing normalized event
        tx.insert(normalizedEventSources).values({
          id: randomUUID(),
          normalizedEventId,
          extractedEventId: candidate.id,
          role: "merged",
          createdAt: new Date(),
        }).onConflictDoNothing().run();

        // Merge cancellation flag — only enqueue if the canonical flag
        // actually flips, to avoid sending consumers redundant cancellations.
        // Operator-owned rows are frozen: skip the UPDATE entirely so the
        // operator's edits aren't clobbered by a downstream cancellation.
        let cancellationFlipped = false;
        if (candidate.isCancelled) {
          const existing = tx
            .select({
              isCancelled: normalizedEvents.isCancelled,
              operatorOwned: normalizedEvents.operatorOwned,
            })
            .from(normalizedEvents)
            .where(eq(normalizedEvents.id, normalizedEventId))
            .all();
          if (existing[0] && !existing[0].isCancelled && !existing[0].operatorOwned) {
            cancellationFlipped = true;
            tx.update(normalizedEvents)
              .set({ isCancelled: true, updatedAt: new Date() })
              .where(eq(normalizedEvents.id, normalizedEventId))
              .run();
          }
        }

        tx.insert(eventResolutionDecisions).values({
          id: decisionId,
          candidateExtractedEventId: candidate.id,
          matchedNormalizedEventId: normalizedEventId,
          decision: "merged",
          score,
          signals,
          reason,
          createdAt: new Date(),
          note: note ?? null,
        }).run();

        if (cancellationFlipped) {
          this.exportQueue?.enqueueSync(tx, normalizedEventId, "cancelled");
        }
      });

      // Copy related links (deduped by URL) outside transaction for simplicity
      for (const link of candidateLinks) {
        const normLinks = await this.db
          .select({ url: extractedEventRelatedLinks.url })
          .from(normalizedEventSources)
          .innerJoin(
            extractedEventRelatedLinks,
            eq(normalizedEventSources.extractedEventId, extractedEventRelatedLinks.extractedEventId)
          )
          .where(
            and(
              eq(normalizedEventSources.normalizedEventId, normalizedEventId),
              eq(extractedEventRelatedLinks.url, link.url)
            )
          )
          .limit(1);

        if (normLinks.length === 0) {
          // Link is new for this normalized event — it's already accessible via
          // normalized_event_sources → extracted_event_related_links join, no duplication needed.
          // We intentionally don't copy to a separate table; querying through the join is sufficient.
        }
      }

      log.info(`Merged extracted ${candidate.id} into normalized ${normalizedEventId}`);

    } else if (decision === "needs_review") {
      // Record for human review but do not create or merge.
      // Supersede inside a transaction to keep the chain consistent.
      await this.db.transaction((tx) => {
        supersedePriorDecisions(tx, candidate.id, decisionId);
        tx.insert(eventResolutionDecisions).values({
          id: decisionId,
          candidateExtractedEventId: candidate.id,
          matchedNormalizedEventId: normalizedEventId,
          decision: "needs_review",
          score,
          signals,
          reason,
          createdAt: new Date(),
          note: note ?? null,
        }).run();
      });

      log.info(`Flagged extracted ${candidate.id} for review (score ${score.toFixed(2)})`);
    }
  }
}

/**
 * Mark every current decision for `candidateExtractedEventId` as
 * superseded by `newDecisionId`. Idempotent and safe to call before
 * each insert.
 */
function supersedePriorDecisions(tx: any, candidateExtractedEventId: string, newDecisionId: string): void {
  tx.update(eventResolutionDecisions)
    .set({ supersededAt: new Date(), supersededById: newDecisionId })
    .where(and(
      eq(eventResolutionDecisions.candidateExtractedEventId, candidateExtractedEventId),
      sql`${eventResolutionDecisions.supersededAt} IS NULL`
    ))
    .run();
}

function timeWindowSignal(
  candidateTime: Date | null | undefined,
  normTime: Date | null | undefined,
  windowMs: number
): string {
  if (!candidateTime || !normTime) return "same_event_no_time";
  const diffMs = Math.abs(candidateTime.getTime() - normTime.getTime());
  if (diffMs <= windowMs) return "within_window";
  if (diffMs <= 7 * 24 * 60 * 60 * 1000) return "within_7d";
  return "beyond_7d";
}
