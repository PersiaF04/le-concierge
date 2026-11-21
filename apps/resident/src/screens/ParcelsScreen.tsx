import { useEffect, useState } from "react";
import { fetchParcels, formatTime, type Parcel, type Resident } from "@le-concierge/ui";

export default function ParcelsScreen({ resident }: { resident: Resident }) {
  const [parcels, setParcels] = useState<Parcel[] | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchParcels(resident.flat).then((next) => {
      if (alive) setParcels(next);
    });
    return () => {
      alive = false;
    };
  }, [resident.flat]);

  return (
    <div className="screen">
      <header className="screen-head">
        <h2>Parcels at the desk</h2>
        <p className="muted small">Read from the label by the workflow, not typed in by the courier.</p>
      </header>

      {parcels === null ? <p className="mono small muted">reading the desk…</p> : null}

      {parcels && parcels.length === 0 ? (
        <p className="muted">Nothing waiting. The desk is clear.</p>
      ) : null}

      {parcels && parcels.length > 0 ? (
        <ul className="parcel-list">
          {parcels.map((parcel) => (
            <li key={parcel.id} className="parcel">
              <div className="parcel-top">
                <span className="mono small muted">{parcel.courier}</span>
                <span className="stamp" data-status={parcel.status === "collected" ? "approved" : "pending_decision"}>
                  {parcel.status === "collected" ? "collected" : "at the desk"}
                </span>
              </div>
              <p className="parcel-label mono">{parcel.label}</p>
              <div className="record-line">
                <span>logged</span>
                <b>{formatTime(parcel.at)}</b>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="small muted">
        Collection happens at the front desk, where they can check the flat against the label. There is
        no locker to open from here yet.
      </p>
    </div>
  );
}
