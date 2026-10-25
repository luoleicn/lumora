import { Fragment } from "react";
import { noteBlocks, type NoteContent as Content } from "@lumora/shared";

export function NoteContent({ value, content }: { value: string; content?: Content }) {
  return <div className="note-content"><NoteBlocks value={value} content={content} /></div>;
}

export function NoteBlocks({ value, content, editable = false }: { value: string; content?: Content; editable?: boolean }) {
  return <>{noteBlocks(value, content).map((block, index) => block.type === "text"
    ? <Fragment key={index}>{block.text}</Fragment>
    : <img key={index} src={block.dataUrl} alt={block.alt} loading="lazy" draggable={false} title="Double-click to enlarge"
        tabIndex={editable ? undefined : 0} role={editable ? undefined : "button"} aria-label={editable ? undefined : `Preview image: ${block.alt}`} />)}</>;
}
