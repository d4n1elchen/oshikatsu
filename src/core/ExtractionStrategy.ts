import { z } from "zod";
import {
  hasTimezoneOffset,
  parseIsoWithFallbackTimezone,
  MissingTimezoneError,
} from "./timezone";

export const EVENT_TYPES = ["live_stream", "merchandise", "release", "concert", "broadcast", "collaboration", "side_event"] as const;
export const EVENT_SCOPES = ["main", "sub", "unknown"] as const;

/**
 * Annotations are extracted records that point at an *existing* event
 * (a milestone for a release, press coverage of a concert, a recap
 * after the fact, a reminder restating an already-announced activity).
 * They land in extracted_events with record_kind='annotation' and reuse
 * parent_event_hint as the linkage hint.
 */
export const ANNOTATION_CATEGORIES = ["milestone", "press_coverage", "recap", "reminder_repost"] as const;

/**
 * Orphan posts: not events and not tied to any existing event. They
 * terminate at raw_items.status='not_an_event' and never produce an
 * extracted_events row.
 */
export const NON_EVENT_CATEGORIES = ["mood", "fan_engagement", "other"] as const;

const SingleEventSchema = z.object({
  title: z.string().min(1).describe("A short, descriptive title for the event. Preserve proper nouns and official titles in their original written form."),
  description: z.string().min(1).describe("A detailed English summary of the announcement. Preserve proper nouns and official titles in their original written form."),
  start_time: z.string().optional().describe("ISO 8601 timestamp of when the extracted event actually starts, if explicitly available or safely inferable from the source."),
  end_time: z.string().optional().describe("ISO 8601 timestamp of when the event ends, if explicitly available."),
  venue_name: z.string().optional().describe("Name of the physical venue or virtual platform"),
  venue_url: z.string().optional().describe("URL to the stream, venue, or relevant event page"),
  related_links: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
  })).default([]).describe("Event-relevant links with URL and optional human-readable title"),
  type: z.enum(EVENT_TYPES).describe("The category of the event"),
  event_scope: z.enum(EVENT_SCOPES).default("unknown").describe("Whether this is the main event, a sub-event related to a larger event, or unclear."),
  parent_event_hint: z.string().optional().describe("Best-effort name of the larger/main event if this is a sub-event and the source gives enough evidence."),
  series_name: z.string().optional().describe("If the title contains a series marker (#N, vol.N, 第N回, 第N弾, N本目, etc.), the series name with the episode number stripped (e.g. 'Singing My Favorite Songs', 'GW特別投稿', '未確認少女観測部', 'コラボ企画「#組曲2」'). Leave unset for standalone events."),
  tags: z.array(z.string()).default([]).describe("List of relevant tags"),
});

const EventBranchSchema = z.object({
  kind: z.literal("event"),
  events: z.array(SingleEventSchema).min(1).describe("One or more events extracted from the post. Most posts emit a single-element array. Multi-event posts (e.g. a concert announcement that also lists multiple ticket lottery windows) emit the main event first, followed by sub-events with event_scope='sub' and parent_event_hint set to the main event's title."),
});

const AnnotationBranchSchema = z.object({
  kind: z.literal("annotation"),
  title: z.string().min(1).describe("Short, descriptive title for the annotation. Preserve proper nouns and official titles in their original written form."),
  description: z.string().min(1).describe("English summary of what the post says about the related event."),
  category: z.enum(ANNOTATION_CATEGORIES).describe("Which kind of annotation this is."),
  parent_event_hint: z.string().min(1).describe("Free-form name or descriptor of the existing event the post relates to. Required for annotations — the whole point of this branch is the linkage."),
  related_links: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
  })).default([]).describe("Annotation-relevant links."),
  tags: z.array(z.string()).default([]).describe("Short labels such as artist names, group names, platforms, product names, or campaign names."),
});

const NotAnEventBranchSchema = z.object({
  kind: z.literal("not_an_event"),
  category: z.enum(NON_EVENT_CATEGORIES).describe("Which orphan-post bucket this falls into."),
  reason: z.string().min(1).describe("Short explanation of why the post is neither an event nor an annotation of one."),
});

export const ExtractionOutputSchema = z.discriminatedUnion("kind", [
  EventBranchSchema,
  AnnotationBranchSchema,
  NotAnEventBranchSchema,
]);

export type EventType = typeof EVENT_TYPES[number];
export type EventScope = typeof EVENT_SCOPES[number];
export type AnnotationCategory = typeof ANNOTATION_CATEGORIES[number];
export type NonEventCategory = typeof NON_EVENT_CATEGORIES[number];
export type SingleEventResult = z.infer<typeof SingleEventSchema>;
export type EventExtractionResult = z.infer<typeof EventBranchSchema>;
export type AnnotationResult = z.infer<typeof AnnotationBranchSchema>;
export type NotAnEventResult = z.infer<typeof NotAnEventBranchSchema>;
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export interface SourceContext {
  text: string;
  publishTime: Date;
  author: string;
  url: string;
  relatedLinkCandidates: RelatedLinkCandidate[];
  rawContent: string;
  /**
   * IANA timezone applied when the LLM emits an offset-less timestamp.
   * Set by the engine from artist.timezone or config.defaultTimezone
   * after `buildContext` returns. Null disables the fallback (offset-less
   * timestamps will fail extraction loudly).
   */
  fallbackTimezone?: string | null;
}

export interface RelatedLinkCandidate {
  url: string;
  title?: string;
}

export interface ExtractionStrategy {
  supports(sourceName: string): boolean;
  buildContext(rawItem: any): SourceContext | null;
  buildPrompt(context: SourceContext): string;
  sanitize(rawItem: any, context: SourceContext, extracted: EventExtractionResult): EventExtractionResult;
}

export class DefaultExtractionStrategy implements ExtractionStrategy {
  supports(_sourceName: string): boolean {
    return true;
  }

  buildContext(rawItem: any): SourceContext | null {
    const rawContent = JSON.stringify(rawItem.rawData);
    if (!rawContent) return null;

    return {
      text: rawContent,
      publishTime: new Date(),
      author: "unknown",
      url: "",
      relatedLinkCandidates: extractLinkCandidatesFromText(rawContent),
      rawContent,
    };
  }

  buildPrompt(context: SourceContext): string {
    return `You parse social media posts for a fan activity tracker. Each post either announces a concrete activity (an event) or it does not. Your job is to classify which, and for events, extract the structured fields.

Source posted at: ${context.publishTime.toISOString()}

Input text:
"${context.rawContent}"

Related link candidates:
${formatRelatedLinkCandidates(context.relatedLinkCandidates)}

Output shape (pick exactly one):
- kind="event": the post announces, updates, schedules, cancels, or links to a specific activity in one of the allowed event types.
- kind="annotation": the post is *about* an existing event but does not itself announce a new activity. Use this for milestones (counts, rankings, playlist additions), press coverage, recaps, and reminder reposts. The post must reference an existing event clearly enough to name it.
- kind="not_an_event": the post is neither an event nor tied to a specific existing event. Use this for greetings, personal thoughts, fan-content retweets, and other orphan posts. This is not a failure case; it is a normal classification.

Language rules:
- Write explanatory prose in English.
- Do not translate, romanize, or rewrite proper nouns.
- Preserve artist names, group names, concert titles, song titles, album titles, venue names, campaign names, hashtags, and quoted official titles exactly as written in the source text.
- If a title combines an English summary with an official name, keep the official name in its original written form.

Event branch (kind="event"):
- Return "events" as an array. Most posts emit a single-element array — one announcement, one event. Some posts bundle a main event with several time-bounded sub-events (e.g. a concert announcement that also lists multiple ticket lottery windows, an album release with separate pre-order and ship dates, a tour with separate dates per city). When the source clearly describes more than one activity, emit one array element per activity.
- For multi-event posts, emit the main event first (event_scope="main"), then each sub-event (event_scope="sub", parent_event_hint set to the main event's title exactly as you wrote it). Do NOT split a single activity into multiple events just because the post is long.
- Extract the specific activity described by the source post. A post may announce a main event, or it may announce a sub-event such as a merch sale, ticket lottery, meet-and-greet, pre-show, after-show, campaign, booth, or stream related to a larger main event.
- start_time should be an ISO 8601 timestamp for when the extracted activity happens, if the source gives an explicit time or enough context to infer it safely.
- start_time and end_time MUST include a timezone offset (e.g. "2026-05-16T18:00:00+09:00" for JST, or trailing "Z" for UTC). If the source post does not state a timezone explicitly, infer it from the language, location, or venue. Never emit a bare local time like "2026-05-16T18:00:00".
- When the source states a date without a year (e.g. "5/16", "9.5 Sat.", "4月30日(木)"), resolve the year against the "Source posted at" timestamp above: pick the next occurrence of that month/day on or after the source post date. Never emit a start_time more than 7 days before the source post date.
- When the source gives a date but no time of day (e.g. "9.5 Sat. パシフィコ横浜", "5月18日(月)開催", "9 / 5 (土)"), emit start_time at midnight in the inferred timezone (e.g. "2026-09-05T00:00:00+09:00"). Date-only is still a valid start_time; do NOT leave it unset just because the time of day is missing.
- For multi-day events (e.g. "7/24-26にカリフォルニアのサンノゼ", "9.5 Sat. / 9.6 Sun."), set start_time to midnight of the first day and end_time to 23:59 of the last day in the inferred timezone.
- Leave start_time unset when the source announces a real activity but does not provide the activity's own time. Do not use the source publish time as start_time for events that have their own scheduled time.
- Exception for type="release": when the post announces a just-uploaded artifact (a YouTube video, a music platform link, a published article) and links to it, the post IS the release moment. Use the "Source posted at" timestamp as start_time. This rule does NOT apply to release-type posts that announce a *future* release ("Album drops 5/27"); those follow the usual rule and use the announced date.
- end_time should only be set when an explicit end time is available.
- related_links must contain only event-relevant candidate URLs and optional human-readable titles.
- type must be one of: ${EVENT_TYPES.join(", ")}.
- event_scope must be "main" for a standalone/main event, "sub" for an activity that belongs under a larger event, or "unknown" when the relationship is unclear.
- parent_event_hint should be set only when event_scope is "sub" and the source names or clearly implies the larger/main event. Use the official title exactly as written. If the main event is not named, leave parent_event_hint unset.
- series_name should be set when the title contains a series marker — episode/installment numbering like "#N", "vol.N", "第N回", "第N弾", "N本目" — that identifies the post as one entry in an open-ended recurring series. Extract the series name with the episode number stripped. Examples: "Singing My Favorite Songs # 145" → series_name="Singing My Favorite Songs"; "未確認少女観測部 vol.48" → series_name="未確認少女観測部"; "GW特別投稿4本目" → series_name="GW特別投稿"; "コラボ企画「#組曲2」第九弾「放課後ボーダーライン」" → series_name="コラボ企画「#組曲2」". event_scope stays "main" — the series is a grouping label, not a parent event. Leave series_name unset for standalone events.
- tags should be short labels such as artist names, group names, platforms, product names, or campaign names.
- Classify the underlying activity being announced, not the wording of the post. An informational post about a scheduled concert is type "concert"; a post about a merch sale is type "merchandise".
- Do not invent a main event that is not named or clearly implied by the source. It is acceptable to extract a sub-event with parent_event_hint unset.

Annotation branch (kind="annotation"):
- Use when the post comments on, measures, or references a specific existing event without itself being an event announcement.
- Pick exactly one category, the most specific that fits:
  - milestone: a count, ranking, threshold, chart position, playlist addition, or other measurement update for an existing activity.
  - press_coverage: third-party coverage (interview, feature, broadcast mention) of an existing activity.
  - recap: backward-looking thanks, summary, or report about a completed activity.
  - reminder_repost: restates an already-announced activity without new information (no new time, place, link, lineup, or status change).
- parent_event_hint is required and is free-form text naming the existing event being referenced. Use the official title exactly as written when present.
- title and description summarize what the post says about the event.
- Do not use the annotation branch when the related event cannot be identified from the post; use kind="not_an_event" instead.

Orphan branch (kind="not_an_event"):
- Pick exactly one category, the most specific that fits:
  - mood: greetings, personal thoughts, weather, well-wishes, or any post not tied to a specific activity.
  - fan_engagement: retweets of fan content, shoutouts, replies, or interactions that do not announce a new activity.
  - other: not an event, annotation, or any of the above categories.
- reason is a short English explanation of the choice.
- Do not classify a post as not_an_event just because details are sparse. If the post announces a specific activity, use kind="event". If the post references a specific existing event, use kind="annotation".

Venue rules (event branch only):
- venue_name and venue_url describe where the event takes place.
- For physical venues, venue_name is the venue's actual name and venue_url is the venue's official URL when available.
- For virtual platforms (live_stream, release, broadcast on a streaming service):
  - When the post links to a specific stream / video URL (YouTube, bilibili, Twitch, niconico, etc.), use that URL as venue_url. Set venue_name to the platform name ("YouTube", "bilibili", etc.).
  - Prefer the channel or profile URL if the post mentions one explicitly; otherwise the stream URL is the right venue_url.
  - When the post lists multiple platform URLs for the same event (e.g. "YouTube: … / bilibili: …" simulcast), pick the first listed as venue_url and put the others in related_links.
  - Never set venue_name to a bare platform name without an accompanying venue_url. If no URL is available, leave both venue_name and venue_url unset.`;
  }

  sanitize(_rawItem: any, _context: SourceContext, extracted: EventExtractionResult): EventExtractionResult {
    // Defensive ordering: main events first so the resolver (which also
    // processes mains before subs across the batch) sees a consistent
    // intra-tweet order. The prompt already asks for this order; this is a
    // backstop for LLM drift.
    const sanitizedEvents = extracted.events
      .map((event) => sanitizeSingleEvent(_context, event))
      .sort((a, b) => scopeRank(a.event_scope) - scopeRank(b.event_scope));

    return { kind: "event", events: sanitizedEvents };
  }
}

function sanitizeSingleEvent(context: SourceContext, event: SingleEventResult): SingleEventResult {
  const title = requireNonEmpty(event.title, "title");
  const description = requireNonEmpty(event.description, "description");
  const fallbackTz = context.fallbackTimezone ?? null;
  const startTime = event.start_time ? parseDateOrThrow(event.start_time, "start_time", fallbackTz) : undefined;
  const endTime = event.end_time ? parseDateOrThrow(event.end_time, "end_time", fallbackTz) : undefined;
  if (startTime) {
    assertStartTimeNotStale(startTime, context.publishTime);
  }
  const eventScope = EVENT_SCOPES.includes(event.event_scope) ? event.event_scope : "unknown";

  return {
    title,
    description,
    start_time: startTime?.toISOString(),
    end_time: endTime?.toISOString(),
    venue_name: event.venue_name?.trim() || undefined,
    venue_url: event.venue_url?.trim() || undefined,
    related_links: mergeRelatedLinks(event.related_links, context.relatedLinkCandidates),
    type: event.type,
    event_scope: eventScope,
    parent_event_hint: eventScope === "sub" ? event.parent_event_hint?.trim() || undefined : undefined,
    series_name: event.series_name?.trim() || undefined,
    tags: Array.isArray(event.tags) ? event.tags.map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

function scopeRank(scope: EventScope): number {
  if (scope === "main") return 0;
  if (scope === "unknown") return 1;
  return 2; // "sub"
}

/**
 * Annotations don't have source-specific shape divergence yet, so the
 * sanitizer lives as a free function rather than on the strategy
 * interface. Promote to the strategy when a real source-specific need
 * appears.
 */
export function sanitizeAnnotation(context: SourceContext, extracted: AnnotationResult): AnnotationResult {
  return {
    kind: "annotation",
    title: requireNonEmpty(extracted.title, "title"),
    description: requireNonEmpty(extracted.description, "description"),
    category: extracted.category,
    parent_event_hint: requireNonEmpty(extracted.parent_event_hint, "parent_event_hint"),
    related_links: mergeRelatedLinks(extracted.related_links, context.relatedLinkCandidates),
    tags: Array.isArray(extracted.tags) ? extracted.tags.map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

export class TwitterExtractionStrategy extends DefaultExtractionStrategy {
  supports(sourceName: string): boolean {
    return sourceName === "twitter";
  }

  buildContext(rawItem: any): SourceContext | null {
    const legacy = rawItem.rawData?.legacy;
    if (!legacy) return null;

    const text = legacy.full_text || "";
    if (!text.trim()) return null;

    // Author resolution: the GraphQL response shape isn't stable, so the deep
    // path can silently miss. The connector already resolved this at fetch
    // time (with its own fallback to the queried watch-target handle) and
    // encoded the result into rawItem.sourceUrl. Trust that as the source of
    // truth; deep-path lookup is just a small optimisation when it succeeds.
    const fromGraphQL = rawItem.rawData?.core?.user_results?.result?.legacy?.screen_name;
    const fromRawUrl = rawItem.sourceUrl ? extractAuthorFromXUrl(rawItem.sourceUrl) : null;
    const author = fromGraphQL || fromRawUrl || "unknown";
    const url = rawItem.sourceUrl || `https://x.com/${author}/status/${rawItem.sourceId}`;
    const publishTime = parseDateOrDefault(legacy.created_at, new Date().toISOString());
    const relatedLinkCandidates = extractTwitterLinkCandidates(rawItem);

    return {
      text,
      publishTime,
      author,
      url,
      relatedLinkCandidates,
      rawContent: text,
    };
  }
}

function extractAuthorFromXUrl(url: string): string | null {
  const m = url.match(/^https?:\/\/(?:x|twitter)\.com\/([^/]+)\/status\//i);
  return m ? m[1]! : null;
}

export function createDefaultExtractionStrategies(): ExtractionStrategy[] {
  return [
    new TwitterExtractionStrategy(),
    new DefaultExtractionStrategy(),
  ];
}

export function parseDateOrDefault(value: string | undefined, defaultIso: string): Date {
  const parsed = value ? new Date(value) : new Date(defaultIso);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const defaultDate = new Date(defaultIso);
  return Number.isNaN(defaultDate.getTime()) ? new Date() : defaultDate;
}

const STALE_START_TIME_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Mirrors the prompt rule that forbids resolving a year-less date to a year in
// the past. The LLM without a current-date anchor will silently default to its
// training-cutoff year; this guard turns that drift into a loud extraction
// error rather than a wrong-year row in the calendar.
function assertStartTimeNotStale(startTime: Date, publishTime: Date): void {
  const delta = publishTime.getTime() - startTime.getTime();
  if (delta > STALE_START_TIME_GRACE_MS) {
    throw new Error(
      `start_time ${startTime.toISOString()} precedes source publish time ${publishTime.toISOString()} by more than 7 days; likely wrong-year inference`,
    );
  }
}

function parseDateOrThrow(value: string, fieldName: string, fallbackTimezone: string | null): Date {
  if (hasTimezoneOffset(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid ${fieldName}: ${value}`);
    }
    return parsed;
  }
  if (!fallbackTimezone) {
    throw new MissingTimezoneError(fieldName, value);
  }
  return parseIsoWithFallbackTimezone(value, fallbackTimezone);
}

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing ${fieldName}`);
  }
  return trimmed;
}

function extractLinkCandidatesFromText(text: string): RelatedLinkCandidate[] {
  return dedupeRelatedLinks([...text.matchAll(/https?:\/\/\S+/g)].map((match) => ({ url: match[0] })));
}

function extractTwitterLinkCandidates(rawItem: any): RelatedLinkCandidate[] {
  const urls = rawItem.rawData?.legacy?.entities?.urls;
  if (!Array.isArray(urls)) return [];

  return dedupeRelatedLinks(
    urls
      .map((url) => ({
        url: url?.expanded_url || url?.url,
      }))
      .filter((link) => typeof link.url === "string" && link.url.trim().length > 0)
  );
}

function mergeRelatedLinks(
  extractedLinks: Array<{ url: string; title?: string }> | undefined,
  candidates: RelatedLinkCandidate[]
): Array<{ url: string; title?: string }> {
  const candidateByUrl = new Map(candidates.map((link) => [normalizeUrl(link.url), link]));
  const links = [...(extractedLinks || []), ...candidates]
    .map((link) => {
      const url = normalizeUrl(link.url);
      const candidate = candidateByUrl.get(url);
      const title = link.title?.trim() || candidate?.title?.trim();
      return { url, title: title || undefined };
    })
    .filter((link) => link.url.length > 0);

  return dedupeRelatedLinks(links);
}

function dedupeRelatedLinks<T extends { url: string; title?: string }>(links: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const link of links) {
    const url = normalizeUrl(link.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push({ ...link, url });
  }

  return deduped;
}

function normalizeUrl(url: string): string {
  return url.trim();
}

function formatRelatedLinkCandidates(candidates: RelatedLinkCandidate[]): string {
  if (candidates.length === 0) return "[]";
  return JSON.stringify(candidates, null, 2);
}
