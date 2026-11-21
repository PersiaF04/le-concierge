import { useEffect, useState } from "react";
import DoorScreen from "./screens/DoorScreen";
import LedgerScreen from "./screens/LedgerScreen";

export type Surface = "door" | "ledger";

/** Hash routing: one build, two surfaces, and the door can be the screen someone leaves open. */
export default function App() {
  const [surface, setSurface] = useState<Surface>(() =>
    window.location.hash === "#ledger" ? "ledger" : "door",
  );

  useEffect(() => {
    const read = () => setSurface(window.location.hash === "#ledger" ? "ledger" : "door");
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const go = (next: Surface) => {
    window.location.hash = next === "ledger" ? "#ledger" : "#door";
    setSurface(next);
  };

  return surface === "ledger" ? (
    <LedgerScreen onOpenDoor={() => go("door")} />
  ) : (
    <DoorScreen onOpenLedger={() => go("ledger")} />
  );
}
