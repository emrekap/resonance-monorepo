# packages/db

**Prisma schema + generated client** — the single source of truth for the app data model.

Owns `schema.prisma`, migrations, and the exported typed client. Consumed by [`apps/api`](../../apps/api).

**Rule:** only this package defines the app schema. The Python ML service ([`apps/ml`](../../apps/ml))
never writes these tables with a second ORM (avoids schema drift).

_Scaffold placeholder — `prisma init` goes here._
