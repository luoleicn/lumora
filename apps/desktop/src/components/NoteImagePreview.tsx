import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, Maximize, Minus, Plus, X } from "lucide-react";
import { isNoteImageUrl } from "@lumora/shared";
import { constrainImageView, fitImageScale, maxImageScale, minImageScale, stepImageScale, zoomImageAt, type ImageSize, type ImageView } from "../lib/imagePreview";

type PreviewImage = ImageSize & { src: string; name: string };

/** One host serves rendered notes and images inserted imperatively into editors. */
export function NoteImagePreview() {
  const [image, setImage] = useState<PreviewImage>();
  const returnTarget = useRef<HTMLElement | undefined>(undefined);
  const returnSelection = useRef<Range | undefined>(undefined);
  const close = useCallback(() => setImage(undefined), []);

  useEffect(() => {
    const openImage = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && (event.key !== "Enter" && event.key !== " ")) return;
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !target.matches(".note-content img") || !isNoteImageUrl(target.getAttribute("src"))) return;
      event.preventDefault();
      event.stopPropagation();
      const editor = target.closest<HTMLElement>('[contenteditable="true"]');
      returnTarget.current = editor ?? target;
      const selection = window.getSelection();
      returnSelection.current = editor && selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange() : undefined;
      setImage({ src: target.src, name: target.alt || "Note image", width: target.naturalWidth, height: target.naturalHeight });
    };
    document.addEventListener("dblclick", openImage, true);
    document.addEventListener("keydown", openImage, true);
    return () => {
      document.removeEventListener("dblclick", openImage, true);
      document.removeEventListener("keydown", openImage, true);
    };
  }, []);

  const restoreFocus = useCallback(() => {
    const target = returnTarget.current;
    if (!target?.isConnected) return;
    target.focus({ preventScroll: true });
    const range = returnSelection.current;
    if (range?.commonAncestorContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, []);

  return image ? createPortal(<ImagePreviewDialog image={image} onClose={close} onRestoreFocus={restoreFocus} />, document.body) : null;
}

function ImagePreviewDialog({ image, onClose, onRestoreFocus }: {
  image: PreviewImage;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ImageSize>(image);
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });
  const [customView, setCustomView] = useState<ImageView>();
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; view: ImageView } | undefined>(undefined);
  const fittedScale = fitImageScale(size, viewport);
  const view = constrainImageView(customView ?? { scale: fittedScale, x: 0, y: 0 }, size, viewport);
  const canPan = size.width * view.scale > viewport.width - 96 || size.height * view.scale > viewport.height - 96;
  const ready = size.width > 0 && size.height > 0 && !failed;
  const zoom = (scale: number, anchor?: { x: number; y: number }) => {
    setCustomView(constrainImageView(zoomImageAt(view, scale, anchor), size, viewport));
  };
  const actions = useRef({ zoom, view, ready, onClose });
  actions.current = { zoom, view, ready, onClose };

  useLayoutEffect(() => {
    // relatedTarget identifies the preview to the note editor's blur handler.
    closeRef.current?.focus({ preventScroll: true });
    return onRestoreFocus;
  }, [onRestoreFocus]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      const current = actions.current;
      if (event.key === "Escape") { event.preventDefault(); current.onClose(); }
      else if (["+", "=", "-", "0", "1"].includes(event.key) && current.ready) {
        event.preventDefault();
        if (event.key === "0") setCustomView(undefined);
        else if (event.key === "1") setCustomView({ scale: 1, x: 0, y: 0 });
        else current.zoom(stepImageScale(current.view.scale, event.key === "-" ? -1 : 1));
      } else if (event.key === "Tab") {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      } else if (event.metaKey || event.ctrlKey) event.preventDefault();
    };
    // Capture before library/PDF shortcuts, even when a note editor was focused.
    window.addEventListener("keydown", handleKeyDown, true);
    const stage = stageRef.current;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const current = actions.current;
      if (!current.ready || !stage) return;
      const bounds = stage.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
      current.zoom(current.view.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.005), {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2
      });
    };
    stage?.addEventListener("wheel", handleWheel, { passive: false });
    // WKWebView emits gesture events for trackpad pinches instead of ctrl+wheel.
    let pinchScale = 1;
    const startPinch = (event: Event) => { event.preventDefault(); pinchScale = actions.current.view.scale; };
    const pinch = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale: number }).scale;
      if (actions.current.ready && Number.isFinite(scale)) actions.current.zoom(pinchScale * scale);
    };
    stage?.addEventListener("gesturestart", startPinch);
    stage?.addEventListener("gesturechange", pinch);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      stage?.removeEventListener("wheel", handleWheel);
      stage?.removeEventListener("gesturestart", startPinch);
      stage?.removeEventListener("gesturechange", pinch);
    };
  }, []);

  return (
    <div className="note-image-preview-backdrop" data-note-image-preview="" onPointerDown={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
    }} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
      <section className="note-image-preview" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Note image preview">
        <header className="note-image-preview-header">
          <div className="note-image-preview-title">
            <span className="note-image-preview-mark"><ImageIcon size={19} /></span>
            <div><span className="note-image-preview-eyebrow">NOTE IMAGE</span><h2>{image.name}</h2></div>
          </div>
          <div className="note-image-preview-meta">
            {ready && <span>{size.width.toLocaleString()} × {size.height.toLocaleString()}</span>}
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close image preview" title="Close (Esc)"><X size={19} /></button>
          </div>
        </header>
        <div className={`note-image-preview-stage${ready && canPan ? " pannable" : ""}${dragging ? " dragging" : ""}`} ref={stageRef}
          onDoubleClick={(event) => { event.preventDefault(); if (ready) customView ? setCustomView(undefined) : zoom(view.scale < 1 ? 1 : 2); }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !ready || !canPan) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setCustomView(constrainImageView({ ...drag.view, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y }, size, viewport));
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            dragRef.current = undefined;
            event.currentTarget.releasePointerCapture(event.pointerId);
            setDragging(false);
          }}
          onPointerCancel={() => { dragRef.current = undefined; setDragging(false); }}
          onLostPointerCapture={() => { dragRef.current = undefined; setDragging(false); }}
        >
          <img src={image.src} alt={image.name} draggable={false} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setFailed(true)} style={{ width: size.width || undefined, height: size.height || undefined, visibility: ready ? "visible" : "hidden", transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
          {!ready && <p className="note-image-preview-status" role="status">{failed ? "This image could not be loaded." : "Loading image…"}</p>}
        </div>
        <footer className="note-image-preview-footer">
          <span className="note-image-preview-hint">Scroll to zoom · Drag to pan</span>
          <div className="note-image-preview-tools" role="toolbar" aria-label="Image zoom controls">
            <button type="button" onClick={() => zoom(stepImageScale(view.scale, -1))} disabled={!ready || view.scale <= minImageScale} aria-label="Zoom out" title="Zoom out (−)"><Minus size={17} /></button>
            <output aria-label="Image zoom">{Math.round(view.scale * 100)}%</output>
            <button type="button" onClick={() => zoom(stepImageScale(view.scale, 1))} disabled={!ready || view.scale >= maxImageScale} aria-label="Zoom in" title="Zoom in (+)"><Plus size={17} /></button>
            <span className="note-image-preview-divider" />
            <button type="button" className={!customView ? "active" : ""} onClick={() => setCustomView(undefined)} disabled={!ready} aria-label="Fit image to window" title="Fit to window (0)"><Maximize size={15} /><span>Fit</span></button>
            <button type="button" onClick={() => setCustomView({ scale: 1, x: 0, y: 0 })} disabled={!ready} aria-label="Actual image size" title="Actual size (1)"><span>1:1</span></button>
          </div>
          <span className="note-image-preview-hint note-image-preview-escape"><kbd>esc</kbd> to close</span>
        </footer>
      </section>
    </div>
  );
}
