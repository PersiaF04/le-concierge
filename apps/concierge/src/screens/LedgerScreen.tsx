import { useMemo, useState } from "react";
import {
  apiMode,
  confidenceLabel,
  distanceLabel,
  formatTime,
  recordedSpeech,
  secondsLabel,
  stampFor,
  useTheme,
  type Decision,
  type VisitStatus,
} from "@le-concierge/ui";
import { LEDGER_ROWS, loadDoorShot, matchesFilter, type Filter, type LedgerRow } from "../data";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "everything" },
  { key: "pending", label: "waiting" },
  { key: "answered", label: "answered" },
];

/** The building's system-admin view: the log, read as a log and not a dashboard. */
export default function LedgerScreen({ onOpenDoor }: { onOpenDoor: () => void }) {
  const { theme, toggle } = useTheme();
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string>(LEDGER_ROWS[0]?.id ?? "");
  const [answers, setAnswers] = useState<Record<string, Decision>>({});
  const [shot] = useState<string | null>(() => loadDoorShot());

  const rows = useMemo(() => LEDGER_ROWS.filter((row) => matchesFilter(row, filter)), [filter]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;

  const statusOf = (row: LedgerRow): VisitStatus => {
    const answer = answers[row.id];
    if (!answer) return row.status;
    return answer === "approve" ? "approved" : "declined";
  };

  const waiting = LEDGER_ROWS.filter((row) => statusOf(row) === "pending_decision").length;
  const byFace = LEDGER_ROWS.filter(
    (row) => statusOf(row) === "approved" && row.waitSeconds === 0 && (row.faceDistance ?? 1) < 0.4,
  ).length;
  const bySignature = LEDGER_ROWS.filter((row) => statusOf(row) === "approved" && row.waitSeconds > 0).length;
  const shut = LEDGER_ROWS.filter((row) => statusOf(row) === "expired" || statusOf(row) === "declined").length;

  return (
    <div className="ledger">
      <header className="bar">
        <div className="bar-id">
          <p className="mono small muted">the log · today</p>
          <p className="bar-name">Le Concierge</p>
        </div>
        <div className="bar-actions">
          <span className="mode-badge mono" data-mode={apiMode}>
            {apiMode === "live" ? "live" : "recorded run"}
          </span>
          <button
            type="button"
            className="btn-ghost mono small theme-toggle"
            onClick={toggle}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "dark" : "light"}
          </button>
          <button type="button" className="btn-quiet small" onClick={onOpenDoor}>
            <span aria-hidden="true">←</span> The door
          </button>
        </div>
      </header>

      <div className="ledger-main">
        <section className="ledger-list" aria-label="Visits">
          <div className="list-head">
            <h1>The door log</h1>
            <p className="mono small muted">
              {LEDGER_ROWS.length} entries · {waiting} waiting for a signature
            </p>
          </div>

          <div className="filters" role="group" aria-label="Filter entries">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className="filter mono small"
                aria-pressed={filter === item.key}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <table className="log-table">
            <thead>
              <tr>
                <th scope="col">time</th>
                <th scope="col">flat</th>
                <th scope="col">who</th>
                <th scope="col">outcome</th>
                <th scope="col">waited</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="log-row"
                  tabIndex={0}
                  aria-selected={selected?.id === row.id}
                  onClick={() => setSelectedId(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(row.id);
                    }
                  }}
                >
                  <td className="mono">{row.at}</td>
                  <td className="mono">{row.flat}</td>
                  <td>{row.who}</td>
                  <td>
                    <span className="stamp" data-status={statusOf(row)}>
                      {stampFor(statusOf(row))}
                    </span>
                  </td>
                  <td className="mono muted">
                    {row.waitSeconds > 0 ? secondsLabel(row.waitSeconds) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mono small totals">
            <span>{byFace} opened by face</span>
            <span>{bySignature} by signature</span>
            <span>{shut} left shut</span>
          </p>

          {rows.length === 0 ? <p className="muted empty">Nothing in this view today.</p> : null}

          <p className="small muted list-foot">
            The log is written by the workflow. This screen reads it, and answers for the resident when
            they are out.
          </p>
        </section>

        <aside className="ledger-detail" aria-label="Selected entry">
          {selected ? (
            <>
              <div className="detail-head">
                <span className="mono small muted">
                  {selected.at} · flat {selected.flat}
                </span>
                <span className="stamp" data-status={statusOf(selected)}>
                  {stampFor(statusOf(selected))}
                </span>
              </div>
              <h2>{selected.who}</h2>
              <blockquote className="detail-quote">“{selected.transcript}”</blockquote>
              <p className="detail-reply">{selected.reply}</p>

              <div className="facts">
                <div className="record-line">
                  <span>sure it is this flat</span>
                  <b>{confidenceLabel(selected.confidence)}</b>
                </div>
                <div className="record-line">
                  <span>face distance</span>
                  <b>{distanceLabel(selected.faceDistance)}</b>
                </div>
                <div className="record-line">
                  <span>waited for a signature</span>
                  <b>{selected.waitSeconds > 0 ? secondsLabel(selected.waitSeconds) : "not needed"}</b>
                </div>
                {selected.parcel ? (
                  <div className="record-line">
                    <span>parcel label</span>
                    <b className="parcel-value">{selected.parcel}</b>
                  </div>
                ) : null}
                {selected.executionId ? (
                  <div className="record-line">
                    <span>run</span>
                    <b>{selected.executionId}</b>
                  </div>
                ) : null}
                <div className="record-line">
                  <span>spoken by</span>
                  <b>
                    {recordedSpeech.model} · {recordedSpeech.transport}
                  </b>
                </div>
              </div>

              {shot && selected.status === "pending_decision" ? (
                <figure className="detail-shot">
                  <img src={shot} alt="The visitor as the door camera saw them" />
                  <figcaption className="mono small muted">the door, {formatTime(new Date())}</figcaption>
                </figure>
              ) : null}

              {selected.note ? <p className="small muted">{selected.note}</p> : null}

              {statusOf(selected) === "pending_decision" ? (
                <div className="detail-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setAnswers((current) => ({ ...current, [selected.id]: "approve" }))}
                  >
                    Open the door
                  </button>
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => setAnswers((current) => ({ ...current, [selected.id]: "decline" }))}
                  >
                    Leave it shut
                  </button>
                </div>
              ) : (
                <p className="small muted">
                  Answered. This screen cannot change a stamp once it is in the book.
                </p>
              )}
            </>
          ) : (
            <p className="muted">Pick an entry in the log.</p>
          )}
        </aside>
      </div>

      <footer className="page-foot">
        <span>Le Concierge · the building's log</span>
        <span>entries kept for 90 days · workflow visitor-arrival</span>
      </footer>
    </div>
  );
}
