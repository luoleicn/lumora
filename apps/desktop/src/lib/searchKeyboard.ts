type SearchKeyboardEvent = {
  key: string;
  preventDefault: () => void;
};

/**
 * Applies the shared Escape behavior for toolbar search inputs.
 * Returns whether the event was handled so callers can compose other shortcuts.
 */
export function handleSearchEscape(event: SearchKeyboardEvent, onEscape: () => void): boolean {
  if (event.key !== "Escape") {
    return false;
  }

  event.preventDefault();
  onEscape();
  return true;
}
