-- The uploader's own name for the file, so a list of analyses reads as
-- "reel-final-v2.mp4" instead of five rows all saying "Video". Display only:
-- the Storage object is keyed by `{workspace_id}/{media_asset_id}`, never by
-- this, so it carries no authorization meaning and needs no policy change —
-- media_assets is already covered by its workspace-rooted policies from
-- 20260802191500_security_rls.
--
-- Nullable with no backfill: an asset registered from a URL has no filename,
-- and neither does any row written before this migration. Readers fall back to
-- the media kind.

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "file_name" VARCHAR(255);
