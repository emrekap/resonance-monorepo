# apps/mobile

**Expo / React Native** app — the primary Resonance client. Expo SDK 57, `expo-router`, TanStack
Query, `supabase-js` for auth. Data goes through the Bun API via the Hono RPC client
(`hc<AppType>` from [`@repo/api-contract`](../../packages/api-contract)) — the app never queries
Postgres directly, and typesafety comes from importing the API's `AppType`, no codegen.

## Layout — two worlds, guarded at the root

```text
src/
  app/
    _layout.tsx           # providers + Stack.Protected guards — THE auth gate
    (onboarding)/         # signed-out: welcome → sign-in / sign-up (modals)
    (app)/                # signed-in: Stack (mounts the realtime subscription)
      (tabs)/             #   the tab bar, and only the tab bar
        index.tsx         #     Home — pick media → upload → analyze
        history.tsx       #     Every analysis — paged, filtered, sorted
        accounts.tsx      #     Connected accounts (list / connect / disconnect)
      analysis/[id].tsx   #   pushed: GET /analyze/:id, refreshed by realtime
      settings.tsx        #   pushed: theme preference — auto / light / dark
  design/                 # tokens, Theme type, ThemeProvider — see ../DESIGN.md
  components/
    ui/                   # design-system primitives: Text, Screen, Surface, Card, Button, Chip, Meter, Badge, Bloom, Score
    analysis-row.tsx      # one history row: score/status, name, age
    social-button.tsx, social-auth-panel.tsx
  hooks/
    use-media-analysis.ts # pick → register → upload → enqueue, as one state machine
    use-analyses.ts       # GET /analyze paged (useInfiniteQuery)
    use-analysis-realtime.ts # analyses changes → query invalidation, mounted in (app)/_layout
  lib/
    supabase.ts           # the auth client (AsyncStorage, PKCE, fg-only refresh)
    query-keys.ts         # the TanStack keys, in one place so realtime can invalidate them
    auth.ts               # signInWithProvider / createSessionFromUrl
    api.ts                # RPC client, injects the Supabase access token
    media.ts              # pickers + the streaming Storage upload (UploadTask)
    social.ts             # login-provider + connectable-platform registries
  providers/
    session-provider.tsx  # the one piece of auth state everything derives from
```

The root layout is the only place auth is checked: `Stack.Protected guard={session !== null}`
mounts `(app)`, its inverse mounts `(onboarding)`. Screens never redirect on auth themselves —
login/logout is the session state flipping and the router swapping stacks.

Inside `(app)` the Stack wraps the tabs rather than the other way round. `analysis/[id]` and
`settings` are pushed from inside a tab, and a screen only gets a back button and an edge-swipe if
something pushed a card — as hidden tabs (`href: null`) they were reached by a tab _switch_, which
renders no card. So they sit beside `(tabs)` on the Stack and cover the tab bar, which is correct:
they are destinations, not a fourth and fifth tab. The consequence is that navigating between a
tab and one of them is a stack operation — `router.navigate` / `dismissTo`, never `push`/`replace`,
or you stack a second copy of the entire tab bar on top of the first.

## Auth — Supabase OAuth in a browser tab (PKCE)

Sign-in and sign-up are social-only (Google today). Both screens share `SocialAuthPanel`, which
calls `signInWithProvider('google')`:

1. `supabase.auth.signInWithOAuth({ skipBrowserRedirect: true, redirectTo })` mints the consent URL,
2. `expo-web-browser.openAuthSessionAsync` runs the consent,
3. the deep link back carries `?code=`, exchanged via `exchangeCodeForSession` (PKCE — only this
   app instance holds the verifier).

The browser flow over per-provider native SDKs on purpose: one code path serves Google now and
Facebook/TikTok later with zero native config beyond the `resonance` scheme, and it runs in Expo
Go. If the browser hop ever hurts conversion, swap Google to `signInWithIdToken` +
`@react-native-google-signin` behind the same `signInWithProvider` signature.

Providers are declared in [`src/lib/social.ts`](src/lib/social.ts) — adding Facebook login later is
one entry flip once the provider is enabled in the Supabase dashboard.

**Supabase dashboard setup** (once per project):

- Auth → Providers → enable **Google** (client id + secret from Google Cloud Console).
- Auth → URL Configuration → Redirect URLs: add `resonance://**` (builds) and `exp://**` (Expo Go).

## Uploads — straight to Storage, analysis over the queue

The home screen's analyze flow ([`use-media-analysis.ts`](src/hooks/use-media-analysis.ts)) is a
four-phase pipeline:

1. **pick** — `expo-image-picker` for video/photos, `expo-document-picker` (`audio/*`) for music;
2. **register** — `POST /media` writes the `media_assets` row and answers with the Storage
   location (`media` bucket, `{workspace_id}/{asset_id}`);
3. **upload** — `expo-file-system`'s `UploadTask` streams the file from disk to Supabase Storage
   with the _user's_ JWT — no base64, nothing held in JS memory, progress + cancel for free. The
   bucket's RLS policy (first path segment = a workspace you belong to) authorizes the write; the
   API never sees the bytes;
4. **analyze** — `POST /analyze { mediaAssetId }` verifies the object landed (signed-URL mint
   under the same RLS), flips it READY, queues the GPU job, and the app navigates to
   `analysis/[id]`, which refreshes when Realtime reports the row changed.

Images upload but stop at "saved" — TRIBE takes video/audio, so the app doesn't queue an analysis
the API would refuse. The bucket caps objects at 500 MiB and `video/* audio/* image/*` MIME types
(enforced by Storage, before RLS).

## History — the list, and what it does not have

[`history.tsx`](<src/app/(app)/history.tsx>) is `GET /analyze` through
[`use-analyses.ts`](src/hooks/use-analyses.ts): `useInfiniteQuery` over the API's `limit`/`offset`
envelope, next offset taken from the page the server just described rather than counted here.

- **Filters are the query key**, so a chip flip refetches from offset 0 while TanStack keeps the
  previous rows mounted — no empty flash between filter states.
- **"Running" is two statuses** (`QUEUED` + `PROCESSING`), sent as a repeated `?status=` param.
- **Nothing polls.** `use-analysis-realtime.ts`, mounted once in `(app)/_layout.tsx`, subscribes to
  `postgres_changes` on `public.analyses` and invalidates `['analyses']` — a signal, not a row
  patch, since a list row also needs `analysis_results` and `media_assets` that only `GET /analyze`
  joins. It re-invalidates on app resume too: a backgrounded socket drops and misses events.
- **Filter state is not persisted.** Nothing deep-links into a filtered history, and a tab that
  reopens on "All" is what a user expects.

**A row's columns are all optional, and one of them is optional on purpose.** `durationSec` is
written by `apps/worker` but null on anything analysed before it was; `fileName` is null for
URL-registered assets. `resonanceScore` is the interesting one: it is written now — a rank against
the workspace's own prior analyses — but **withheld below five priors**, because a rank against a
history that does not exist is not a number
([`apps/worker/README.md`](../worker/README.md#scoring--scoringts)). So a new workspace's first four
analyses legitimately have no score, forever, and that is not a loading state.

The row composes its subtitle from whichever parts exist and shows a status dot where the score
goes, so none of these read as broken — and it is why `file_name` exists, or every row would say
"Video" and nothing else.

The result screen says which of those it is: `<Score>` renders its `caption` in the **null** branch
too, so `analysis/[id]` can pass _"Baseline — analyze a few more to see how this one ranks"_ for a
withheld score and the component never has to guess why a number is missing. It previously dropped
the caption in exactly that branch and hardcoded _"waiting on model calibration"_ — copy that was
already untrue when scoring shipped, and unreachable-by-design for the one case it described.

## Connected accounts — data access, not login

Signing in with Google proves who you are. Connecting YouTube grants the **API** offline access to
channel analytics — different OAuth, different owner (`apps/api` holds those secrets; this app
never sees a platform token). A workspace can hold several accounts per platform, so the accounts
screen renders a flat list plus per-platform connect buttons, never a boolean toggle.

```text
accounts.tsx ── POST /connected-accounts/youtube/start { returnTo } ──▶ { url }
             ── openAuthSessionAsync(url) ──▶ Google consent ──▶ API callback
             ◀── deep link resonance://accounts?connected=youtube ── 302 ──┘
```

On return the screen just refetches. Cold-start deep links land through the same route via
`useLocalSearchParams`. Instagram/TikTok buttons ship disabled until their providers land in
`apps/api/src/lib/platforms.ts`.

Platform/status enums come from **`@repo/db/browser`** — the browser-safe Prisma entry (model +
enum types, no `PrismaClient`), verified to typecheck under this app's tsconfig.

## Run it

```bash
bun install                       # repo root — links workspaces
bunx turbo run build              # once: emits apps/api dist/app.d.ts (AppType for editors)
cp apps/mobile/.env.example apps/mobile/.env   # fill in Supabase URL/key + API URL
cd apps/mobile && bun run start   # Expo Go / dev build; needs apps/api running for data
```

On a physical device `EXPO_PUBLIC_API_URL` must be the machine's LAN IP, not `localhost` — and the
API's `API_PUBLIC_URL` must match, or Google's redirect lands somewhere the phone can't see.

## Conventions

- `tsconfig.json` extends `["@repo/tsconfig/react-native.json", "expo/tsconfig.base"]` — expo
  **last** so its RN options win.
- Import `@repo/db` **only** via `/browser` or `/enums` — the barrel drags Bun-only server code
  into this typecheck.
- New API calls: use the `api` client from `src/lib/api.ts` inside TanStack Query — it attaches
  the (auto-refreshed) access token per request.
