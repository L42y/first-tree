import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { installAskAgentNavGuard } from "./components/chat/ask-agent-nav-lock.js";
import { captureReactRootError, initWebSentry } from "./observability/sentry.js";
import "./index.css";

initWebSentry();

// The singleton browser-history guard must register its popstate listener
// BEFORE React Router's history listener exists (i.e. before the root
// renders): at the window target, popstate listeners run in registration
// order, so only the earliest listener can intercept a locked Back/Forward
// before the router commits the exit. See `ask-agent-nav-lock.ts`.
installAskAgentNavGuard();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root, {
  onCaughtError: captureReactRootError,
  onRecoverableError: captureReactRootError,
  onUncaughtError: captureReactRootError,
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
