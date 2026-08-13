/**
 * `@repo/scoring` — the pure band → composite reduction, shared by the process
 * that scores customer analyses (`apps/worker`) and the one that scores the
 * research corpus (`apps/poller`).
 *
 * Holds no Prisma and no queue client: it is a reduction over `AxisBands`, and
 * that is all.
 */
export { BAND_SUMMARY, COMPOSITE_WEIGHTS, band, composite } from './composite.ts';
