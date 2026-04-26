/**
 * Canonicalize platform-specific URLs so the same channel/profile resolves to
 * one venue identity regardless of which URL form a source happens to use.
 *
 * Without this, the venue resolver matches by exact URL string, so a single
 * YouTube channel referenced as `youtu.be/UC...`, `youtube.com/@handle`, and
 * `youtube.com/channel/UC...` produces three separate venue rows.
 *
 * Scope: this only canonicalizes channel/profile URLs (venue identity).
 * Stream/video URLs (`youtube.com/watch?v=...`) are intentionally left alone —
 * those represent individual events, not venues, and merging them is a
 * separate problem (see TECH_DEBTS: "Stream URLs accepted as virtual venue
 * identity").
 */

const TRACKING_PARAMS = new Set([
  "si", "sid", "feature", "utm_source", "utm_medium", "utm_campaign",
  "utm_term", "utm_content", "ref", "ref_src", "ref_url",
]);

export function canonicalizeUrl(input: string | null | undefined): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";

  let url: URL;
  try {
    url = new URL(trimmed.match(/^[a-z]+:\/\//i) ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed;
  }

  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.protocol = "https:";
  for (const param of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) {
      url.searchParams.delete(param);
    }
  }

  const platform = detectPlatform(url.hostname);
  switch (platform) {
    case "youtube":
      return canonicalizeYouTube(url);
    case "twitch":
      return canonicalizeTwitch(url);
    case "niconico":
      return canonicalizeNiconico(url);
    default:
      return finalize(url);
  }
}

function detectPlatform(hostname: string): "youtube" | "twitch" | "niconico" | null {
  if (hostname === "youtube.com" || hostname === "youtu.be" || hostname === "m.youtube.com") {
    return "youtube";
  }
  if (hostname === "twitch.tv" || hostname === "m.twitch.tv") return "twitch";
  if (hostname === "nicovideo.jp" || hostname === "live.nicovideo.jp") return "niconico";
  return null;
}

function canonicalizeYouTube(url: URL): string {
  // youtu.be/<id> → leave as a video URL; videos are not venue identity.
  if (url.hostname === "youtu.be") {
    return finalize(url);
  }

  // m.youtube.com → youtube.com
  if (url.hostname === "m.youtube.com") url.hostname = "youtube.com";

  const path = url.pathname.replace(/\/+$/, "");

  // Channel forms: /channel/UCxxx, /@handle, /c/legacy, /user/legacy.
  // Strip everything after the identifier (e.g. /videos, /streams) so the
  // venue is the channel itself.
  const channelMatch =
    path.match(/^\/channel\/([^/]+)/) ||
    path.match(/^\/(@[^/]+)/) ||
    path.match(/^\/c\/([^/]+)/) ||
    path.match(/^\/user\/([^/]+)/);

  if (channelMatch) {
    const prefix = path.startsWith("/@") ? "/" : path.match(/^\/(channel|c|user)\//)![0];
    url.pathname = `${prefix}${channelMatch[1]}`;
    // Channel URLs don't need any query string.
    url.search = "";
  }

  return finalize(url);
}

function canonicalizeTwitch(url: URL): string {
  if (url.hostname === "m.twitch.tv") url.hostname = "twitch.tv";

  // twitch.tv/<channel> is the canonical form. Strip sub-paths like
  // /videos, /clips, /about so all references to one streamer collapse.
  const channelMatch = url.pathname.match(/^\/([^/]+)/);
  if (channelMatch && !["videos", "directory", "p", "search"].includes(channelMatch[1]!)) {
    url.pathname = `/${channelMatch[1]}`;
  }
  url.search = "";

  return finalize(url);
}

function canonicalizeNiconico(url: URL): string {
  // nicovideo.jp/user/<id> is the channel form. Live broadcasts under
  // live.nicovideo.jp/watch/<id> are videos, not venue identity — leave alone.
  if (url.hostname === "live.nicovideo.jp") {
    return finalize(url);
  }

  const userMatch = url.pathname.match(/^\/user\/([^/]+)/);
  if (userMatch) {
    url.pathname = `/user/${userMatch[1]}`;
    url.search = "";
  }

  return finalize(url);
}

function finalize(url: URL): string {
  // Drop trailing slash on the path (but keep root "/").
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  // Drop default fragments.
  url.hash = "";
  return url.toString();
}
