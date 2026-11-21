import { useEffect, useState } from "react";
import { fetchParcels, formatTime, type Parcel, type Resident } from "@le-concierge/ui";

/** Parcels at the desk for this flat: who brought them, and when. */
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
      </header>

      {parcels === null ? <p className="mono small muted">reading the desk…</p> : null}

      {parcels && parcels.length === 0 ? <p className="muted">Nothing waiting.</p> : null}

      {parcels && parcels.length > 0 ? (
        <ul className="parcel-list">
          {parcels.map((parcel) => (
            <li key={parcel.id} className="parcel">
              <div className="record-line">
                <span>{parcel.courier || "a courier"}</span>
                <b>{formatTime(parcel.at)}</b>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
