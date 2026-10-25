import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { maxNoteContentBytes, maxNoteImageBytes, noteBlocks, noteDraftsEqual, type NoteContent, type NoteDraft } from "@lumora/shared";
import { createNoteImage, insertNoteNodes, readNoteClipboardHtml, readNoteEditor, readNoteImage, replaceNoteImagePlaceholder, writeNoteEditor } from "../lib/noteEditorDom";
import { NoteBlocks } from "./NoteContent";

type RichNoteEditorProps = {
  value: string;
  content?: NoteContent;
  onChange: (draft: NoteDraft) => void;
  /** Save on leaving the editor, including images still being read on close. */
  onCommit?: (draft: NoteDraft) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
};

export function RichNoteEditor(props: RichNoteEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const initial = useRef<NoteDraft>({ text: props.value, content: props.content });
  const published = useRef(initial.current);
  const pending = useRef(new Set<Promise<void>>());
  const pendingBytes = useRef(0);
  const mounted = useRef(false);
  const [error, setError] = useState("");

  const publish = (root: HTMLElement) => {
    const draft = readNoteEditor(root);
    if (!noteDraftsEqual(draft, published.current)) {
      published.current = draft;
      callbacks.current.onChange(draft);
    }
    return draft;
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    const next = { text: props.value, content: props.content };
    if (root && !noteDraftsEqual(next, published.current)) {
      writeNoteEditor(root, noteBlocks(props.value, props.content));
      published.current = next;
    }
  }, [props.value, props.content]);

  useEffect(() => {
    mounted.current = true;
    const root = rootRef.current;
    if (root && props.autoFocus) {
      root.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return () => {
      mounted.current = false;
      // Finish a paste against this editor's detached DOM and original owner.
      // Virtualizing a PDF page or selecting another paper must not lose bytes.
      if (root && pending.current.size) {
        const commit = callbacks.current.onCommit ?? callbacks.current.onChange;
        void Promise.all([...pending.current]).then(() => commit(readNoteEditor(root)));
      }
    };
  }, []);

  return (
    <div className="rich-note-editor">
      <div
        ref={rootRef}
        className="note-content note-editable"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={props.ariaLabel}
        aria-multiline="true"
        data-placeholder={props.placeholder}
        onInput={(event) => publish(event.currentTarget)}
        onKeyDown={props.onKeyDown}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-note-image-preview]")) return;
          const root = event.currentTarget;
          const commit = callbacks.current.onCommit;
          if (!commit) return;
          if (pending.current.size) void Promise.all([...pending.current]).then(() => commit(readNoteEditor(root)));
          else commit(publish(root));
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setError("Paste an image from the clipboard to add it to this note.");
        }}
        onPaste={(event) => {
          event.preventDefault();
          setError("");
          const root = event.currentTarget;
          const files = Array.from(event.clipboardData.files);
          const images = files.filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
          if (files.length && images.length !== files.length) {
            setError("Use a PNG, JPEG, GIF or WebP image.");
            return;
          }
          if (images.some((file) => file.size > maxNoteImageBytes)) {
            setError("Each image must be 5 MB or smaller.");
            return;
          }
          const plainText = event.clipboardData.getData("text/plain");
          const html = !images.length ? event.clipboardData.getData("text/html") : "";
          const copied = html ? readNoteClipboardHtml(html) : undefined;
          const currentBytes = JSON.stringify(readNoteEditor(root)).length;
          const incomingBytes = copied?.content ? JSON.stringify(copied).length
            : images.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0) + plainText.length;
          if (currentBytes + pendingBytes.current + incomingBytes > maxNoteContentBytes) {
            setError("This note is full (20 MB). Use a smaller image or remove an image first.");
            return;
          }
          if (!images.length) {
            // Retain embedded images copied from notes; ignore external URLs and markup.
            if (copied?.content) insertNoteNodes(root, noteBlocks(copied.text, copied.content).map((block) => block.type === "text"
              ? document.createTextNode(block.text) : createNoteImage(block)));
            else if (plainText) insertNoteNodes(root, [document.createTextNode(plainText)]);
            publish(root);
            return;
          }
          const placeholders = images.map(() => {
            const node = document.createElement("span");
            node.dataset.notePending = "true";
            node.contentEditable = "false";
            node.textContent = "Adding image…";
            return node;
          });
          const replaced = insertNoteNodes(root, [...(plainText ? [document.createTextNode(plainText)] : []), ...placeholders]);
          pendingBytes.current += incomingBytes;
          const task = Promise.all(images.map(readNoteImage)).then((urls) => {
            urls.forEach((dataUrl, index) => replaceNoteImagePlaceholder(placeholders[index], createNoteImage({
              type: "image", dataUrl, alt: images[index].name || "Image"
            })));
            if (mounted.current) publish(root);
          }).catch((reason: unknown) => {
            placeholders[0]?.replaceWith(replaced);
            placeholders.forEach((node) => node.remove());
            if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
          });
          pending.current.add(task);
          void task.finally(() => {
            pending.current.delete(task);
            pendingBytes.current -= incomingBytes;
          });
        }}
      >
        {/* Keep this initial tree stable; native editing owns the DOM and caret. */}
        <NoteBlocks value={initial.current.text} content={initial.current.content} editable />
      </div>
      {error && <div className="note-editor-error" role="alert">{error}</div>}
    </div>
  );
}
