/**
 * DB enum → wire literal.
 *
 * `AppType` is consumed by the Expo and Next typechecks, whose tsconfigs are
 * not Bun's. The moment a response type names anything from `@repo/db` — even
 * an enum — declaration emit puts `import("@repo/db")` in the boundary, those
 * typechecks resolve the generated Prisma client, and `@repo/api-contract`
 * fails on the client's `.ts` imports before a route is ever called. So every
 * enum crossing into a response is mapped to a plain literal here first.
 *
 * **This file imports nothing from `@repo/db` on purpose** — not even
 * `import type`. A type-only import is still a module reference that TypeScript
 * follows out of `dist/app.d.ts`, which is exactly the failure above. The keys
 * below are spelled out, and [`wire-check.ts`](./wire-check.ts) is what proves
 * they still match the Postgres enums.
 *
 * After building, this must come back empty:
 *
 * ```bash
 * grep '@repo/db' apps/api/dist/app.d.ts
 * ```
 */

export const ANALYSIS_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/** What a client sees in `status`. */
export type WireAnalysisStatus = (typeof ANALYSIS_STATUS)[keyof typeof ANALYSIS_STATUS];

export function toWireAnalysisStatus(status: keyof typeof ANALYSIS_STATUS): WireAnalysisStatus {
  return ANALYSIS_STATUS[status];
}

export const MEDIA_KIND = {
  VIDEO: 'video',
  AUDIO: 'audio',
  IMAGE: 'image',
} as const;

/** What a client sees in `media.kind`. Matches `@repo/queue`'s modality literals. */
export type WireMediaKind = (typeof MEDIA_KIND)[keyof typeof MEDIA_KIND];

export function toWireMediaKind(kind: keyof typeof MEDIA_KIND): WireMediaKind {
  return MEDIA_KIND[kind];
}
