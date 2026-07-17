export function formatActionError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to the generic string conversion.
    }
  }
  return String(error || "Action failed.");
}
