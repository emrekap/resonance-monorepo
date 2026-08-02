import { WorkspaceKind, type Tx } from '@repo/db';

/**
 * The workspace a request acts in.
 *
 * Tenancy is the workspace, not the profile — but every profile gets an
 * auto-created PERSONAL workspace at signup, so a solo creator's client never
 * has to know the concept exists and can omit `workspaceId` entirely.
 *
 * The membership lookup is not a permission check bolted on top: `tx` is
 * already inside `withUser()`, so RLS has filtered `workspace_members` to rows
 * the caller belongs to. A `workspaceId` the caller is not a member of simply
 * finds nothing — returns `null`, and the caller answers 404 rather than
 * confirming that the workspace exists.
 */
export async function resolveWorkspaceId(
  tx: Tx,
  profileId: string,
  requested?: string,
): Promise<string | null> {
  if (requested) {
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_profileId: { workspaceId: requested, profileId } },
      select: { workspaceId: true },
    });
    return membership?.workspaceId ?? null;
  }

  const personal = await tx.workspaceMember.findFirst({
    where: { profileId, workspace: { kind: WorkspaceKind.PERSONAL, deletedAt: null } },
    orderBy: { joinedAt: 'asc' },
    select: { workspaceId: true },
  });
  return personal?.workspaceId ?? null;
}
