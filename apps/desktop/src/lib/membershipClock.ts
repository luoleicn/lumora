import {
  compareMembershipVersions,
  membershipVersionOf,
  type LibraryState,
  type MembershipVersion
} from "@lumora/shared";

const nodeIdKey = "lumora:membership-node-id-v1";
let lastVersion: MembershipVersion | undefined;
let fallbackNodeId: string | undefined;

function nodeId(): string {
  if (typeof localStorage === "undefined") {
    fallbackNodeId ??= crypto.randomUUID();
    return fallbackNodeId;
  }
  const existing = localStorage.getItem(nodeIdKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(nodeIdKey, created);
  return created;
}

export function nextMembershipVersion(state: LibraryState, nowMs = Date.now()): MembershipVersion {
  let observed = lastVersion?.kind === "hlc" ? lastVersion : undefined;
  const candidates = [
    ...state.paperCollections.map(membershipVersionOf),
    ...(state.paperCollectionResets ?? []).map((item) => item.membershipVersion)
  ];
  for (const candidate of candidates) {
    if (candidate.kind === "hlc" && (!observed || compareMembershipVersions(candidate, observed) > 0)) {
      observed = candidate;
    }
  }
  const wallTimeMs = Math.max(nowMs, observed?.wallTimeMs ?? 0);
  const version: MembershipVersion = {
    kind: "hlc",
    wallTimeMs,
    counter: observed?.wallTimeMs === wallTimeMs ? observed.counter + 1 : 0,
    nodeId: nodeId(),
    operationId: crypto.randomUUID()
  };
  lastVersion = version;
  return version;
}
