import { useEffect, useState } from "react";
import DoorScreen from "./screens/DoorScreen";
import LedgerScreen from "./screens/LedgerScreen";
import StageScreen from "./screens/StageScreen";

export type Surface = "door" | "ledger" | "stage";

const fromHash = (): Surface =>
  window.location.hash === "#ledger" ? "ledger" : window.location.hash === "#stage" ? "stage" : "door";

/** Hash routing: one build, three surfaces, and the door can be the screen someone leaves open. */
export default function App() {
  const [surface, setSurface] = useState<Surface>(fromHash);

  useEffect(() => {
    const read = () => setSurface(fromHash());
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const go = (next: Surface) => {
    window.location.hash = `#${next}`;
    setSurface(next);
  };

  if (surface === "stage") return <StageScreen />;
  return surface === "ledger" ? (
    <LedgerScreen onOpenDoor={() => go("door")} />
  ) : (
    <DoorScreen />
  );
}
