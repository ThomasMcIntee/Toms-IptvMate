import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ProfileProvider } from "./profiles/ProfileContext";
import "./styles/main.css";

const app = (
  <ProfileProvider>
    <App />
  </ProfileProvider>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? app : <React.StrictMode>{app}</React.StrictMode>
);
