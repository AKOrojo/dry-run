// "Rain now" dock side panel: the rain at the cell centre, over the whole area and fallen so far, at the model time
// the map's clouds show (the running Simulate's, or the playhead). Same list rows as the dock's other panels.
import type { ReactNode } from "react";
import { fmtT } from "./ds";
import { Band, FIG } from "./rev5";
import { useWeatherNow } from "../lib/weather";
import type { WeatherSource } from "../lib/weather";

const mm = (v: number) => `${Math.round(v)} mm/h`;

function Row({ title, value, sub, on }: { title: string; value: string; sub?: ReactNode; on?: boolean }) {
  return (
    <li style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "2px 10px", alignItems: "center", padding: "7px 12px 7px 14px",
      ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi)" } : {}) }}>
      <span style={on ? { fontWeight: 600 } : undefined}>{title}</span>
      <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{value}</span>
      {sub && <span style={{ gridColumn: "1 / -1", color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{sub}</span>}
    </li>
  );
}

export function RainNow({ src }: { src: NonNullable<WeatherSource> }) {
  const wx = useWeatherNow(src);
  const total = src.storm.total_mm;
  const k = wx?.spec.kind;
  const first = k === "cell" ? "Over the cell centre" : k === "area" ? (wx?.spec.place ? `Over ${wx.spec.place}` : "Over the drawn area") : null;
  return (
    <div data-testid="rain-now" style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
      <Band title="Rain now" />
      {!wx ? <p style={{ margin: 0, padding: 14, color: "var(--ink-muted)", fontSize: 12 }}>Waiting for the storm</p> : (
        <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
          {first && <Row on title={first} value={mm(wx.now.rate)} sub={`peak ${mm(wx.now.peak)} at ${fmtT(wx.now.peakT_s)}`} />}
          <Row on={!first} title="Over the whole area" value={mm(wx.now.areaRate)} sub={first ? undefined : `peak ${mm(wx.now.peak)} at ${fmtT(wx.now.peakT_s)}`} />
          <Row title="Fallen so far" value={`${Math.round(wx.now.fallen)} mm`} sub={`of ${Math.round(total)} mm ${k === "cell" ? "at the centre" : k === "area" ? "over the area" : "everywhere"}`} />
        </ol>
      )}
    </div>
  );
}
