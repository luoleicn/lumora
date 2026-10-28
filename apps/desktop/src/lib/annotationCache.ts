import type { Annotation } from "@lumora/shared";

/** Hydration adds persisted rows without overwriting local edits/tombstones. */
export function mergeAnnotationCache(current: Annotation[], loaded: Annotation[]): Annotation[] {
  const ids = new Set(current.map((annotation) => annotation.id));
  const additions = loaded.filter((annotation) => !ids.has(annotation.id));
  return additions.length ? [...current, ...additions] : current;
}
