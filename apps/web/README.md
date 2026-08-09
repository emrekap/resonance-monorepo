# apps/web

**Not scaffolded.** This directory is a README and nothing else — no `package.json`, no source, so
Bun and Turbo do not see it. Deliberate: mobile is the creator surface and it comes first.

## What it is for

Not a port of the mobile app. The two clients have different users:

- **`apps/mobile`** is the **creator** surface — shoot, upload, check before posting. Everything
  about it assumes a phone and a single person's own content.
- **`apps/web`** is the **brand / agency** surface, which is the monetization surface in
  [`docs/investor-one-pager.md`](../../docs/investor-one-pager.md): a team comparing edits of one
  commercial, a dashboard over a workspace with several members, and eventually the public API tier.

That difference is already in the data model — tenancy is the **workspace**, not the profile, and a
`BRAND`/`AGENCY` workspace is the same shape as a creator's `PERSONAL` one with more members
([`packages/db/README.md`](../../packages/db/README.md)). Web is where that shape stops being
invisible.

## What it will reuse

- **Typesafety, unchanged:** the Hono RPC client (`hc<AppType>` via
  [`@repo/api-contract`](../../packages/api-contract)) + TanStack Query, exactly as mobile consumes
  it. No codegen, no second API.
- **`@repo/tsconfig/nextjs.json`** as the tsconfig base.
- **`@repo/db/browser`** for enums and model types — never the `@repo/db` barrel, which drags
  Bun-only server code into the web typecheck.

## What it will not reuse

The design system in [`apps/mobile/DESIGN.md`](../mobile/DESIGN.md) is React Native
primitives (`View`, `Text`, `StyleSheet`) and does not cross to the DOM. The **tokens** should
(colors, spacing, type scale); the components should not. Decide that before writing screens, not
after.

## When it gets built

After the analysis path has run end to end on a real clip, and not before a brand/agency user
actually needs it — see the TODO in [`CLAUDE.md`](../../CLAUDE.md). Scaffold it with the
[`add-package`](../../.claude/skills/add-package/SKILL.md) skill so it wires into Bun workspaces and
Turbo correctly.
