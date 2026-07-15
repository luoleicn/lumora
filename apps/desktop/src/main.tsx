import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./lib/webkitPolyfills";
import App from "./App";
import { reportRuntimeError, RuntimeErrorBoundary } from "./components/RuntimeErrorBoundary";
import "./styles.css";

window.addEventListener("error", (event) => {
  reportRuntimeError("window.error", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportRuntimeError("window.unhandledrejection", event.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RuntimeErrorBoundary>
      <App />
    </RuntimeErrorBoundary>
  </StrictMode>
);
