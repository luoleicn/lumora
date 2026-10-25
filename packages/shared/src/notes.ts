/** Portable note content. Images travel with the entity, including offline copies. */
export type NoteBlock =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; alt: string };

export type NoteContent = { version: 1; blocks: NoteBlock[] };
export type NoteDraft = { text: string; content?: NoteContent };

export const maxNoteImageBytes = 5 * 1024 * 1024;
export const maxNoteContentBytes = 20 * 1024 * 1024;

/** Only embedded raster images may render; never depend on a path or remote URL. */
export function isNoteImageUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= Math.ceil(maxNoteImageBytes / 3) * 4 + 64
    && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function noteBlocks(text: string, content?: NoteContent): NoteBlock[] {
  if (content?.version !== 1 || !Array.isArray(content.blocks)) {
    return text ? [{ type: "text", text }] : [];
  }
  return content.blocks.flatMap((block): NoteBlock[] => {
    if (block?.type === "text" && typeof block.text === "string") return [block];
    if (block?.type === "image" && isNoteImageUrl(block.dataUrl)) {
      return [{ type: "image", dataUrl: block.dataUrl, alt: typeof block.alt === "string" ? block.alt : "Image" }];
    }
    return [];
  });
}

export function noteDraft(blocks: NoteBlock[]): NoteDraft {
  const normalized: NoteBlock[] = [];
  for (const block of blocks) {
    const last = normalized.at(-1);
    if (block.type === "text") {
      if (!block.text) continue;
      if (last?.type === "text") last.text += block.text;
      else normalized.push({ ...block });
    } else if (isNoteImageUrl(block.dataUrl)) normalized.push({ ...block });
  }
  const hasImages = normalized.some((block) => block.type === "image");
  // Keep a readable fallback for search, Mendeley and older installations.
  const text = normalized.map((block) => block.type === "text" ? block.text : `\n[${block.alt || "Image"}]\n`).join("");
  return { text, content: hasImages ? { version: 1, blocks: normalized } : undefined };
}

export function noteDraftsEqual(left: NoteDraft, right: NoteDraft): boolean {
  if (left.text !== right.text) return false;
  if (left.content === right.content) return true;
  if (!left.content || !right.content || left.content.version !== right.content.version) return false;
  if (!Array.isArray(left.content.blocks) || !Array.isArray(right.content.blocks)) return false;
  const other = right.content.blocks;
  return left.content.blocks.length === other.length && left.content.blocks.every((block, index) => {
    const next = other[index];
    return block.type === "text"
      ? next.type === "text" && block.text === next.text
      : next.type === "image" && block.dataUrl === next.dataUrl && block.alt === next.alt;
  });
}
