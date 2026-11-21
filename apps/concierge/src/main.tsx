import React from "react";
import { createRoot } from "react-dom/client";
import "@le-concierge/ui/styles.css";
import "./app.css";
import App from "./App";

const host = document.getElementById("root");
if (!host) throw new Error("Missing #root");
createRoot(host).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
