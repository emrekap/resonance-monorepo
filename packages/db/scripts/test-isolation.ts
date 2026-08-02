/**
 * Proves cross-user isolation is enforced by Postgres, not by application code.
 *
 *   bun run db:test-isolation
 *
 * Creates two throwaway auth users, then drives real queries through the same
 * `withUser()` helper apps/api uses and asserts that user B cannot see, modify
 * or delete user A's rows — and that neither can mint themselves credits.
 *
 * Safe to run against the dev project: every row it creates hangs off the two
 * auth users it creates, and deleting those cascades it all away.
 */
import { randomUUIDv7 } from 'bun';
import 'dotenv/config';
import { Client } from 'pg';
import { prisma, prismaService, withUser, withAnon } from '../src/index.ts';

const admin = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await admin.connect();

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Asserts the operation is refused by the database. */
async function denied(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, 'the write was ALLOWED');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRlsDenial = /row-level security|permission denied|violates/i.test(message);
    check(label, isRlsDenial, isRlsDenial ? '' : `unexpected error: ${message.slice(0, 120)}`);
  }
}

const userA = randomUUIDv7();
const userB = randomUUIDv7();

try {
  console.log('\nsetup: two auth users (the signup trigger builds their workspaces)');
  await admin.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [
    userA,
    `iso-a-${userA.slice(0, 8)}@example.test`,
    userB,
    `iso-b-${userB.slice(0, 8)}@example.test`,
  ]);

  const wsA = await withUser(userA, (tx) => tx.workspace.findMany());
  const wsB = await withUser(userB, (tx) => tx.workspace.findMany());
  check(
    'signup trigger created exactly one workspace for A',
    wsA.length === 1,
    `got ${wsA.length}`,
  );
  check(
    'signup trigger created exactly one workspace for B',
    wsB.length === 1,
    `got ${wsB.length}`,
  );
  check('their workspaces are distinct', wsA[0]!.id !== wsB[0]!.id);

  const workspaceA = wsA[0]!.id;
  const workspaceB = wsB[0]!.id;

  console.log('\nA creates data in their own workspace');
  const assetA = await withUser(userA, (tx) =>
    tx.mediaAsset.create({
      data: { workspaceId: workspaceA, kind: 'VIDEO', storagePath: `${workspaceA}/iso-test.mp4` },
    }),
  );
  const analysisA = await withUser(userA, (tx) =>
    tx.analysis.create({ data: { workspaceId: workspaceA, mediaAssetId: assetA.id } }),
  );
  check(
    'A can read back their own media asset',
    (await withUser(userA, (tx) => tx.mediaAsset.findMany())).length === 1,
  );
  check(
    'A can read back their own analysis',
    (await withUser(userA, (tx) => tx.analysis.findMany())).length === 1,
  );

  console.log("\nB attempts to reach A's data");
  check(
    "B sees none of A's media assets",
    (await withUser(userB, (tx) => tx.mediaAsset.findMany())).length === 0,
  );
  check(
    "B sees none of A's analyses",
    (await withUser(userB, (tx) => tx.analysis.findMany())).length === 0,
  );
  check(
    "B cannot fetch A's analysis even knowing its id",
    (await withUser(userB, (tx) => tx.analysis.findUnique({ where: { id: analysisA.id } }))) ===
      null,
  );
  check(
    "B's UPDATE on A's analysis affects zero rows",
    (
      await withUser(userB, (tx) =>
        tx.analysis.updateMany({ where: { id: analysisA.id }, data: { status: 'FAILED' } }),
      )
    ).count === 0,
  );
  check(
    "B's DELETE on A's media asset affects zero rows",
    (await withUser(userB, (tx) => tx.mediaAsset.deleteMany({ where: { id: assetA.id } })))
      .count === 0,
  );
  check(
    "A's analysis survived B's attempts",
    (await withUser(userA, (tx) => tx.analysis.findMany())).length === 1,
  );

  await denied("B cannot INSERT into A's workspace", () =>
    withUser(userB, (tx) =>
      tx.mediaAsset.create({
        data: { workspaceId: workspaceA, kind: 'VIDEO', storagePath: `${workspaceA}/stolen.mp4` },
      }),
    ),
  );
  await denied("B cannot move their own asset into A's workspace (WITH CHECK)", () =>
    withUser(userB, async (tx) => {
      const own = await tx.mediaAsset.create({
        data: { workspaceId: workspaceB, kind: 'VIDEO', storagePath: `${workspaceB}/own.mp4` },
      });
      return tx.mediaAsset.update({ where: { id: own.id }, data: { workspaceId: workspaceA } });
    }),
  );

  console.log('\nprivilege escalation');
  await denied('a user cannot mint themselves credits', () =>
    withUser(userA, (tx) =>
      tx.creditTransaction.create({
        data: { workspaceId: workspaceA, kind: 'TRIAL_GRANT', delta: 1_000_000 },
      }),
    ),
  );
  await denied('a user cannot forge an analysis result', () =>
    withUser(userA, (tx) =>
      tx.analysisResult.create({ data: { analysisId: analysisA.id, resonanceScore: 100 } }),
    ),
  );
  await denied('a user cannot write the model registry', () =>
    withUser(userA, (tx) =>
      tx.modelVersion.create({ data: { kind: 'CALIBRATION_RANKER', name: 'evil', version: '1' } }),
    ),
  );

  console.log('\nunauthenticated + service role');
  check(
    'an unauthenticated connection sees no workspaces',
    (await withAnon((tx) => tx.workspace.findMany())).length === 0,
  );
  check(
    'an unauthenticated connection sees no analyses',
    (await withAnon((tx) => tx.analysis.findMany())).length === 0,
  );
  const serviceView = await prismaService.workspace.findMany({
    where: { id: { in: [workspaceA, workspaceB] } },
  });
  check(
    'the service role can see both workspaces (worker path)',
    serviceView.length === 2,
    `got ${serviceView.length}`,
  );

  console.log('\ndelete cascade');
  await admin.query(`delete from auth.users where id = any($1::uuid[])`, [[userA, userB]]);
  const leftoverProfiles = await prismaService.profile.count({
    where: { id: { in: [userA, userB] } },
  });
  const leftoverWorkspaces = await prismaService.workspace.count({
    where: { id: { in: [workspaceA, workspaceB] } },
  });
  const leftoverAnalyses = await prismaService.analysis.count({ where: { id: analysisA.id } });
  check(
    'deleting the auth user removed the profile',
    leftoverProfiles === 0,
    `${leftoverProfiles} left`,
  );
  check(
    '…and cascaded to their workspaces',
    leftoverWorkspaces === 0,
    `${leftoverWorkspaces} left`,
  );
  check('…and cascaded to their analyses', leftoverAnalyses === 0, `${leftoverAnalyses} left`);
} finally {
  // Belt and braces: if an assertion threw before the cascade step.
  await admin
    .query(`delete from auth.users where id = any($1::uuid[])`, [[userA, userB]])
    .catch(() => {});
  await admin.end();
  await prisma.$disconnect();
  await prismaService.$disconnect();
}

console.log('');
if (failures.length > 0) {
  console.error(
    `✗ isolation test FAILED — ${failures.length} of ${passed + failures.length} checks\n`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ isolation test passed — ${passed}/${passed} checks`);
