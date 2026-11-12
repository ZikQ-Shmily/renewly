import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

document.addEventListener("pointerdown", () => {
  document.documentElement.dataset.inputMode = "pointer";
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") document.documentElement.dataset.inputMode = "keyboard";
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
