import { Component, type ErrorInfo, type ReactNode } from "react";

const runtimeErrorStorageKey = "lumora:last-runtime-error";

type RuntimeErrorBoundaryProps = {
  children: ReactNode;
};

type RuntimeErrorBoundaryState = {
  error?: Error;
};

export function reportRuntimeError(source: string, reason: unknown, componentStack?: string) {
  const error = normalizeRuntimeError(reason);
  const report = {
    source,
    message: error.message,
    stack: error.stack,
    componentStack,
    occurredAt: new Date().toISOString()
  };

  console.error(`[${source}] ${error.message}`, reason);
  try {
    window.localStorage.setItem(runtimeErrorStorageKey, JSON.stringify(report));
  } catch {
    // The visible fallback remains available if WebKit storage is unavailable.
  }
}

export class RuntimeErrorBoundary extends Component<RuntimeErrorBoundaryProps, RuntimeErrorBoundaryState> {
  state: RuntimeErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): RuntimeErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRuntimeError("react.error-boundary", error, info.componentStack ?? undefined);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <main className="runtime-error-fallback" role="alert">
        <section>
          <h1>Lumora encountered a rendering error</h1>
          <p>{error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload Lumora
          </button>
        </section>
      </main>
    );
  }
}

function normalizeRuntimeError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  if (typeof reason === "string") {
    return new Error(reason);
  }

  try {
    return new Error(JSON.stringify(reason));
  } catch {
    return new Error(String(reason));
  }
}
