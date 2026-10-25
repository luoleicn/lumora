// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteDraft } from "@lumora/shared";
import { NoteContent } from "./NoteContent";
import { NoteImagePreview } from "./NoteImagePreview";
import { RichNoteEditor } from "./RichNoteEditor";

const draft = noteDraft([{ type: "text", text: "Figure caption" }, {
  type: "image", dataUrl: "data:image/png;base64,YWJj", alt: "experiment.png"
}]);

describe("note image preview", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1600);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(1000);
    vi.stubGlobal("PointerEvent", MouseEvent);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  function render(editable = false, commit = vi.fn()) {
    act(() => root.render(<>
      {editable ? <RichNoteEditor value={draft.text} content={draft.content} ariaLabel="Note" onChange={vi.fn()} onCommit={commit} /> : <NoteContent value={draft.text} content={draft.content} />}
      <NoteImagePreview />
    </>));
    return host.querySelector("img")!;
  }
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const percentage = () => document.querySelector("output")?.textContent;
  function doubleClick(image: HTMLElement) { act(() => image.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))); }
  function key(value: string, shiftKey = false) { act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }))); }

  it("opens every rendered note image in a portal, fits the image, and exposes its dimensions", () => {
    const image = render(); doubleClick(image);
    expect(dialog()?.parentElement).toBe(document.querySelector("[data-note-image-preview]"));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(dialog()?.textContent).toContain("experiment.png");
    expect(dialog()?.textContent).toContain("1,600 × 1,000");
    expect(percentage()).toBe("44%");
    expect(document.activeElement).toBe(button("Close image preview"));
  });

  it("supports zoom buttons, original size, fit, and keyboard limits", () => {
    doubleClick(render());
    act(() => button("Zoom in").click()); expect(percentage()).toBe("50%");
    act(() => button("Actual image size").click()); expect(percentage()).toBe("100%");
    act(() => button("Zoom out").click()); expect(percentage()).toBe("75%");
    act(() => button("Fit image to window").click()); expect(percentage()).toBe("44%");
    for (let i = 0; i < 20; i++) key("+");
    expect(percentage()).toBe("800%"); expect(button("Zoom in").disabled).toBe(true);
    for (let i = 0; i < 20; i++) key("-");
    expect(percentage()).toBe("5%"); expect(button("Zoom out").disabled).toBe(true);
    key("0"); expect(percentage()).toBe("44%");
  });

  it("zooms with the wheel without scrolling or invoking background shortcuts", () => {
    doubleClick(render());
    const backgroundKey = vi.fn(); window.addEventListener("keydown", backgroundKey);
    try {
      key("+"); expect(backgroundKey).not.toHaveBeenCalled();
      const event = new WheelEvent("wheel", { deltaY: -80, bubbles: true, cancelable: true });
      act(() => document.querySelector(".note-image-preview-stage")!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(Number.parseInt(percentage()!)).toBeGreaterThan(50);
    } finally { window.removeEventListener("keydown", backgroundKey); }
  });

  it("keeps focus inside the preview and restores it on Escape", () => {
    const image = render(); image.focus(); key("Enter");
    key("Tab", true); expect(document.activeElement).toBe(button("Actual image size"));
    key("Tab"); expect(document.activeElement).toBe(button("Close image preview"));
    const backgroundKey = vi.fn(); window.addEventListener("keydown", backgroundKey);
    try { key("Escape"); expect(backgroundKey).not.toHaveBeenCalled(); } finally { window.removeEventListener("keydown", backgroundKey); }
    expect(dialog()).toBeNull(); expect(document.activeElement).toBe(image);
  });

  it("preserves an editable note, its selection and pending save while previewing", () => {
    const commit = vi.fn(); const image = render(true, commit);
    const editor = host.querySelector<HTMLElement>('[role="textbox"]')!;
    editor.focus();
    const range = document.createRange(); range.setStart(editor.firstChild!, 4); range.collapse(true);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    doubleClick(image);
    expect(commit).not.toHaveBeenCalled();
    act(() => button("Zoom in").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(commit).not.toHaveBeenCalled();
    act(() => button("Close image preview").click());
    expect(document.activeElement).toBe(editor);
    expect(window.getSelection()?.anchorOffset).toBe(4);
    expect(host.querySelector("img")).toBe(image);
  });

  it("closes on the backdrop and reports image decoding failures", () => {
    doubleClick(render());
    act(() => dialog()!.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(dialog()?.textContent).toContain("This image could not be loaded.");
    expect(button("Zoom in").disabled).toBe(true);
    act(() => document.querySelector("[data-note-image-preview]")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(dialog()).toBeNull();
  });
});
