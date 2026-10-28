export function AnnotationLoading({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return (
    <div className="annotation-load-status" role={error ? "alert" : "status"}>
      <p>{error ? "Unable to load notes and highlights." : "Loading notes and highlights…"}</p>
      {error && <button type="button" onClick={onRetry}>Retry</button>}
    </div>
  );
}
