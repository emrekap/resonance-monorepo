import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 config for the Resonance app schema.
 *
 * Prisma owns `public` only — Supabase owns `auth` and `storage`. Our migrations
 * still reference those schemas (the `profiles.id -> auth.users.id` foreign key,
 * the trigger on `auth.users`, the Storage policies), so `initShadowDb` stubs
 * out just enough of them for the shadow database to apply those migrations
 * during diffing. `tables.external` then keeps Prisma from treating the stubs as
 * tables it should manage.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',

  experimental: {
    externalTables: true,
  },

  tables: {
    external: ['auth.users', 'storage.buckets', 'storage.objects'],
  },

  migrations: {
    path: 'prisma/migrations',
    initShadowDb: `
      create schema if not exists auth;
      create table if not exists auth.users (
        id uuid primary key,
        email text,
        raw_user_meta_data jsonb
      );

      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key,
        name text not null,
        public boolean default false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      create table if not exists storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text,
        name text
      );
      create or replace function storage.foldername(name text)
      returns text[] language sql immutable as $fn$
        select string_to_array(name, '/');
      $fn$;

      create schema if not exists auth_fns;
      create or replace function auth.uid() returns uuid language sql stable as $fn$
        select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
      $fn$;

      do $do$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
      end $do$;

      -- Supabase ships this publication; 20260805140000_realtime_analyses
      -- adds a table to it. CREATE PUBLICATION has no IF NOT EXISTS.
      do $do$ begin
        if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
          create publication supabase_realtime;
        end if;
      end $do$;
    `,
  },

  // Migrations need a direct (non-transaction-pooled) connection.
  datasource: {
    url: env('DIRECT_DATABASE_URL'),
  },
});
