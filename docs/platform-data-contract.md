# Per-Platform Data Contract — YouTube / Instagram / TikTok

> **Status:** research notes, verified against current API docs (2026-08-02). Drill-down of §4
> of [resonance-model-design.md](resonance-model-design.md). Defines exactly which fields the
> calibration model can pull from each platform, which become the **label** vs. the **fallback**,
> and the ToS/access constraints that shape how we build the training corpus.

**The headline asymmetry:** the golden *temporal* label (a per-second retention curve) only really
exists on **YouTube**. Instagram gives scalar watch-time; TikTok gives engagement counts only. This
should drive platform strategy — YouTube-led for validation, IG for scale, TikTok as fallback.

---

## YouTube — the only source of the golden (temporal) label

**Two APIs, different jobs:**

- **Data API v3** (public, any video): `snippet` (title, description, tags, publishedAt),
  `contentDetails` (duration, caption availability), `statistics` (viewCount, likeCount,
  commentCount). Metadata + coarse counts.
- **Analytics API** (OAuth, channel owner — scope `yt-analytics.readonly`): the real prize.

**The retention curve (golden label):** query metrics **`audienceWatchRatio`** and
**`relativeRetentionPerformance`** against the **`elapsedVideoTimeRatio`** dimension → a per-position
curve across the video:

- `audienceWatchRatio` — absolute: how many times each portion was watched vs. total views.
- `relativeRetentionPerformance` — 0–1, retention *vs. other YouTube videos of similar length*
  (0.5 = median). **Already length-normalized** — partly solves the confounder problem out of the box.

**Scalar labels + confounder controls (per-video, per-day):** `views`, `estimatedMinutesWatched`,
`averageViewDuration`, `averageViewPercentage`, `likes`, `comments`, `shares`, `subscribersGained`,
plus traffic sources and demographics. `averageViewPercentage` is a clean scalar completion label;
`views`/impressions give the denominator for engagement-rate normalization.

**Verdict:** YouTube alone supports the **timeline head** (`retention(t) = f(features(t))`,
row-for-row) *and* the scalar/ranking head. **Run the validation cohort on YouTube first.**

---

## Instagram — scalar watch-time, no curve

**Access:** Instagram **Graph API** only (Basic Display is sunset). Requires a **Professional/Creator
account linked to a Facebook Page**, Facebook Login, permissions `instagram_basic` +
`instagram_manage_insights`, and **Meta app review** for advanced access.

**Per-Reel insights** via `GET /{ig-media-id}/insights`:

- Engagement: `likes`, `comments`, `shares`, `saved`, `reach`, `views` (formerly `plays`),
  `total_interactions`.
- **Watch-time (the useful part):** **`ig_reels_avg_watch_time`** (avg per view, in **ms** — convert)
  and **`ig_reels_video_view_total_time`** (total watch time incl. replays).

**Watch out — Meta deprecated a batch of metrics on Jan 8 2025 (Graph API v21):** `video_views` for
non-Reels, `profile_views`, `impressions` in several contexts, website/email/phone-click metrics.
Meta is consolidating onto **"views."** Build against v21+ field names, not old tutorials.

**Verdict:** solid **scalar watch-time label** (avg + total) and `reach` for normalization — good for
the ranking/scalar head. **No per-second retention curve**, so it can't feed the timeline head
directly (average only).

---

## TikTok — counts only (fallback), unless business-tier

**Consumer creators → Display API** (`/v2/video/query/`, TikTok Login Kit, scope `video.list`):
metadata (`id`, `create_time`, `duration`, `cover_image_url`, `share_url`, `video_description`,
`title`) and engagement **counts**: `view_count`, `like_count`, `comment_count`, `share_count`,
sometimes `collect_count` (saves). **No watch-time, no retention, no reach.**

- **Research API** adds fields (`favorites_count`, `region_code`, `music_id`, `hashtag_names`) but is
  **access-restricted** (approved researchers, largely non-commercial, strict data-deletion
  requirements) — not a product foundation.
- Richer watch metrics (average watch time, full-video-watched rate) exist only via TikTok's
  **Business/Marketing API for Business accounts** — a separate access path; verify scope before
  depending on it.

**Verdict:** for the typical creator, **fallback-tier** — engagement counts only. With only
`view_count` (no `reach`/impressions), even engagement-rate normalization is weaker than on YT/IG.

---

## Summary — map to the model heads

| | Retention curve (timeline head) | Watch-time scalar | Engagement counts | Normalizer |
|---|---|---|---|---|
| **YouTube** | ✅ `audienceWatchRatio` + `relativeRetentionPerformance` × `elapsedVideoTimeRatio` | ✅ `averageViewDuration`, `averageViewPercentage` | ✅ likes/comments/shares | ✅ views, impressions |
| **Instagram** | ❌ (average only) | ✅ `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time` | ✅ likes/comments/shares/saves | ✅ reach, views |
| **TikTok** | ❌ | ⚠️ Business API only | ✅ view/like/comment/share/collect | ⚠️ view_count only |

**Label strategy that falls out of this:** golden temporal label = **YouTube**; scalar watch-time
label = **YouTube + Instagram**; universal fallback = **engagement-rate ranking on all three**. The
timeline/retention validation should be YouTube-led; the cross-platform product runs on the ranking
head (also the most defensible per the model design).

---

## Two cross-cutting gotchas people forget

1. **The label is only half of backfill — you also need the *video file* to extract TRIBE features,
   and platforms don't hand you the source MP4.** IG's `media_url` gives a (temporary, expiring)
   video URL; YouTube and TikTok offer **no official source download**, and scraping the stream is a
   ToS minefield. Practical answer: for a creator's *own* content, have them authorize/upload, or
   capture the media at post time going forward. This is a separate acquisition problem from analytics.
2. **Storage/ToS limits on what you can persist.** All three restrict retention of API data and
   require **deletion when a user disconnects** (Meta data-use policy; TikTok deletion windows;
   YouTube API Services ToS has explicit persistence limits — historically ~30 days for certain data,
   verify current terms). You likely need to **derive and store features + labels, then discard raw
   platform data**, rather than warehousing raw API responses.

---

## Open decision

Which platform to require at signup. Lean: **YouTube-first for the validation cohort** (only source
of the temporal golden label), **Instagram for scale** (scalar watch-time + large creator base),
**TikTok as fallback** (counts-only ranking).

---

**Sources:** [YouTube Analytics metrics](https://developers.google.com/youtube/analytics/metrics),
[YouTube channel reports](https://developers.google.com/youtube/analytics/channel_reports),
[TikTok Display API overview](https://developers.tiktok.com/doc/display-api-overview),
[TikTok Research video query](https://developers.tiktok.com/doc/research-api-specs-query-videos/),
[Instagram Reels API guide (Phyllo)](https://www.getphyllo.com/post/real-time-reels-analytics-using-instagram-reels-api-iv),
[Instagram Graph API guide 2026 (Elfsight)](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/).
