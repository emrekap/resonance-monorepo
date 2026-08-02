-- AlterTable
ALTER TABLE "channels" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "credit_balances" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "profiles" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ── Hand-written addition ────────────────────────────────────────────────────
-- The DEFAULTs above fix INSERTs made outside Prisma (the signup trigger, the
-- SECURITY DEFINER helpers). Prisma's `@updatedAt` is likewise application-side
-- only, so an UPDATE issued as raw SQL would silently leave updated_at stale.
-- Maintain it in the database instead, which is true for every writer.

CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'workspaces', 'channels', 'credit_balances']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION private.set_updated_at()', t);
  END LOOP;
END $$;
