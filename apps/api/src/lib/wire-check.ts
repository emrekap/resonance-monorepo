import type { AnalysisStatus, MediaKind } from '@repo/db';
import { ANALYSIS_STATUS, MEDIA_KIND } from './wire';

/**
 * Proves [`wire.ts`](./wire.ts) still covers the Postgres enums.
 *
 * It lives in its own file because `wire.ts` must not reference `@repo/db` at
 * all — see the comment there. Nothing imports this module, and nothing should:
 * `tsc` typechecks every file under `src/`, so `bun run typecheck` fails here
 * the moment a `@@map`ped enum gains a value that `wire.ts` does not map, which
 * is the whole job. Declaration emit produces a `wire-check.d.ts` that
 * `dist/app.d.ts` never references, so the `@repo/db` import above cannot reach
 * a client typecheck.
 *
 * If either line below errors, add the missing case to `wire.ts`.
 */

ANALYSIS_STATUS satisfies Record<AnalysisStatus, string>;
MEDIA_KIND satisfies Record<MediaKind, string>;
