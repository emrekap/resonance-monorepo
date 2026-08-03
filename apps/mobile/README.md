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
    (app)/                # signed-in: tabs
      index.tsx           #   Home — pick media → upload → analyze
      accounts.tsx        #   Connected accounts (list / connect / disconnect)
      analysis/[id].tsx   #   Poll GET /analyze/:id until the job settles
  components/             # themed primitives: Button, Card, ProgressBar, social buttons
  hooks/
    use-media-analysis.ts # pick → register → upload → enqueue, as one state machine
  lib/
    supabase.ts           # the auth client (AsyncStorage, PKCE, fg-only refresh)
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
   with the *user's* JWT — no base64, nothing held in JS memory, progress + cancel for free. The
   bucket's RLS policy (first path segment = a workspace you belong to) authorizes the write; the
   API never sees the bytes;
4. **analyze** — `POST /analyze { mediaAssetId }` verifies the object landed (signed-URL mint
   under the same RLS), flips it READY, queues the GPU job, and the app navigates to
   `analysis/[id]`, which polls every 2.5s until the status settles.

Images upload but stop at "saved" — TRIBE takes video/audio, so the app doesn't queue an analysis
the API would refuse. The bucket caps objects at 500 MiB and `video/* audio/* image/*` MIME types
(enforced by Storage, before RLS).

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
