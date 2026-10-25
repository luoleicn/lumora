// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxNoteImageBytes, noteDraft, type NoteDraft } from "@lumora/shared";
import { RichNoteEditor } from "./RichNoteEditor";
import { readNoteClipboardHtml, readNoteEditor } from "../lib/noteEditorDom";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const image = { type: "image" as const, dataUrl, alt: "figure.png" };

describe("rich note editing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changed: ReturnType<typeof vi.fn>;
  let committed: ReturnType<typeof vi.fn>;
  let reader: { onload: (() => void) | null; onerror: (() => void) | null; result: string };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    changed = vi.fn(); committed = vi.fn();
    vi.stubGlobal("FileReader", class {
      onload = null;
      onerror = null;
      result = dataUrl;
      constructor() { reader = this; }
      readAsDataURL() {}
    });
  });

  afterEach(() => {
    act(() => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
  });

  function render(initial: NoteDraft = { text: "Before after" }) {
    function Editor() {
      const [draft, setDraft] = useState(initial);
      return <RichNoteEditor value={draft.text} content={draft.content} ariaLabel="Note" onChange={(next) => { changed(next); setDraft(next); }} onCommit={committed} />;
    }
    act(() => root.render(<Editor />));
    return host.querySelector<HTMLElement>('[role="textbox"]')!;
  }

  function select(editor: HTMLElement, start: number, end = start) {
    const range = document.createRange(); range.setStart(editor.firstChild!, start); range.setEnd(editor.firstChild!, end);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  }

  function paste(editor: HTMLElement, files: File[] = [], text = "", html = "") {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files, getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "" } });
    act(() => editor.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  }

  async function finishImage() {
    await act(async () => { reader.onload!(); await Promise.resolve(); });
  }

  it("pastes an image at the caret, retains surrounding text and reopens the saved layout", async () => {
    const editor = render(); select(editor, 7);
    paste(editor, [new File(["png"], "figure.png", { type: "image/png" })]);
    await finishImage();
    const saved = changed.mock.lastCall![0] as NoteDraft;
    expect(saved.content?.blocks).toEqual([{ type: "text", text: "Before " }, image, { type: "text", text: "after" }]);
    expect(editor.querySelector("img")?.src).toBe(dataUrl);
    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(editor);
    expect(selection.anchorOffset).toBe(Array.from(editor.childNodes).indexOf(editor.querySelector("img")!) + 1);
    act(() => root.render(<RichNoteEditor value={saved.text} content={saved.content} ariaLabel="Reopened" onChange={changed} />));
    expect(readNoteEditor(host.querySelector<HTMLElement>('[role="textbox"]')!)).toEqual(saved);
  });

  it("commits a pending paste to the original note when it closes before FileReader finishes", async () => {
    const editor = render({ text: "" });
    paste(editor, [new File(["png"], "figure.png", { type: "image/png" })]);
    act(() => root.render(<div>Another paper</div>));
    await finishImage();
    expect(committed).toHaveBeenCalledWith(noteDraft([image]));
    expect(host.textContent).toBe("Another paper");
  });

  it("waits for a paste before committing on blur", async () => {
    const editor = render({ text: "" });
    paste(editor, [new File(["png"], "figure.png", { type: "image/png" })]);
    act(() => editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(committed).not.toHaveBeenCalled();
    await finishImage();
    expect(committed).toHaveBeenCalledWith(noteDraft([image]));
  });

  it("keeps the caret and live editor node during controlled text updates", () => {
    const editor = render(); select(editor, 7, 12);
    paste(editor, [], "new text");
    expect(editor.textContent).toBe("Before new text");
    expect(host.querySelector('[role="textbox"]')).toBe(editor);
    expect(editor.contains(window.getSelection()?.anchorNode ?? null)).toBe(true);
    expect(changed).toHaveBeenCalledWith({ text: "Before new text", content: undefined });
  });

  it("supports deleting an image and returning to a plain text note", () => {
    const editor = render(noteDraft([{ type: "text", text: "Caption" }, image]));
    act(() => { editor.querySelector("img")!.remove(); editor.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(changed).toHaveBeenCalledWith({ text: "Caption", content: undefined });
  });

  it("preserves embedded images copied with text and strips unsafe HTML", () => {
    const editor = render({ text: "" });
    paste(editor, [], "Caption", `<p>Caption</p><img src="${dataUrl}" alt="figure.png"><script>bad()</script><img src="https://example.com/remote.png">`);
    expect(editor.querySelectorAll("img")).toHaveLength(1);
    expect(editor.querySelector("script")).toBeNull();
    expect(changed.mock.lastCall![0].content.blocks.some((block: { type: string }) => block.type === "image")).toBe(true);
    const external = readNoteClipboardHtml('<p>Safe</p><img src="file:///tmp/missing.png">');
    expect(external).toEqual({ text: "Safe", content: undefined });
  });

  it("rejects oversized and SVG images without changing the note", () => {
    const editor = render();
    const large = new File(["png"], "large.png", { type: "image/png" });
    Object.defineProperty(large, "size", { value: maxNoteImageBytes + 1 });
    paste(editor, [large]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("5 MB");
    paste(editor, [new File(["<svg>"], "image.svg", { type: "image/svg+xml" })]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("PNG");
    expect(editor.textContent).toBe("Before after");
    expect(changed).not.toHaveBeenCalled();
  });

  it("restores selected text when reading an image fails", async () => {
    const editor = render(); select(editor, 7, 12);
    paste(editor, [new File(["png"], "figure.png", { type: "image/png" })]);
    await act(async () => { reader.onerror!(); await Promise.resolve(); });
    expect(editor.textContent).toBe("Before after");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not read");
  });

  it("retains WebKit and Chromium paragraph breaks", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "First<div>Second</div><div><br></div><div>Fourth</div>";
    expect(readNoteEditor(editor).text).toBe("First\nSecond\n\nFourth");
    editor.innerHTML = "<p>First</p><p>Second</p>";
    expect(readNoteEditor(editor).text).toBe("First\nSecond");
  });
});
