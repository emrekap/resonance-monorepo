-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "corpus";

-- CreateTable
CREATE TABLE "corpus"."channels" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "platform_channel_id" TEXT NOT NULL,
    "title" TEXT,
    "niche" TEXT,
    "rationale" TEXT,
    "uploads_playlist_id" TEXT,
    "subscriber_count" BIGINT,
    "last_polled_at" TIMESTAMPTZ(6),
    "text_refreshed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corpus"."posts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "channel_id" UUID NOT NULL,
    "platform_video_id" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_sec" DOUBLE PRECISION NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "tags" TEXT[],
    "license" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "text_refreshed_at" TIMESTAMPTZ(6),

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corpus"."metric_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "post_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "views" BIGINT,
    "likes" BIGINT,
    "comments" BIGINT,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corpus"."poll_runs" (
    "id" BIGSERIAL NOT NULL,
    "channel_id" UUID NOT NULL,
    "run_at" TIMESTAMPTZ(6) NOT NULL,
    "videos_seen" INTEGER NOT NULL,
    "posts_included" INTEGER NOT NULL,
    "excluded" JSONB NOT NULL,

    CONSTRAINT "poll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corpus"."clips" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "post_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "duration_sec" DOUBLE PRECISION,
    "acquisition_route" TEXT NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corpus"."scores" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "post_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "timeline_start_sec" DOUBLE PRECISION[],
    "timeline_attention" DOUBLE PRECISION[],
    "timeline_visual" DOUBLE PRECISION[],
    "timeline_audio" DOUBLE PRECISION[],
    "timeline_language" DOUBLE PRECISION[],
    "axis_bands" JSONB NOT NULL,
    "transcript" JSONB,
    "composite" DOUBLE PRECISION NOT NULL,
    "device" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channels_platform_channel_id_key" ON "corpus"."channels"("platform_channel_id");

-- CreateIndex
CREATE INDEX "channels_text_refreshed_at_idx" ON "corpus"."channels"("text_refreshed_at");

-- CreateIndex
CREATE UNIQUE INDEX "posts_platform_video_id_key" ON "corpus"."posts"("platform_video_id");

-- CreateIndex
CREATE INDEX "posts_channel_id_published_at_idx" ON "corpus"."posts"("channel_id", "published_at" DESC);

-- CreateIndex
CREATE INDEX "posts_text_refreshed_at_idx" ON "corpus"."posts"("text_refreshed_at");

-- CreateIndex
CREATE INDEX "posts_license_idx" ON "corpus"."posts"("license");

-- CreateIndex
CREATE INDEX "metric_snapshots_post_id_captured_at_idx" ON "corpus"."metric_snapshots"("post_id", "captured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_post_id_captured_at_key" ON "corpus"."metric_snapshots"("post_id", "captured_at");

-- CreateIndex
CREATE INDEX "poll_runs_run_at_idx" ON "corpus"."poll_runs"("run_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "poll_runs_channel_id_run_at_key" ON "corpus"."poll_runs"("channel_id", "run_at");

-- CreateIndex
CREATE UNIQUE INDEX "clips_post_id_key" ON "corpus"."clips"("post_id");

-- CreateIndex
CREATE INDEX "scores_clip_id_idx" ON "corpus"."scores"("clip_id");

-- CreateIndex
CREATE UNIQUE INDEX "scores_post_id_attempt_key" ON "corpus"."scores"("post_id", "attempt");

-- AddForeignKey
ALTER TABLE "corpus"."posts" ADD CONSTRAINT "posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "corpus"."channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corpus"."metric_snapshots" ADD CONSTRAINT "metric_snapshots_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "corpus"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corpus"."poll_runs" ADD CONSTRAINT "poll_runs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "corpus"."channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corpus"."clips" ADD CONSTRAINT "clips_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "corpus"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corpus"."scores" ADD CONSTRAINT "scores_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "corpus"."posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corpus"."scores" ADD CONSTRAINT "scores_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "corpus"."clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
