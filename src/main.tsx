import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ProfileProvider } from "./profiles/ProfileContext";
import "./styles/main.css";

function normalizeRemoteKeyEvents() {
  const keepKeyboardFocus = () => {
    if (!document.body) return;
    if (!document.body.hasAttribute("tabindex")) {
      document.body.setAttribute("tabindex", "-1");
    }
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.documentElement) {
      document.body.focus();
    }
  };

  window.addEventListener("pointerdown", () => {
    window.setTimeout(keepKeyboardFocus, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      keepKeyboardFocus();
    }
  });

  keepKeyboardFocus();
}

normalizeRemoteKeyEvents();

type RootErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = {
    hasError: false,
    message: "Unexpected error"
  };

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error || "Unexpected error");
    return {
      hasError: true,
      message
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error("[root-error-boundary]", error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="root-crash-shell">
        <div className="root-crash-card">
          <h1 className="root-crash-title">Playback app crashed</h1>
          <p className="root-crash-text">
            A runtime error occurred. Use reload to recover, then share the error details for a permanent fix.
          </p>
          <pre className="root-crash-message">
{this.state.message}
          </pre>
          <button onClick={this.handleReload} className="root-crash-reload-btn">
            Reload App
          </button>
        </div>
      </div>
    );
  }
}

const app = (
  <RootErrorBoundary>
    <ProfileProvider>
      <App />
    </ProfileProvider>
  </RootErrorBoundary>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? app : <React.StrictMode>{app}</React.StrictMode>
);
