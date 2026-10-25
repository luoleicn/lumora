import { isNoteImageUrl, noteDraft, type NoteBlock, type NoteDraft } from "@lumora/shared";

/** Read only text, paragraph breaks and embedded images from the editable DOM. */
export function readNoteEditor(root: HTMLElement | DocumentFragment): NoteDraft {
  const blocks: NoteBlock[] = [];
  const text = (value: string) => {
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += value;
    else if (value) blocks.push({ type: "text", text: value });
  };
  const atLineStart = () => !blocks.length || (blocks.at(-1)?.type === "text" && (blocks.at(-1) as { text: string }).text.endsWith("\n"));
  let trailingBlockBreak = false;
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text(node.textContent ?? "");
      trailingBlockBreak = false;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.notePending || ["SCRIPT", "STYLE"].includes(node.tagName)) return;
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src");
      if (isNoteImageUrl(src)) {
        blocks.push({ type: "image", dataUrl: src, alt: node.getAttribute("alt") || "Image" });
        trailingBlockBreak = false;
      }
      return;
    }
    if (node.tagName === "BR") {
      text("\n");
      trailingBlockBreak = false;
      return;
    }
    const paragraph = ["DIV", "P", "LI", "BLOCKQUOTE"].includes(node.tagName);
    if (paragraph && !atLineStart()) text("\n");
    Array.from(node.childNodes).forEach(visit);
    if (paragraph) {
      if (!atLineStart()) text("\n");
      trailingBlockBreak = true;
    }
  };
  Array.from(root.childNodes).forEach(visit);
  const last = blocks.at(-1);
  if (trailingBlockBreak && last?.type === "text") last.text = last.text.replace(/\n$/, "");
  // A lone <br> is the browser's empty-editor placeholder.
  if (root.childNodes.length === 1 && root.firstChild?.nodeName === "BR") return { text: "" };
  return noteDraft(blocks);
}

/** A template is inert: parsing clipboard HTML must not fetch external images. */
export function readNoteClipboardHtml(html: string): NoteDraft {
  const template = document.createElement("template");
  template.innerHTML = html;
  return readNoteEditor(template.content);
}

export function createNoteImage(block: Extract<NoteBlock, { type: "image" }>): HTMLImageElement {
  const image = document.createElement("img");
  image.src = block.dataUrl;
  image.alt = block.alt;
  image.draggable = false;
  image.title = "Double-click to enlarge";
  return image;
}

/** Replacing the async placeholder must not pull the caret before the image. */
export function replaceNoteImagePlaceholder(placeholder: HTMLElement, image: HTMLImageElement) {
  const parent = placeholder.parentNode;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  const start = range?.startContainer === parent ? range.startOffset : undefined;
  const end = range?.endContainer === parent ? range.endOffset : undefined;
  placeholder.replaceWith(image);
  if (range && parent && (start !== undefined || end !== undefined)) {
    if (start !== undefined) range.setStart(parent, start);
    if (end !== undefined) range.setEnd(parent, end);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

export function writeNoteEditor(root: HTMLElement, blocks: NoteBlock[]) {
  root.replaceChildren(...blocks.map((block) => block.type === "text"
    ? document.createTextNode(block.text)
    : createNoteImage(block)));
}

export function noteEditorRange(root: HTMLElement): Range {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) return range;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

export function insertNoteNodes(root: HTMLElement, nodes: Node[]): DocumentFragment {
  const range = noteEditorRange(root);
  const replaced = range.extractContents();
  const fragment = document.createDocumentFragment();
  nodes.forEach((node) => fragment.append(node));
  const last = nodes.at(-1);
  range.insertNode(fragment);
  if (last) range.setStartAfter(last);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return replaced;
}

export function readNoteImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image. Please paste it again."));
    reader.onload = () => isNoteImageUrl(reader.result)
      ? resolve(reader.result)
      : reject(new Error("Use a PNG, JPEG, GIF or WebP image."));
    reader.readAsDataURL(file);
  });
}
