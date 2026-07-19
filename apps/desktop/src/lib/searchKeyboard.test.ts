import { describe, expect, it, vi } from "vitest";
import { handleSearchEscape } from "./searchKeyboard";

describe("handleSearchEscape", () => {
  it("prevents the default action and clears search on Escape", () => {
    const preventDefault = vi.fn();
    const onEscape = vi.fn();

    expect(handleSearchEscape({ key: "Escape", preventDefault }, onEscape)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("leaves other keys to the caller", () => {
    const preventDefault = vi.fn();
    const onEscape = vi.fn();

    expect(handleSearchEscape({ key: "Enter", preventDefault }, onEscape)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });
});
