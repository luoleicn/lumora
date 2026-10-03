// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuredVirtualList } from "./MeasuredVirtualList";
import { NotebookPanel } from "./NotebookPanel";
import { PaperNotesTab } from "./PaperNotesTab";
import { prepareVirtualListSelection } from "../lib/virtualListSelection";
import type { Annotation, Paper } from "@lumora/shared";

const now = "2026-10-01T00:00:00Z";
const paper: Paper = { id: "paper", title: "Example paper", authors: [], createdAt: now, updatedAt: now };
const annotations: Annotation[] = Array.from({ length: 4172 }, (_, index) => ({
  id: String(index), paperId: paper.id, fileId: "file", kind: "highlight", pageIndex: index,
  color: "#ffee58", rects: [], quote: `Quote ${index}`, createdAt: now, updatedAt: now
}));

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  constructor(private callback: ResizeObserverCallback) { TestResizeObserver.instances.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() { this.callback([], this as unknown as ResizeObserver); }
}

describe("measured virtual list interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let width: number;
  let rowHeight: number;
  let heights: Map<string, number>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    TestResizeObserver.instances = [];
    width = 800; rowHeight = 100; heights = new Map();
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      const content = this.querySelector<HTMLElement>("[data-virtual-content]");
      return content ? Number.parseFloat(content.style.height) : 700;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>(".sync-panel") ?? this.closest<HTMLElement>("[data-virtual-list]");
      const top = this.hasAttribute("data-virtual-content") ? -(scroller?.scrollTop ?? 0) : 0;
      const height = this.hasAttribute("data-virtual-item") ? heights.get(this.dataset.virtualItem!) ?? rowHeight : 700;
      return { x: 0, y: top, top, bottom: top + height, left: 0, right: width, width, height, toJSON() {} };
    });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  function settle() { act(() => { vi.runAllTimers(); }); }
  function scrollTo(top: number) {
    act(() => { const list = host.querySelector<HTMLElement>("[data-virtual-list]")!; list.scrollTop = top; list.dispatchEvent(new Event("scroll")); });
    settle();
  }
  function renderList(items = annotations) {
    act(() => root.render(<MeasuredVirtualList items={items} renderItem={(item) => <article><button>{item.quote}</button></article>} />));
    settle();
  }

  it("mounts a bounded window and reaches the last annotation", () => {
    renderList();
    expect(host.querySelectorAll("article").length).toBeLessThan(100);
    expect(host.textContent).toContain("Quote 0");
    const total = Number.parseFloat(host.querySelector<HTMLElement>("[data-virtual-content]")!.style.height);
    scrollTo(total - 700);
    expect(host.textContent).toContain("Quote 4171");
    expect(host.querySelectorAll("article").length).toBeLessThan(100);
  });

  it("searches unmounted notebook annotations and still opens the matching paper", () => {
    const open = vi.fn();
    act(() => root.render(<NotebookPanel papers={[paper]} annotations={annotations} onOpenPaper={open} />)); settle();
    expect(host.textContent).not.toContain("Quote 4171");
    act(() => {
      const input = host.querySelector<HTMLInputElement>("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Quote 4171");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }); settle();
    expect(host.textContent).toContain("Quote 4171");
    expect(host.querySelectorAll("article")).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>("article button")!.click());
    expect(open).toHaveBeenCalledWith(paper.id);
  });

  it("retains focused and selected cards outside the visible window", () => {
    renderList();
    const first = host.querySelector<HTMLElement>("[data-virtual-item='0']")!;
    act(() => first.querySelector<HTMLButtonElement>("button")!.focus());
    const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(first);
    act(() => { selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
    expect(selection.toString()).toBe("Quote 0");
    const selectedText = first.querySelector("button")!.firstChild;
    scrollTo(8_000);
    expect(host.querySelector("[data-virtual-item='0']")).toBe(first);
    expect(first.querySelector("button")!.firstChild).toBe(selectedText);
    expect(selection.toString()).toBe("Quote 0");
    act(() => { selection.removeAllRanges(); host.querySelector<HTMLButtonElement>("button")!.blur(); document.dispatchEvent(new Event("selectionchange")); });
    settle();
    expect(host.querySelector("[data-virtual-item='0']")).toBeNull();
  });

  it("tabs to an unmounted neighbor in both directions", () => {
    renderList();
    const rows = [...host.querySelectorAll<HTMLElement>("[data-virtual-item]")];
    const last = rows.at(-1)!; const index = Number(last.dataset.virtualItem);
    act(() => { last.querySelector<HTMLButtonElement>("button")!.focus(); last.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    settle();
    expect(document.activeElement?.textContent).toBe(`Quote ${index + 1}`);
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    settle();
    expect(document.activeElement?.textContent).toBe(`Quote ${index}`);
  });

  it("materializes all text for workspace Select All and releases it after copying", () => {
    renderList(annotations.slice(0, 440));
    act(() => prepareVirtualListSelection(host));
    expect(host.querySelectorAll("article")).toHaveLength(440);
    const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(host);
    act(() => { selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
    expect(selection.toString()).toContain("Quote 439");
    act(() => { selection.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); }); settle();
    expect(host.querySelectorAll("article").length).toBeLessThan(100);
  });

  it("remeasures changed content and width while keeping the visible anchor", () => {
    renderList(); scrollTo(750);
    const scroll = host.querySelector<HTMLElement>("[data-virtual-list]")!;
    const before = scroll.scrollTop;
    heights.set("0", 400);
    act(() => TestResizeObserver.instances.forEach((observer) => observer.fire())); settle();
    expect(scroll.scrollTop).toBe(before + 300);
    width = 600;
    const updated = annotations.map((item) => item.id === "7" ? { ...item, quote: "Updated long note" } : item);
    act(() => root.render(<MeasuredVirtualList items={updated} renderItem={(item) => <article><button>{item.quote}</button></article>} />));
    act(() => TestResizeObserver.instances.forEach((observer) => observer.fire())); settle();
    expect(host.textContent).toContain("Updated long note");
  });

  it("keeps the personal editor mounted and deletes a note in the existing inspector scroller", () => {
    const deleted = vi.fn(); const long = { ...annotations[0], comment: "Long note ".repeat(1000) };
    act(() => root.render(<aside className="sync-panel"><PaperNotesTab paper={paper} annotations={[long, ...annotations.slice(1, 440)]} onUpdatePaper={vi.fn()} onDeleteAnnotation={deleted} /></aside>)); settle();
    const editor = host.querySelector("textarea");
    expect(host.textContent).toContain(long.comment);
    act(() => host.querySelector<HTMLButtonElement>("article button")!.click());
    expect(deleted).toHaveBeenCalledWith(long);
    act(() => { const scroll = host.querySelector<HTMLElement>("aside")!; scroll.scrollTop = 20_000; scroll.dispatchEvent(new Event("scroll")); }); settle();
    expect(host.querySelector("textarea")).toBe(editor);
    expect(host.querySelectorAll("article").length).toBeLessThan(100);
  });
});
