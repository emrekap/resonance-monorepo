/**
 * `@repo/queue` — the contract between `apps/api`, `apps/ml` and `apps/worker`.
 *
 * Queue names, key prefix, payload schemas and the Redis connection factory.
 * Deliberately holds no Prisma and no Hono: it is imported by a producer, a
 * consumer, and (mirrored by hand) a Python process.
 *
 * See `src/contract.ts` for the flow diagram.
 */
export { createRedisConnection, redisUrl, DEFAULT_JOB_OPTIONS } from './connection.ts';

export {
  QUEUE_PREFIX,
  ANALYSIS_QUEUE,
  ANALYSIS_RESULTS_QUEUE,
  ANALYZE_JOB,
  RESULT_JOB,
  modalitySchema,
  analysisJobSchema,
  timelineSchema,
  axisBandsSchema,
  axisSummarySchema,
  transcriptEntrySchema,
  analysisStartedSchema,
  analysisSucceededSchema,
  analysisFailedSchema,
  statsSchema,
  CORPUS_QUEUE,
  CORPUS_RESULTS_QUEUE,
  CORPUS_JOB,
  CORPUS_RESULT_JOB,
  corpusJobSchema,
  corpusSucceededSchema,
  corpusFailedSchema,
} from './contract.ts';

export type {
  ResultJobName,
  Modality,
  AnalysisJob,
  Timeline,
  AxisBands,
  AxisSummary,
  TranscriptEntry,
  AnalysisStarted,
  AnalysisSucceeded,
  AnalysisFailed,
  Stats,
  CorpusResultJobName,
  CorpusJob,
  CorpusSucceeded,
  CorpusFailed,
} from './contract.ts';
