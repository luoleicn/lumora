import { describe, expect, it } from "vitest";
import {
  createPaperSelection,
  reconcilePaperSelection,
  selectAllPapers,
  updatePaperSelection
} from "./paperSelection";

const paperIds = ["paper-a", "paper-b", "paper-c", "paper-d"];

describe("paper selection", () => {
  it("replaces and toggles individual papers", () => {
    const selectedA = updatePaperSelection(createPaperSelection(), "paper-a", paperIds, "replace");
    const selectedAB = updatePaperSelection(selectedA, "paper-b", paperIds, "toggle");

    expect(selectedAB).toEqual({
      selectedIds: ["paper-a", "paper-b"],
      primaryId: "paper-b",
      anchorId: "paper-b"
    });
    expect(updatePaperSelection(selectedAB, "paper-b", paperIds, "toggle")).toEqual({
      selectedIds: ["paper-a"],
      primaryId: "paper-a",
      anchorId: "paper-a"
    });
  });

  it("selects a contiguous range from the last anchor", () => {
    const selectedB = createPaperSelection("paper-b");

    expect(updatePaperSelection(selectedB, "paper-d", paperIds, "range")).toEqual({
      selectedIds: ["paper-b", "paper-c", "paper-d"],
      primaryId: "paper-d",
      anchorId: "paper-b"
    });
  });

  it("selects every paper in the supplied collection order", () => {
    expect(selectAllPapers(createPaperSelection("paper-c"), paperIds)).toEqual({
      selectedIds: paperIds,
      primaryId: "paper-c",
      anchorId: "paper-c"
    });
  });

  it("drops selections that are no longer in the active collection", () => {
    const selected = selectAllPapers(createPaperSelection("paper-c"), paperIds);

    expect(reconcilePaperSelection(selected, ["paper-a", "paper-d"])).toEqual({
      selectedIds: ["paper-a", "paper-d"],
      primaryId: "paper-d",
      anchorId: "paper-d"
    });
  });
});
