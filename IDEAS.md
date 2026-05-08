# Ideas

Forward-looking ideas not yet scoped into a phase. Promote to `design_docs/` or `design_docs/2026-04-23-implementation-plan/plan.md` once an idea is ready to be planned.

## Fan engagement

- **Track fan hashtags.** Extend the watch-list model so a target can be a hashtag (e.g. `#artist_fanart`) in addition to an account handle. Ingestion would pull recent posts under the hashtag through the same source connector path. Open questions: dedup vs. account-sourced posts, spam filtering, how hashtag-derived items relate to canonical events (probably non-event content, so they may bypass extraction/resolution and live as a separate content stream).
- **Recent fan-art carousel in the web UI.** A Phase 6 web-UI surface that displays a carousel of recent fan-art posts for an artist, sourced from the hashtag tracking above (or from accounts tagged as fan-art-friendly). Likely a per-artist page component; needs a media-aware item shape (image URL, source link, author handle, posted-at).
