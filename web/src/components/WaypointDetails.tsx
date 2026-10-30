// What a waypoint describes: where it is (place, coordinates, model ground, water, nearest building) with or
// without a run, and the depth readings once a run has finished. Shared by the selected map pin and the Inspect list.
import type { ReactNode } from "react";
import type { WaypointInfo } from "../lib/waypoints";
import { fmtT } from "./ds";
import { FIG, mono } from "./rev5";

export const coord = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
const m2 = (v: number | null | undefined) => (v == null ? "n/a" : `${v.toFixed(2)} m`);

/** "North Estate", "near North Estate", "…" while loading, or null when the AOI has no places. */
export function placeLabel(i?: WaypointInfo): string | null {
  if (!i || i.point === undefined) return "…";
  const p = i.point?.place;
  return p ? (p.inside ? p.name : `near ${p.name}`) : null;
}

export function WaypointDetails({ lon, lat, info }: { lon: number; lat: number; info?: WaypointInfo }) {
  const pt = info?.point;
  const loading = pt === undefined;
  const ser = info?.series;
  const water = pt == null ? null : pt.open_water ? "Lagoon or sea" : pt.permanent_water ? "Permanent water" : "Land";
  const rows: [string, ReactNode][] = [
    ["Place", loading ? "…" : pt?.place ? (pt.place.inside ? pt.place.name : `near ${pt.place.name} (${pt.place.distance_m} m)`) : "n/a"],
    ["Coordinates", <span style={{ fontFamily: mono, fontSize: 11 }}>{coord(lat, lon)}</span>],
    ["Ground (model)", loading ? "…" : m2(pt?.ground_m)],
    ["Water", loading ? "…" : water ?? "n/a"],
    ["Nearest building", loading ? "…" : pt?.building
      ? <><span style={{ fontFamily: mono, fontSize: 11 }}>{pt.building.id}</span>{` · ${pt.building.distance_m} m`}
        {info?.hasRun && info.building_max_m != null ? ` · max ${m2(info.building_max_m)}` : ""}</>
      : "n/a"],
  ];
  if (info?.hasRun) {
    rows.push(
      ["Depth now", m2(info.depth_m)],
      ["Run max", ser === undefined ? "…" : m2(ser?.max_depth_m)],
      ["Wet since", ser === undefined ? "…" : ser == null ? "n/a" : ser.first_flooded_s != null ? fmtT(ser.first_flooded_s) : "Never"],
      ["Impassable since", ser === undefined ? "…" : ser == null ? "n/a" : ser.first_impassable_s != null ? fmtT(ser.first_impassable_s) : "Never"],
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, lineHeight: "16px" }}>
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 12, rowGap: 2 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{k}</dt>
            <dd style={{ margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...FIG }}>{v}</dd>
          </div>
        ))}
      </dl>
      {!info?.hasRun && <span style={{ color: "var(--ink-muted)" }}>Run a simulation to see depth here</span>}
    </div>
  );
}
