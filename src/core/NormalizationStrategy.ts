import { z } from "zod";

export const EVENT_TYPES = ["live_stream", "merchandise", "release", "concert", "broadcast", "collaboration", "side_event", "announcement"] as const;

export const EventExtractionSchema = z.object({
  title: z.string().min(1).describe("A short, descriptive title for the event. Preserve proper nouns and official titles in their original written form."),
  description: z.string().min(1).describe("A detailed English summary of the announcement. Preserve proper nouns and official titles in their original written form."),
  start_time: z.string().describe("ISO 8601 timestamp of when the event actually starts. If none is found, return the publish time of the source item."),
  end_time: z.string().optional().describe("ISO 8601 timestamp of when the event ends, if explicitly available."),
  venue_name: z.string().optional().describe("Name of the physical venue or virtual platform"),
  venue_url: z.string().optional().describe("URL to the stream, venue, or relevant event page"),
  related_links: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
  })).default([]).describe("Event-relevant links with URL and optional human-readable title"),
  type: z.enum(EVENT_TYPES).describe("The category of the event"),
  tags: z.array(z.string()).default([]).describe("List of relevant tags"),
});

export type EventType = typeof EVENT_TYPES[number];
export type ExtractedEvent = z.infer<typeof EventExtractionSchema>;

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

export interface NormalizationStrategy {
  supports(sourceName: string): boolean;
  buildContext(rawItem: any): SourceContext | null;
  buildPrompt(context: SourceContext): string;
  sanitize(rawItem: any, context: SourceContext, extracted: ExtractedEvent): ExtractedEvent;
  fallback(rawItem: any, context: SourceContext): ExtractedEvent;
}

export class DefaultNormalizationStrategy implements NormalizationStrategy {
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
- start_time must be an ISO 8601 timestamp for when the actual event, stream, sale, broadcast, release, or announcement happens.
- If no explicit event time is present, use this publish time: ${context.publishTime.toISOString()}.
- end_time should only be set when an explicit end time is available.
- related_links must contain only event-relevant candidate URLs and optional human-readable titles.
- type must be one of: ${EVENT_TYPES.join(", ")}.
- tags should be short labels such as artist names, group names, platforms, product names, or campaign names.
- Use "announcement" when the post is informational but does not fit a more specific type.

Venue rules:
- venue_name and venue_url describe where the event takes place.
- For physical venues, venue_name is the venue's actual name (e.g., "Tokyo Dome", "Yokohama Arena") and venue_url is the venue's official URL when available.
- For virtual platforms (YouTube, Twitch, NicoNico, Streaming+, Z-aN, etc.):
  - Prefer the channel or profile URL as venue_url (e.g., https://youtube.com/@channel_name).
  - Put the specific stream URL (e.g., https://youtube.com/watch?v=...) into related_links instead.
  - If only a stream URL is available and no channel URL can be inferred, you may use the stream URL as venue_url.
  - Never set venue_name to a bare platform name like "YouTube" without an accompanying venue_url. If no URL is available, leave both venue_name and venue_url unset.`;
  }

  sanitize(_rawItem: any, context: SourceContext, extracted: ExtractedEvent): ExtractedEvent {
    const fallback = this.fallback(_rawItem, context);
    const startTime = parseDateOrFallback(extracted.start_time, fallback.start_time);
    const endTime = extracted.end_time ? parseDateOrFallback(extracted.end_time, startTime.toISOString()) : undefined;

    return {
      title: extracted.title?.trim() || fallback.title,
      description: extracted.description?.trim() || fallback.description,
      start_time: startTime.toISOString(),
      end_time: endTime?.toISOString(),
      venue_name: extracted.venue_name?.trim() || undefined,
      venue_url: extracted.venue_url?.trim() || fallback.venue_url,
      related_links: mergeRelatedLinks(extracted.related_links, context.relatedLinkCandidates),
      type: EVENT_TYPES.includes(extracted.type) ? extracted.type : fallback.type,
      tags: Array.isArray(extracted.tags) ? extracted.tags.map((tag) => tag.trim()).filter(Boolean) : fallback.tags,
    };
  }

  fallback(_rawItem: any, context: SourceContext): ExtractedEvent {
    const title = buildFallbackTitle(context.text);

    return {
      title,
      description: context.text.trim() || title,
      start_time: context.publishTime.toISOString(),
      venue_url: extractFirstUrl(context.text),
      related_links: mergeRelatedLinks([], context.relatedLinkCandidates),
      type: "announcement",
      tags: extractHashTags(context.text),
    };
  }
}

export class TwitterNormalizationStrategy extends DefaultNormalizationStrategy {
  supports(sourceName: string): boolean {
    return sourceName === "twitter";
  }

  buildContext(rawItem: any): SourceContext | null {
    const legacy = rawItem.rawData?.legacy;
    if (!legacy) return null;

    const text = legacy.full_text || "";
    if (!text.trim()) return null;

    const author = rawItem.rawData?.core?.user_results?.result?.legacy?.screen_name || "unknown";
    const publishTime = parseDateOrFallback(legacy.created_at, new Date().toISOString());
    const relatedLinkCandidates = extractTwitterLinkCandidates(rawItem);

    return {
      text,
      publishTime,
      author,
      url: `https://x.com/${author}/status/${rawItem.sourceId}`,
      relatedLinkCandidates,
      rawContent: `[Posted at: ${legacy.created_at || publishTime.toISOString()}]\n\n${text}`,
    };
  }
}

export function createDefaultNormalizationStrategies(): NormalizationStrategy[] {
  return [
    new TwitterNormalizationStrategy(),
    new DefaultNormalizationStrategy(),
  ];
}

export function parseDateOrFallback(value: string | undefined, fallbackIso: string): Date {
  const parsed = value ? new Date(value) : new Date(fallbackIso);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const fallback = new Date(fallbackIso);
  return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

function buildFallbackTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) return "Untitled announcement";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function extractHashTags(text: string): string[] {
  return [...new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((match) => match[1]))];
}

function extractFirstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
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
