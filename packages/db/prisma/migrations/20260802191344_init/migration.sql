-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written prefix (everything below the marker is Prisma-generated).
--
-- uuid_generate_v7() must exist BEFORE the CREATE TABLEs, which use it as a
-- column default. Postgres 17 has no native uuidv7() (that landed in PG 18) and
-- pg_uuidv7 is not available on Supabase, so we define it here.
--
-- It starts from gen_random_uuid() (a v4) and overlays the high 48 bits with the
-- current millisecond, then flips bits 52/53 to turn the version nibble from 4
-- (0100) into 7 (0111). Starting from a v4 is what leaves the variant bits
-- already correct. Result: time-ordered ids, so inserts append to one region of
-- the btree instead of scattering it the way random v4 keys do.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

-- Helper schema for SECURITY DEFINER functions the RLS policies call. Kept out
-- of `public` so it is never reachable through the Data API.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

-- ─── Prisma-generated schema below ───────────────────────────────────────────

-- CreateEnum
CREATE TYPE "workspace_kind_enum" AS ENUM ('PERSONAL', 'TEAM');

-- CreateEnum
CREATE TYPE "workspace_role_enum" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "platform_enum" AS ENUM ('YOUTUBE', 'INSTAGRAM', 'TIKTOK');

-- CreateEnum
CREATE TYPE "connection_status_enum" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "media_kind_enum" AS ENUM ('VIDEO', 'AUDIO', 'IMAGE');

-- CreateEnum
CREATE TYPE "media_source_enum" AS ENUM ('UPLOAD', 'PLATFORM_BACKFILL', 'CAPTURE');

-- CreateEnum
CREATE TYPE "media_status_enum" AS ENUM ('PENDING', 'READY', 'FAILED', 'PURGED');

-- CreateEnum
CREATE TYPE "analysis_status_enum" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "resonance_axis_enum" AS ENUM ('VISUAL_ATTENTION', 'AUDIO_ENGAGEMENT', 'CLARITY', 'EMOTIONAL_PULL', 'MEMORABILITY');

-- CreateEnum
CREATE TYPE "axis_confidence_enum" AS ENUM ('STABLE', 'MEDIUM', 'BETA');

-- CreateEnum
CREATE TYPE "recommendation_kind_enum" AS ENUM ('HOOK', 'PACING', 'TRIM', 'AUDIO', 'CLARITY', 'LENGTH', 'CAPTION', 'POSTING_TIME');

-- CreateEnum
CREATE TYPE "post_format_enum" AS ENUM ('SHORT_FORM', 'LONG_FORM', 'STORY', 'IMAGE');

-- CreateEnum
CREATE TYPE "label_kind_enum" AS ENUM ('COMPLETION_RATE', 'ENGAGEMENT_RATE', 'WATCH_TIME', 'RETENTION_CURVE');

-- CreateEnum
CREATE TYPE "split_tag_enum" AS ENUM ('TRAIN', 'VAL', 'TEST', 'HOLDOUT');

-- CreateEnum
CREATE TYPE "feature_kind_enum" AS ENUM ('FUSED_LATENT_POOLED', 'FUSED_LATENT_SEQUENCE', 'YEO7_TIMESERIES', 'BRAIN_TENSOR', 'CONTENT_METADATA', 'TEXT_EMBEDDING');

-- CreateEnum
CREATE TYPE "model_kind_enum" AS ENUM ('TRIBE_ENCODER', 'CALIBRATION_TIMELINE', 'CALIBRATION_RANKER', 'BASELINE');

-- CreateEnum
CREATE TYPE "credit_txn_kind_enum" AS ENUM ('TRIAL_GRANT', 'PURCHASE', 'ANALYSIS_CHARGE', 'REFUND', 'ADJUSTMENT', 'EXPIRY');

-- CreateEnum
CREATE TYPE "deletion_reason_enum" AS ENUM ('USER_DISCONNECT', 'ACCOUNT_DELETE', 'RETENTION_EXPIRY', 'PLATFORM_REQUEST');

-- CreateEnum
CREATE TYPE "deletion_status_enum" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "locale" TEXT,
    "timezone" TEXT,
    "onboarded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "kind" "workspace_kind_enum" NOT NULL DEFAULT 'PERSONAL',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "role" "workspace_role_enum" NOT NULL DEFAULT 'MEMBER',
    "invited_at" TIMESTAMPTZ(6),
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_accounts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "connected_by_id" UUID NOT NULL,
    "platform" "platform_enum" NOT NULL,
    "platform_account_id" TEXT NOT NULL,
    "handle" TEXT,
    "scopes" TEXT[],
    "access_token" BYTEA,
    "refresh_token" BYTEA,
    "token_expires_at" TIMESTAMPTZ(6),
    "status" "connection_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6),
    "disconnected_at" TIMESTAMPTZ(6),
    "purge_after" TIMESTAMPTZ(6),

    CONSTRAINT "connected_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "connected_account_id" UUID NOT NULL,
    "platform" "platform_enum" NOT NULL,
    "platform_channel_id" TEXT NOT NULL,
    "title" TEXT,
    "niche" TEXT,
    "follower_count" INTEGER,
    "last_backfilled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "uploaded_by_id" UUID,
    "kind" "media_kind_enum" NOT NULL,
    "source" "media_source_enum" NOT NULL DEFAULT 'UPLOAD',
    "status" "media_status_enum" NOT NULL DEFAULT 'PENDING',
    "storage_bucket" TEXT NOT NULL DEFAULT 'media',
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "byte_size" BIGINT,
    "duration_sec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purge_after" TIMESTAMPTZ(6),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyses" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "status" "analysis_status_enum" NOT NULL DEFAULT 'QUEUED',
    "model_version_id" UUID,
    "credits_charged" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inference_runs" (
    "id" BIGSERIAL NOT NULL,
    "analysis_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "queue_job_id" TEXT,
    "ml_endpoint" TEXT,
    "device" TEXT,
    "gpu_seconds" DOUBLE PRECISION,
    "duration_ms" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "inference_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_results" (
    "analysis_id" UUID NOT NULL,
    "resonance_score" INTEGER,
    "percentile_in_channel" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "timeline_start_sec" DOUBLE PRECISION[],
    "timeline_attention" DOUBLE PRECISION[],
    "timeline_visual" DOUBLE PRECISION[],
    "timeline_audio" DOUBLE PRECISION[],
    "timeline_language" DOUBLE PRECISION[],
    "raw_stats" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_results_pkey" PRIMARY KEY ("analysis_id")
);

-- CreateTable
CREATE TABLE "analysis_axis_scores" (
    "id" BIGSERIAL NOT NULL,
    "analysis_id" UUID NOT NULL,
    "axis" "resonance_axis_enum" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" "axis_confidence_enum" NOT NULL DEFAULT 'BETA',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analysis_axis_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_recommendations" (
    "id" BIGSERIAL NOT NULL,
    "analysis_id" UUID NOT NULL,
    "kind" "recommendation_kind_enum" NOT NULL,
    "message" TEXT NOT NULL,
    "target_start_sec" DOUBLE PRECISION,
    "target_stop_sec" DOUBLE PRECISION,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analysis_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparisons" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_entries" (
    "id" BIGSERIAL NOT NULL,
    "comparison_id" UUID NOT NULL,
    "analysis_id" UUID NOT NULL,
    "label" TEXT,
    "predicted_rank" INTEGER,
    "is_winner" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "comparison_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "platform" "platform_enum" NOT NULL,
    "platform_post_id" TEXT NOT NULL,
    "media_asset_id" UUID,
    "predicted_by_analysis_id" UUID,
    "format" "post_format_enum" NOT NULL DEFAULT 'SHORT_FORM',
    "title" TEXT,
    "caption" TEXT,
    "permalink" TEXT,
    "duration_sec" DOUBLE PRECISION,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purge_after" TIMESTAMPTZ(6),

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metric_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "post_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "views" BIGINT,
    "reach" BIGINT,
    "impressions" BIGINT,
    "likes" BIGINT,
    "comments" BIGINT,
    "shares" BIGINT,
    "saves" BIGINT,
    "subscribers_gained" INTEGER,
    "avg_view_duration_sec" DOUBLE PRECISION,
    "avg_view_percentage" DOUBLE PRECISION,
    "estimated_minutes_watched" DOUBLE PRECISION,
    "engagement_rate" DOUBLE PRECISION,

    CONSTRAINT "post_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_retention_curves" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "post_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "elapsed_ratio" DOUBLE PRECISION[],
    "audience_watch_ratio" DOUBLE PRECISION[],
    "relative_retention_performance" DOUBLE PRECISION[],
    "purge_after" TIMESTAMPTZ(6),

    CONSTRAINT "post_retention_curves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_labels" (
    "id" BIGSERIAL NOT NULL,
    "post_id" UUID NOT NULL,
    "kind" "label_kind_enum" NOT NULL,
    "raw_value" DOUBLE PRECISION,
    "within_channel_z" DOUBLE PRECISION,
    "within_channel_pct" DOUBLE PRECISION,
    "split_tag" "split_tag_enum",
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_artifacts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "analysis_id" UUID,
    "post_id" UUID,
    "model_version_id" UUID,
    "kind" "feature_kind_enum" NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "shape" INTEGER[],
    "dtype" TEXT,
    "size_bytes" BIGINT,
    "checksum" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_versions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "kind" "model_kind_enum" NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "git_sha" TEXT,
    "metrics" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "trained_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_balances" (
    "workspace_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" "credit_txn_kind_enum" NOT NULL,
    "delta" INTEGER NOT NULL,
    "analysis_id" UUID,
    "external_ref" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hashed_key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_deletion_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "workspace_id" UUID,
    "profile_id" UUID,
    "reason" "deletion_reason_enum" NOT NULL,
    "status" "deletion_status_enum" NOT NULL DEFAULT 'PENDING',
    "scope" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_profile_id_idx" ON "workspace_members"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_profile_id_key" ON "workspace_members"("workspace_id", "profile_id");

-- CreateIndex
CREATE INDEX "connected_accounts_workspace_id_idx" ON "connected_accounts"("workspace_id");

-- CreateIndex
CREATE INDEX "connected_accounts_connected_by_id_idx" ON "connected_accounts"("connected_by_id");

-- CreateIndex
CREATE INDEX "connected_accounts_purge_after_idx" ON "connected_accounts"("purge_after");

-- CreateIndex
CREATE UNIQUE INDEX "connected_accounts_workspace_id_platform_platform_account_i_key" ON "connected_accounts"("workspace_id", "platform", "platform_account_id");

-- CreateIndex
CREATE INDEX "channels_workspace_id_idx" ON "channels"("workspace_id");

-- CreateIndex
CREATE INDEX "channels_connected_account_id_idx" ON "channels"("connected_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_platform_platform_channel_id_key" ON "channels"("platform", "platform_channel_id");

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_idx" ON "media_assets"("workspace_id");

-- CreateIndex
CREATE INDEX "media_assets_uploaded_by_id_idx" ON "media_assets"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_workspace_id_checksum_key" ON "media_assets"("workspace_id", "checksum");

-- CreateIndex
CREATE INDEX "analyses_workspace_id_created_at_idx" ON "analyses"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "analyses_media_asset_id_idx" ON "analyses"("media_asset_id");

-- CreateIndex
CREATE INDEX "analyses_requested_by_id_idx" ON "analyses"("requested_by_id");

-- CreateIndex
CREATE INDEX "analyses_model_version_id_idx" ON "analyses"("model_version_id");

-- CreateIndex
CREATE INDEX "analyses_status_idx" ON "analyses"("status");

-- CreateIndex
CREATE INDEX "inference_runs_queue_job_id_idx" ON "inference_runs"("queue_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "inference_runs_analysis_id_attempt_key" ON "inference_runs"("analysis_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_axis_scores_analysis_id_axis_key" ON "analysis_axis_scores"("analysis_id", "axis");

-- CreateIndex
CREATE INDEX "analysis_recommendations_analysis_id_priority_idx" ON "analysis_recommendations"("analysis_id", "priority");

-- CreateIndex
CREATE INDEX "comparisons_workspace_id_idx" ON "comparisons"("workspace_id");

-- CreateIndex
CREATE INDEX "comparison_entries_analysis_id_idx" ON "comparison_entries"("analysis_id");

-- CreateIndex
CREATE UNIQUE INDEX "comparison_entries_comparison_id_analysis_id_key" ON "comparison_entries"("comparison_id", "analysis_id");

-- CreateIndex
CREATE INDEX "posts_workspace_id_idx" ON "posts"("workspace_id");

-- CreateIndex
CREATE INDEX "posts_channel_id_published_at_idx" ON "posts"("channel_id", "published_at" DESC);

-- CreateIndex
CREATE INDEX "posts_media_asset_id_idx" ON "posts"("media_asset_id");

-- CreateIndex
CREATE INDEX "posts_predicted_by_analysis_id_idx" ON "posts"("predicted_by_analysis_id");

-- CreateIndex
CREATE INDEX "posts_purge_after_idx" ON "posts"("purge_after");

-- CreateIndex
CREATE UNIQUE INDEX "posts_channel_id_platform_post_id_key" ON "posts"("channel_id", "platform_post_id");

-- CreateIndex
CREATE INDEX "post_metric_snapshots_post_id_captured_at_idx" ON "post_metric_snapshots"("post_id", "captured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "post_metric_snapshots_post_id_captured_at_key" ON "post_metric_snapshots"("post_id", "captured_at");

-- CreateIndex
CREATE INDEX "post_retention_curves_post_id_idx" ON "post_retention_curves"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_retention_curves_post_id_captured_at_key" ON "post_retention_curves"("post_id", "captured_at");

-- CreateIndex
CREATE INDEX "post_labels_split_tag_idx" ON "post_labels"("split_tag");

-- CreateIndex
CREATE UNIQUE INDEX "post_labels_post_id_kind_key" ON "post_labels"("post_id", "kind");

-- CreateIndex
CREATE INDEX "feature_artifacts_analysis_id_idx" ON "feature_artifacts"("analysis_id");

-- CreateIndex
CREATE INDEX "feature_artifacts_post_id_idx" ON "feature_artifacts"("post_id");

-- CreateIndex
CREATE INDEX "feature_artifacts_model_version_id_idx" ON "feature_artifacts"("model_version_id");

-- CreateIndex
CREATE INDEX "feature_artifacts_kind_idx" ON "feature_artifacts"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "model_versions_kind_name_version_key" ON "model_versions"("kind", "name", "version");

-- CreateIndex
CREATE INDEX "credit_transactions_workspace_id_created_at_idx" ON "credit_transactions"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "credit_transactions_analysis_id_idx" ON "credit_transactions"("analysis_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hashed_key_key" ON "api_keys"("hashed_key");

-- CreateIndex
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys"("workspace_id");

-- CreateIndex
CREATE INDEX "data_deletion_requests_status_requested_at_idx" ON "data_deletion_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "data_deletion_requests_workspace_id_idx" ON "data_deletion_requests"("workspace_id");

-- CreateIndex
CREATE INDEX "data_deletion_requests_profile_id_idx" ON "data_deletion_requests"("profile_id");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inference_runs" ADD CONSTRAINT "inference_runs_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_axis_scores" ADD CONSTRAINT "analysis_axis_scores_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analysis_results"("analysis_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_recommendations" ADD CONSTRAINT "analysis_recommendations_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analysis_results"("analysis_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_entries" ADD CONSTRAINT "comparison_entries_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_entries" ADD CONSTRAINT "comparison_entries_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_predicted_by_analysis_id_fkey" FOREIGN KEY ("predicted_by_analysis_id") REFERENCES "analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_retention_curves" ADD CONSTRAINT "post_retention_curves_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_labels" ADD CONSTRAINT "post_labels_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_artifacts" ADD CONSTRAINT "feature_artifacts_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_artifacts" ADD CONSTRAINT "feature_artifacts_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_artifacts" ADD CONSTRAINT "feature_artifacts_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
