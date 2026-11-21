import { useEffect, useState } from "react";
import { useTheme, type Resident } from "@le-concierge/ui";
import { loadResident, saveResident } from "./storage";
import SetupScreen from "./screens/SetupScreen";
import VisitScreen from "./screens/VisitScreen";
import ParcelsScreen from "./screens/ParcelsScreen";
import MeScreen from "./screens/MeScreen";

type Tab = "visit" | "parcels" | "me";

const TABS: Tab[] = ["visit", "parcels", "me"];

export default function App() {
  const { theme, toggle } = useTheme();
  const [resident, setResident] = useState<Resident | null>(() => loadResident());
  const [tab, setTab] = useState<Tab>("visit");

  useEffect(() => saveResident(resident), [resident]);
  useEffect(() => {
    document.title = resident ? `Le Concierge — flat ${resident.flat}` : "Le Concierge";
  }, [resident]);

  return (
    <div className="shell">
      <div className="phone">
        <header className="phone-head">
          <div className="phone-id">
            <p className="mono small muted">{resident ? `FLAT ${resident.flat}` : "NO FLAT YET"}</p>
            <p className="phone-name">{resident?.name?.trim() || "Le Concierge"}</p>
          </div>
          <div className="phone-head-actions">
            <button
              type="button"
              className="btn-ghost mono small theme-toggle"
              onClick={toggle}
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? "dark" : "light"}
            </button>
          </div>
        </header>

        <main className="phone-body">
          {!resident ? (
            <SetupScreen onDone={setResident} />
          ) : tab === "visit" ? (
            <VisitScreen key={resident.flat} resident={resident} />
          ) : tab === "parcels" ? (
            <ParcelsScreen key={resident.flat} resident={resident} />
          ) : (
            <MeScreen resident={resident} onUpdate={setResident} onForget={() => setResident(null)} />
          )}
        </main>

        {resident ? (
          <nav className="phone-tabs" aria-label="Sections">
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                className="tab mono"
                aria-current={tab === name ? "page" : undefined}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
