/**
 * YouTube Data API v3, read-only and public.
 *
 * Channel-first traversal, never discovery: `playlistItems.list` and
 * `videos.list` cost **1 quota unit each** while `search.list` costs **100**,
 * so walking ~40 seeded channels costs low hundreds of units against the
 * 10,000/day default. The statistically correct shape and the quota-cheap shape
 * are the same shape (spec §5a) — discovery is what is expensive, and this
 * client does none.
 *
 * Authenticated with a plain API key, not the OAuth client in `apps/api`: every
 * field here is public, and nothing acts on behalf of a user.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** `videos.list` accepts 50 ids per call, for the same 1 unit as one id. */
export const VIDEOS_BATCH = 50;

/** `playlistItems.list` page size. */
const PLAYLIST_PAGE = 50;

export interface YouTubeChannel {
  id: string;
  title: string | null;
  uploadsPlaylistId: string | null;
  /** Null when the channel hides it — NOT zero, which would read as a real count. */
  subscriberCount: number | null;
}

export interface YouTubeVideo {
  id: string;
  channelId: string;
  publishedAt: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  /**
   * The raw ISO-8601 string (`PT29S`). Parsing belongs with the inclusion rule
   * it feeds (`duration.ts`), so a duration this client cannot understand stays
   * reportable as an exclusion instead of being dropped here.
   */
  duration: string | null;
  /** `creativeCommon` or `youtube` — free on this call, and §7 depends on it. */
  license: string | null;
  privacyStatus: string | null;
  views: number | null;
  /** Null when the creator hides like counts. */
  likes: number | null;
  comments: number | null;
}

export interface YouTubeClient {
  channels(ids: string[]): Promise<YouTubeChannel[]>;
  /** Video ids from a uploads playlist, newest first, capped at `limit`. */
  uploads(playlistId: string, limit: number): Promise<string[]>;
  videos(ids: string[]): Promise<YouTubeVideo[]>;
}

interface ChannelsResponse {
  items?: {
    id: string;
    snippet?: { title?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
    statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  }[];
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items?: { contentDetails?: { videoId?: string } }[];
}

interface VideosResponse {
  items?: {
    id: string;
    snippet?: {
      channelId?: string;
      publishedAt?: string;
      title?: string;
      description?: string;
      tags?: string[];
    };
    contentDetails?: { duration?: string };
    status?: { license?: string; privacyStatus?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }[];
}

/**
 * A count the API omits is genuinely absent, not zero.
 *
 * `likeCount` is missing when the creator hid likes and `subscriberCount` when
 * the channel hid subscribers — both of which are real, common states. Reading
 * either as `0` would put a fabricated number into the secondary outcome's
 * numerator or the B1 rung's follower covariate.
 */
function count(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/poller/.env.example`);
  return value;
}

export function createYouTubeClient(
  options: { apiKey?: string; fetch?: typeof fetch } = {},
): YouTubeClient {
  const fetchImpl = options.fetch ?? fetch;
  const apiKey = options.apiKey ?? required('YOUTUBE_API_KEY');

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('key', apiKey);

    const response = await fetchImpl(url);
    if (!response.ok) {
      // The status is the whole diagnosis here: 403 is almost always quota or a
      // key restriction, 404 a deleted channel. The URL is deliberately NOT in
      // the message — it carries the key.
      throw new Error(`youtube ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  return {
    async channels(ids) {
      const out: YouTubeChannel[] = [];
      for (const batch of chunk(ids, VIDEOS_BATCH)) {
        const body = await get<ChannelsResponse>('channels', {
          part: 'snippet,contentDetails,statistics',
          id: batch.join(','),
          maxResults: String(VIDEOS_BATCH),
        });
        for (const item of body.items ?? []) {
          out.push({
            id: item.id,
            title: item.snippet?.title ?? null,
            uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
            subscriberCount: item.statistics?.hiddenSubscriberCount
              ? null
              : count(item.statistics?.subscriberCount),
          });
        }
      }
      return out;
    },

    async uploads(playlistId, limit) {
      const ids: string[] = [];
      let pageToken: string | undefined;

      do {
        const body = await get<PlaylistItemsResponse>('playlistItems', {
          part: 'contentDetails',
          playlistId,
          maxResults: String(Math.min(PLAYLIST_PAGE, limit - ids.length)),
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of body.items ?? []) {
          const videoId = item.contentDetails?.videoId;
          if (videoId) ids.push(videoId);
          if (ids.length >= limit) return ids;
        }
        pageToken = body.nextPageToken;
      } while (pageToken);

      return ids;
    },

    async videos(ids) {
      const out: YouTubeVideo[] = [];
      for (const batch of chunk(ids, VIDEOS_BATCH)) {
        const body = await get<VideosResponse>('videos', {
          // `status` is what carries `license`, and it is free on this call —
          // which is what lets §7 be deferred without a later re-crawl.
          part: 'snippet,contentDetails,statistics,status',
          id: batch.join(','),
          maxResults: String(VIDEOS_BATCH),
        });
        for (const item of body.items ?? []) {
          out.push({
            id: item.id,
            channelId: item.snippet?.channelId ?? '',
            publishedAt: item.snippet?.publishedAt ?? null,
            title: item.snippet?.title ?? null,
            description: item.snippet?.description ?? null,
            tags: item.snippet?.tags ?? [],
            duration: item.contentDetails?.duration ?? null,
            license: item.status?.license ?? null,
            privacyStatus: item.status?.privacyStatus ?? null,
            views: count(item.statistics?.viewCount),
            likes: count(item.statistics?.likeCount),
            comments: count(item.statistics?.commentCount),
          });
        }
      }
      return out;
    },
  };
}
