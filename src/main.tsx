import "./styles/main.css";

function isFireTvLiteRuntime() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    /Android/i.test(navigator.userAgent) ||
    host === "app" ||
    (host === "localhost" && !window.location.port)
  );
}

if (isFireTvLiteRuntime()) {
  document.documentElement.classList.add("firetv-lite");
}

function showBootShell(root: HTMLElement) {
  root.replaceChildren();
  const shell = document.createElement("div");
  shell.className = "boot-shell";
  Object.assign(shell.style, {
    alignItems: "center",
    background: "#000",
    color: "#fff",
    display: "flex",
    height: "100vh",
    justifyContent: "center"
  });
  shell.textContent = "Loading Toms IPTVmate...";
  root.appendChild(shell);
}

function showBootError(root: HTMLElement, message: string) {
  root.replaceChildren();
  const shell = document.createElement("div");
  shell.className = "boot-shell";
  Object.assign(shell.style, {
    alignItems: "center",
    background: "#000",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    height: "100vh",
    justifyContent: "center",
    padding: "24px",
    textAlign: "center"
  });

  const title = document.createElement("div");
  title.textContent = "Failed to start Toms IPTVmate.";
  shell.appendChild(title);

  const detail = document.createElement("div");
  detail.textContent = message;
  Object.assign(detail.style, { color: "#ffb4b4", maxWidth: "720px" });
  shell.appendChild(detail);

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  Object.assign(reload.style, {
    background: "#1f6feb",
    border: "none",
    borderRadius: "8px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "16px",
    padding: "10px 18px"
  });
  reload.addEventListener("click", () => window.location.reload());
  shell.appendChild(reload);

  root.appendChild(shell);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

showBootShell(rootElement);

const loadApp = () => {
  void import("./AppBootstrap")
    .then(({ mountApp }) => {
      mountApp(rootElement);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error || "Failed to load app");
      console.error("[boot] failed to load AppBootstrap", error);
      showBootError(rootElement, message);
    });
};

if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => loadApp(), { timeout: 1500 });
} else {
  window.setTimeout(loadApp, 100);
}
