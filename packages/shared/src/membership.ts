import type {
  EntityId,
  MembershipVersion,
  PaperCollection,
  PaperCollectionReset
} from "./entities.js";

export function canonicalPaperCollectionId(paperId: EntityId, collectionId: EntityId): EntityId {
  return `paper_collection:${paperId.length}:${paperId}${collectionId}`;
}

export function canonicalPaperCollectionResetId(paperId: EntityId): EntityId {
  return `paper_collection_reset:${paperId.length}:${paperId}`;
}

export function legacyMembershipVersion(membership: PaperCollection): MembershipVersion {
  return {
    kind: "legacy",
    updatedAt: membership.updatedAt,
    deleted: Boolean(membership.deletedAt),
    entityId: membership.id
  };
}

export function membershipVersionOf(membership: PaperCollection): MembershipVersion {
  return membership.membershipVersion ?? legacyMembershipVersion(membership);
}

export function compareMembershipVersions(left: MembershipVersion, right: MembershipVersion): number {
  if (left.kind !== right.kind) return left.kind === "hlc" ? 1 : -1;
  if (left.kind === "legacy" && right.kind === "legacy") {
    return left.updatedAt.localeCompare(right.updatedAt)
      || Number(left.deleted) - Number(right.deleted)
      || left.entityId.localeCompare(right.entityId);
  }
  if (left.kind === "hlc" && right.kind === "hlc") {
    return left.wallTimeMs - right.wallTimeMs
      || left.counter - right.counter
      || left.nodeId.localeCompare(right.nodeId)
      || left.operationId.localeCompare(right.operationId);
  }
  return 0;
}

export function sameMembershipVersion(left: MembershipVersion, right: MembershipVersion): boolean {
  return compareMembershipVersions(left, right) === 0;
}

export function membershipSurvivesReset(
  membership: PaperCollection,
  reset?: PaperCollectionReset
): boolean {
  if (membership.deletedAt || !reset) return !membership.deletedAt;
  const comparison = compareMembershipVersions(membershipVersionOf(membership), reset.membershipVersion);
  return comparison > 0 || (comparison === 0 && membership.collectionId === reset.targetCollectionId);
}

export function reconcilePaperCollections(
  memberships: PaperCollection[],
  resets: PaperCollectionReset[]
): PaperCollection[] {
  const resetByPaper = new Map<EntityId, PaperCollectionReset>();
  for (const reset of resets) {
    const existing = resetByPaper.get(reset.paperId);
    if (!existing || compareMembershipVersions(reset.membershipVersion, existing.membershipVersion) > 0) {
      resetByPaper.set(reset.paperId, reset);
    }
  }

  const winnerByPair = new Map<string, PaperCollection>();
  for (const membership of memberships) {
    const id = canonicalPaperCollectionId(membership.paperId, membership.collectionId);
    const existing = winnerByPair.get(id);
    const comparison = existing
      ? compareMembershipVersions(membershipVersionOf(membership), membershipVersionOf(existing))
      : 1;
    if (comparison > 0 || (comparison === 0 && Boolean(membership.deletedAt) && !existing?.deletedAt)) {
      winnerByPair.set(id, membership);
    }
  }

  return [...winnerByPair.entries()].map(([id, membership]) => {
    const version = membershipVersionOf(membership);
    const reset = resetByPaper.get(membership.paperId);
    const survives = membershipSurvivesReset({ ...membership, membershipVersion: version }, reset);
    const nextVersion = survives || membership.deletedAt ? version : reset?.membershipVersion ?? version;
    const nextDeletedAt = survives ? undefined : membership.deletedAt ?? reset?.updatedAt;
    // Identity-preserving: a membership that reconciliation leaves unchanged is
    // returned as the same object. Callers reconcile the whole list on every
    // merge, and the persistence layer diffs by reference — fresh objects here
    // would re-mark (and re-upload) the entire membership table each time.
    if (membership.id === id
      && membership.membershipVersion === nextVersion
      && membership.deletedAt === nextDeletedAt) {
      return membership;
    }
    return { ...membership, id, membershipVersion: nextVersion, deletedAt: nextDeletedAt };
  });
}
