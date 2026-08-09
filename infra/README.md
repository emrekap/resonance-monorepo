# infra

Deployment & runtime glue.

## Local queue stack — `docker/docker-compose.yml`

```bash
bun run docker:local                                                     # redis
bun run docker:local:tools                                               # + bull-board on :3010

docker compose -f infra/docker/docker-compose.yml down                   # stop, keep the volume
docker compose -f infra/docker/docker-compose.yml down -v                # stop + drop queued jobs
```

bull-board **scans Redis for queues once, at startup**, and never rescans. On a fresh volume there is
nothing to find yet, so the dashboard comes up empty and looks misconfigured when it isn't. Start it
after something has touched the queues, or just restart it once they exist:

```bash
docker restart resonance-bull-board
```

Redis only. The three processes that talk over it run on the host, where their reloaders — and for
`apps/ml`, the GPU — are:

```bash
cd apps/api    && bun run dev        # produces to `analysis`
cd apps/ml     && python worker.py   # consumes it, produces to `analysis-results`
cd apps/worker && bun run dev        # consumes that, writes Postgres
```

**Postgres is deliberately absent.** The database is Supabase; a second local one would mean a schema
and a set of RLS policies that drift from the only ones that matter.

### Two settings that are not cosmetic

- `maxmemory-policy noeviction` — BullMQ **requires** it. Any other policy lets Redis drop keys under
  memory pressure, and the keys it drops are job hashes: jobs would vanish from the queue with no
  error anywhere. With `noeviction` plus a `maxmemory` ceiling, a runaway backlog fails writes loudly
  instead of silently losing GPU work.
- `appendonly yes` — otherwise a `docker compose restart` drops up to a minute of queued jobs, since
  RDB snapshots alone are not enough.

### bull-board

Behind the `tools` profile so a plain `up` stays lean. It shows waiting/active/completed/failed per
queue and the **full stack trace** of a failed job — the one place an ML traceback survives, since
`analyses.error` only gets the one-line message.

`BULL_PREFIX` must match `QUEUE_PREFIX` in
[`packages/queue/src/contract.ts`](../packages/queue/src/contract.ts), or the board connects fine and
shows two permanently empty queues.

## Object storage — done, and not here

Uploads ship on **Supabase Storage**, not on anything in this directory. The private `media` bucket
is created and policed by the `security_rls` migration (§7): workspace-scoped RLS on the first path
segment, 500 MiB and `video|audio|image` caps in `media_bucket_limits`. Clients stream straight to
it with their own JWT and the API never sees the bytes — see the upload sections of
[`apps/api/README.md`](../apps/api/README.md) and [`apps/mobile/README.md`](../apps/mobile/README.md).

The `external` bucket beside it is **not a leftover placeholder**: it is the escape hatch for media
that is already URL-addressable (`POST /analyze { mediaUrl }`), which skips registration, upload and
the signed-URL mint entirely. Both are deliberate.

## Still to build

- **Dockerfiles / compose** for each deployable (`apps/api` + `apps/worker` on cheap CPU, `apps/ml`
  on GPU). `apps/ml` has an image already — reuse it, overriding `CMD` to `python worker.py`.
- **A production Redis decision.** All three processes must share one instance, and it must be
  configured `noeviction` (see below — the requirement is not local-only). The `apps/ml` README's
  Space section is currently the only place this is written down, and it is not an ml-specific
  concern.
- Deploy targets, env, and CI.
