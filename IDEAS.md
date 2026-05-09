# Ideas

Forward-looking ideas not yet scoped into a phase. Promote to `design_docs/` or `design_docs/2026-04-23-implementation-plan/plan.md` once an idea is ready to be planned.

## Fan engagement

- **Track fan hashtags.** Extend the watch-list model so a target can be a hashtag (e.g. `#artist_fanart`) in addition to an account handle. Ingestion would pull recent posts under the hashtag through the same source connector path. Open questions: dedup vs. account-sourced posts, spam filtering, how hashtag-derived items relate to canonical events (probably non-event content, so they may bypass extraction/resolution and live as a separate content stream).
- **Recent fan-art carousel in the web UI.** A Phase 6 web-UI surface that displays a carousel of recent fan-art posts for an artist, sourced from the hashtag tracking above (or from accounts tagged as fan-art-friendly). Likely a per-artist page component; needs a media-aware item shape (image URL, source link, author handle, posted-at).
- **Embedded Twitch / YouTube live stream in the web UI.** Surface a currently-live stream for an artist on their Phase 6 page via the platform's embed iframe. Scope TBD (live-state detection, which channels to track, fallback when offline).
- **Content filters for the Feed rail.** The Feed rail (raw post timeline) landed in Phase 6 without filters — just the firehose. Add toggles to filter by content type — e.g. hide pure retweets, show only event announcements — once the unfiltered feed is lived in long enough to know which toggles matter.

## Merchandise & commerce

- **Shopify stock lookup integration.** Pull stock availability from Shopify-backed artist/agency stores. Scope TBD (use case, target stores, mapping to events/artists).

## Ranking & discovery

- **Hype index.** Per-event score for ranking / surfacing buzz. Initial sketch:

  ```
  hype = 0.40 · log(source_count)
       + 0.25 · log(distinct_authors)
       + 0.15 · platform_diversity        // 0..1, # distinct source_name / 4
       + 0.15 · recency_decay(max_publish_time)
       + 0.05 · related_link_count
       − (cancelled ? 1 : 0)
  ```

  Refinements before implementing: use `log(1 + x)` to avoid `log(0)`; normalize each term to ~[0,1] so the weights mean what they say (currently `log(source_count)` is unbounded vs. `platform_diversity` capped at 1); the `/ 4` in `platform_diversity` will rot as Phase 7 adds sources, so divide by current registry size; pick a direction for `recency_decay` (publish time vs. proximity to event date); the −1 cancelled penalty effectively zeros the score, so consider filtering cancelled events from ranking instead. Future signals to fold in once the data exists: ticket lottery / FC presale entries, user intent (calendar adds, alert subs, "going" toggles — needs a user table), follower/reach counts per author. Pairs with Web UI (Phase 6) for ranking; only becomes meaningful once Multi-Source (Phase 7) is in.
