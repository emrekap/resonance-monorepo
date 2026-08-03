-- Guardrails on the `media` bucket (created in 20260802191500_security_rls).
-- Storage enforces both at upload time, before RLS runs, so an oversized or
-- off-type object is refused at the edge instead of costing storage.
-- 500 MiB comfortably covers the short-form video/audio the model analyses.
UPDATE storage.buckets
SET file_size_limit    = 524288000,
    allowed_mime_types = ARRAY['video/*', 'audio/*', 'image/*']
WHERE id = 'media';
