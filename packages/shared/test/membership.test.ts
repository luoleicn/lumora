import { describe, expect, it } from "vitest";
import {
  canonicalPaperCollectionId,
  compareMembershipVersions,
  reconcilePaperCollections,
  type MembershipVersion,
  type PaperCollection,
  type PaperCollectionReset
} from "../src/index.js";

const legacyTime = "2026-07-01T00:00:00.000Z";
const moveTime = "2026-07-02T00:00:00.000Z";

function hlc(wallTimeMs: number, operationId: string): MembershipVersion {
  return { kind: "hlc", wallTimeMs, counter: 0, nodeId: "device-a", operationId };
}

function membership(
  collectionId: string,
  membershipVersion?: MembershipVersion
): PaperCollection {
  return {
    id: `random-${collectionId}`,
    paperId: "paper-a",
    collectionId,
    membershipVersion,
    createdAt: legacyTime,
    updatedAt: legacyTime
  };
}

describe("paper collection membership reconciliation", () => {
  it("uses one deterministic identity for a logical paper/collection pair", () => {
    expect(canonicalPaperCollectionId("paper-a", "collection-b"))
      .toBe("paper_collection:7:paper-acollection-b");
  });

  it("orders every versioned operation after legacy timestamp records", () => {
    const legacy: MembershipVersion = {
      kind: "legacy",
      updatedAt: "2099-01-01T00:00:00.000Z",
      deleted: false,
      entityId: "legacy-membership"
    };

    expect(compareMembershipVersions(hlc(1, "new-operation"), legacy)).toBeGreaterThan(0);
  });

  it("keeps only the semantic winner when devices use different entity ids", () => {
    const older = membership("collection-a", hlc(10, "older"));
    const newer = { ...membership("collection-a", hlc(20, "newer")), id: "other-device-id" };

    const result = reconcilePaperCollections([older, newer], []);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      id: canonicalPaperCollectionId("paper-a", "collection-a"),
      membershipVersion: newer.membershipVersion
    }));
  });

  it("prevents a delayed pre-move membership from resurrecting", () => {
    const moveVersion = hlc(20, "move");
    const reset: PaperCollectionReset = {
      id: "paper_collection_reset:7:paper-a",
      paperId: "paper-a",
      targetCollectionId: "collection-b",
      membershipVersion: moveVersion,
      createdAt: moveTime,
      updatedAt: moveTime
    };

    const result = reconcilePaperCollections([
      membership("collection-a"),
      membership("collection-b", moveVersion)
    ], [reset]);

    expect(result.find((item) => item.collectionId === "collection-a")?.deletedAt).toBe(moveTime);
    expect(result.find((item) => item.collectionId === "collection-b")?.deletedAt).toBeUndefined();
  });

  it("allows an explicit add made after a move reset", () => {
    const reset: PaperCollectionReset = {
      id: "paper_collection_reset:7:paper-a",
      paperId: "paper-a",
      targetCollectionId: "collection-b",
      membershipVersion: hlc(20, "move"),
      createdAt: moveTime,
      updatedAt: moveTime
    };

    const result = reconcilePaperCollections([
      membership("collection-a", hlc(30, "later-add")),
      membership("collection-b", reset.membershipVersion)
    ], [reset]);

    expect(result.filter((item) => !item.deletedAt).map((item) => item.collectionId).sort())
      .toEqual(["collection-a", "collection-b"]);
  });
});
