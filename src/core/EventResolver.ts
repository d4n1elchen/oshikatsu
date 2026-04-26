import { randomUUID } from "crypto";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import {
  extractedEventRelatedLinks,
  extractedEvents,
  eventResolutionDecisions,
  normalizedEvents,
  normalizedEventSources,
} from "../db/schema";
import { titleSimilarity, TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD } from "./titleSimilarity";
import type { ResolutionSignals, ResolutionDecisionType } from "./types";

const CANDIDATE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

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
};

export class EventResolver {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
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
      console.warn(`[EventResolver] Extracted event ${extractedEventId} not found`);
      return;
    }

    // Skip if already resolved
    const existing = await this.db
      .select({ id: eventResolutionDecisions.id })
      .from(eventResolutionDecisions)
      .where(eq(eventResolutionDecisions.candidateExtractedEventId, extractedEventId))
      .limit(1);

    if (existing.length > 0) {
      console.log(`[EventResolver] Event ${extractedEventId} already resolved; skipping.`);
      return;
    }

    const candidateLinks = await this.getRelatedLinks(extractedEventId);
    const normalizedCandidates = await this.selectNormalizedCandidates(candidate, candidateLinks);

    const result = await this.decideResolution(candidate, candidateLinks, normalizedCandidates);

    await this.applyDecision(candidate, candidateLinks, result);
  }

  /**
   * Process all unresolved extracted events in batch.
   */
  async processBatch(limit: number = 50): Promise<{ resolved: number; failed: number }> {
    // Find extracted events without a resolution decision
    const unresolved = await this.db
      .select({ id: extractedEvents.id })
      .from(extractedEvents)
      .where(
        sql`${extractedEvents.id} NOT IN (
          SELECT ${eventResolutionDecisions.candidateExtractedEventId}
          FROM ${eventResolutionDecisions}
        )`
      )
      .limit(limit);

    let resolved = 0;
    let failed = 0;

    for (const row of unresolved) {
      try {
        await this.resolve(row.id);
        resolved++;
      } catch (e) {
        console.error(`[EventResolver] Failed to resolve event ${row.id}:`, e);
        failed++;
      }
    }

    if (resolved > 0 || failed > 0) {
      console.log(`[EventResolver] Resolved ${resolved} events, ${failed} failed.`);
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
        const windowStart = new Date(candidate.startTime.getTime() - CANDIDATE_WINDOW_MS);
        const windowEnd = new Date(candidate.startTime.getTime() + CANDIDATE_WINDOW_MS);
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
        .where(inArray(extractedEventRelatedLinks.url, linkUrls));

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
    normalizedCandidates: NormalizedEventRow[]
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
      const result = await this.scoreMatch(candidate, candidateLinks, norm);
      if (!bestResult || result.score > bestResult.score) {
        bestResult = result;
      }
    }

    return bestResult!;
  }

  private async scoreMatch(
    candidate: ExtractedEventRow,
    candidateLinks: RelatedLinkRow[],
    norm: NormalizedEventRow
  ): Promise<ResolutionResult> {
    const signals: ResolutionSignals = {};
    let score = 0;
    const reasons: string[] = [];

    // --- Strong signal: same source URL ---
    const normSources = await this.db
      .select({ extractedEventId: normalizedEventSources.extractedEventId })
      .from(normalizedEventSources)
      .where(eq(normalizedEventSources.normalizedEventId, norm.id));

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
        .where(eq(normalizedEventSources.normalizedEventId, norm.id));

      const normLinkUrls = new Set(normLinks.map((l) => l.url));
      const overlap = candidateLinks.some((l) => normLinkUrls.has(l.url));

      if (overlap) {
        signals.related_link_overlap = true;
        const timeWindowLabel = timeWindowSignal(candidate.startTime, norm.startTime);
        signals.time_window = timeWindowLabel;

        if (timeWindowLabel === "within_48h" || timeWindowLabel === "same_event_no_time") {
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
    if (
      candidate.venueId &&
      norm.venueId &&
      candidate.venueId === norm.venueId
    ) {
      signals.venue_id_match = true;
      const timeWindowLabel = timeWindowSignal(candidate.startTime, norm.startTime);
      signals.time_window = signals.time_window ?? timeWindowLabel;

      const titSim = titleSimilarity(candidate.title, norm.title);
      signals.title_similarity = titSim;

      if (
        (timeWindowLabel === "within_48h" || timeWindowLabel === "same_event_no_time") &&
        titSim >= TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD
      ) {
        score += 0.75;
        reasons.push(`same venue + close time + title similarity ${titSim.toFixed(2)}`);
      } else if (timeWindowLabel === "within_48h") {
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
      signals.time_window = timeWindowSignal(candidate.startTime, norm.startTime);
    }

    // Determine final decision based on score
    let decision: ResolutionDecisionType;
    let reason: string;

    if (score >= 0.7) {
      decision = "merged";
      reason = `Auto-merge: ${reasons.join("; ")}.`;
    } else if (score >= 0.25) {
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
    const { decision, normalizedEventId, signals, reason, score } = result;

    if (decision === "new" || decision === "no_match") {
      // Create a new normalized event from this candidate
      const newNormId = randomUUID();
      const effectiveDecision: ResolutionDecisionType = "new";

      await this.db.transaction((tx) => {
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
          id: randomUUID(),
          candidateExtractedEventId: candidate.id,
          matchedNormalizedEventId: newNormId,
          decision: effectiveDecision,
          score,
          signals,
          reason: decision === "new" ? reason : `No strong signals (score ${score.toFixed(2)}); created as new.`,
          createdAt: new Date(),
        }).run();
      });

      console.log(`[EventResolver] Created new normalized event ${newNormId} for extracted ${candidate.id}`);

    } else if (decision === "merged" && normalizedEventId) {
      // Merge into existing normalized event
      await this.db.transaction((tx) => {
        // Link candidate to existing normalized event
        tx.insert(normalizedEventSources).values({
          id: randomUUID(),
          normalizedEventId,
          extractedEventId: candidate.id,
          role: "merged",
          createdAt: new Date(),
        }).onConflictDoNothing().run();

        // Merge cancellation flag
        if (candidate.isCancelled) {
          tx.update(normalizedEvents)
            .set({ isCancelled: true, updatedAt: new Date() })
            .where(eq(normalizedEvents.id, normalizedEventId))
            .run();
        }

        tx.insert(eventResolutionDecisions).values({
          id: randomUUID(),
          candidateExtractedEventId: candidate.id,
          matchedNormalizedEventId: normalizedEventId,
          decision: "merged",
          score,
          signals,
          reason,
          createdAt: new Date(),
        }).run();
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

      console.log(`[EventResolver] Merged extracted ${candidate.id} into normalized ${normalizedEventId}`);

    } else if (decision === "needs_review") {
      // Record for human review but do not create or merge
      await this.db.insert(eventResolutionDecisions).values({
        id: randomUUID(),
        candidateExtractedEventId: candidate.id,
        matchedNormalizedEventId: normalizedEventId,
        decision: "needs_review",
        score,
        signals,
        reason,
        createdAt: new Date(),
      }).run();

      console.log(`[EventResolver] Flagged extracted ${candidate.id} for review (score ${score.toFixed(2)})`);
    }
  }
}

function timeWindowSignal(
  candidateTime: Date | null | undefined,
  normTime: Date | null | undefined
): string {
  if (!candidateTime || !normTime) return "same_event_no_time";
  const diffMs = Math.abs(candidateTime.getTime() - normTime.getTime());
  if (diffMs <= CANDIDATE_WINDOW_MS) return "within_48h";
  if (diffMs <= 7 * 24 * 60 * 60 * 1000) return "within_7d";
  return "beyond_7d";
}
