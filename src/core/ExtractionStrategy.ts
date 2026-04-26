import { z } from "zod";

export const EVENT_TYPES = ["live_stream", "merchandise", "release", "concert", "broadcast", "collaboration", "side_event"] as const;
export const EVENT_SCOPES = ["main", "sub", "unknown"] as const;

export const EventExtractionSchema = z.object({
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
  tags: z.array(z.string()).default([]).describe("List of relevant tags"),
});

export type EventType = typeof EVENT_TYPES[number];
export type EventScope = typeof EVENT_SCOPES[number];
export type EventExtractionResult = z.infer<typeof EventExtractionSchema>;

export interface SourceContext {
  text: string;
  publishTime: Date;
  author: string;
  url: string;
  relatedLinkCandidates: RelatedLinkCandidate[];
  rawContent: string;
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
    return `You parse social media announcements into structured event records for a fan activity tracker.

Input text:
"${context.rawContent}"

Related link candidates:
${formatRelatedLinkCandidates(context.relatedLinkCandidates)}

Language rules:
- Write explanatory prose in English.
- Do not translate, romanize, or rewrite proper nouns.
- Preserve artist names, group names, concert titles, song titles, album titles, venue names, campaign names, hashtags, and quoted official titles exactly as written in the source text.
- If a title combines an English summary with an official name, keep the official name in its original written form.

Extraction rules:
- Extract the specific activity described by the source post. A post may announce a main event, or it may announce a sub-event such as a merch sale, ticket lottery, meet-and-greet, pre-show, after-show, campaign, booth, or stream related to a larger main event.
- start_time should be an ISO 8601 timestamp for when the extracted activity happens, if the source gives an explicit time or enough context to infer it safely.
- Leave start_time unset when the source announces a real activity but does not provide the activity's own time. Do not use the source publish time as start_time.
- end_time should only be set when an explicit end time is available.
- related_links must contain only event-relevant candidate URLs and optional human-readable titles.
- type must be one of: ${EVENT_TYPES.join(", ")}.
- event_scope must be "main" for a standalone/main event, "sub" for an activity that belongs under a larger event, or "unknown" when the relationship is unclear.
- parent_event_hint should be set only when event_scope is "sub" and the source names or clearly implies the larger/main event. Use the official title exactly as written. If the main event is not named, leave parent_event_hint unset.
- tags should be short labels such as artist names, group names, platforms, product names, or campaign names.
- Classify the underlying activity being announced, not the wording of the post. For example, an informational post announcing a scheduled concert is type "concert"; a post announcing a merch sale is type "merchandise".
- Do not invent a main event that is not named or clearly implied by the source. It is okay to extract a sub-event with parent_event_hint unset.
- Do not use a generic "announcement" category. If the post does not announce, update, schedule, cancel, or link to a specific activity in one of the allowed event types, return an empty JSON object so validation fails.

Venue rules:
- venue_name and venue_url describe where the event takes place.
- For physical venues, venue_name is the venue's actual name (e.g., "Tokyo Dome", "Yokohama Arena") and venue_url is the venue's official URL when available.
- For virtual platforms (YouTube, Twitch, NicoNico, Streaming+, Z-aN, etc.):
  - Prefer the channel or profile URL as venue_url (e.g., https://youtube.com/@channel_name).
  - Put the specific stream URL (e.g., https://youtube.com/watch?v=...) into related_links instead.
  - If only a stream URL is available and no channel URL can be inferred, you may use the stream URL as venue_url.
  - Never set venue_name to a bare platform name like "YouTube" without an accompanying venue_url. If no URL is available, leave both venue_name and venue_url unset.`;
  }

  sanitize(_rawItem: any, _context: SourceContext, extracted: EventExtractionResult): EventExtractionResult {
    const title = requireNonEmpty(extracted.title, "title");
    const description = requireNonEmpty(extracted.description, "description");
    const startTime = extracted.start_time ? parseDateOrThrow(extracted.start_time, "start_time") : undefined;
    const endTime = extracted.end_time ? parseDateOrThrow(extracted.end_time, "end_time") : undefined;
    const eventScope = EVENT_SCOPES.includes(extracted.event_scope) ? extracted.event_scope : "unknown";

    return {
      title,
      description,
      start_time: startTime?.toISOString(),
      end_time: endTime?.toISOString(),
      venue_name: extracted.venue_name?.trim() || undefined,
      venue_url: extracted.venue_url?.trim() || undefined,
      related_links: mergeRelatedLinks(extracted.related_links, _context.relatedLinkCandidates),
      type: extracted.type,
      event_scope: eventScope,
      parent_event_hint: eventScope === "sub" ? extracted.parent_event_hint?.trim() || undefined : undefined,
      tags: Array.isArray(extracted.tags) ? extracted.tags.map((tag) => tag.trim()).filter(Boolean) : [],
    };
  }
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

    const author = rawItem.rawData?.core?.user_results?.result?.legacy?.screen_name || "unknown";
    const publishTime = parseDateOrDefault(legacy.created_at, new Date().toISOString());
    const relatedLinkCandidates = extractTwitterLinkCandidates(rawItem);

    return {
      text,
      publishTime,
      author,
      url: `https://x.com/${author}/status/${rawItem.sourceId}`,
      relatedLinkCandidates,
      rawContent: text,
    };
  }
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

function parseDateOrThrow(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
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
