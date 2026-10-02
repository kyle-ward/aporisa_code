import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadBridge } from "./bridge.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
loadBridge().then(
  (bridge) =>
    root.render(
      <StrictMode>
        <App bridge={bridge} />
      </StrictMode>,
    ),
  (error: unknown) => root.render(<pre className="fatal">{String(error)}</pre>),
);
