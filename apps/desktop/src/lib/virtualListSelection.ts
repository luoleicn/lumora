export const prepareVirtualListSelectionEvent = "lumora-prepare-virtual-list-selection";

/** Materialize full text for the existing workspace Select All / Copy action. */
export function prepareVirtualListSelection(container: HTMLElement): void {
  for (const list of container.querySelectorAll<HTMLElement>("[data-virtual-list]")) {
    list.dispatchEvent(new Event(prepareVirtualListSelectionEvent));
  }
}
