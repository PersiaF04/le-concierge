import React from "react";
import { createRoot } from "react-dom/client";
import "@le-concierge/ui/styles.css";
import "./app.css";

/**
 * The resident's phone only talks to the API it was built with. A `?api=` link,
 * or one an older build remembered in localStorage, would otherwise point the
 * phone at another server, so both are dropped before the API module loads.
 */
function dropApiOverride() {
  try {
    window.localStorage.removeItem("le-concierge:api");
    const url = new URL(window.location.href);
    if (url.searchParams.has("api")) {
      url.searchParams.delete("api");
      window.history.replaceState(null, "", url);
    }
  } catch {
    /* storage or history may be blocked; nothing was remembered then */
  }
}

dropApiOverride();

const host = document.getElementById("root");
if (!host) throw new Error("Missing #root");
const root = host;

// Imported after the override is gone: the API module reads its address on load.
void import("./App").then(({ default: App }) => {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
