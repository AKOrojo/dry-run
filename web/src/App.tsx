// Twin UI shell (owner: Eng B). Layout and copy follow docs/design/twin-ui.md; styles live in styles/app.css.
// Flow: load AOI -> POST /api/simulate -> show frame for current clock time -> scrub timeline.
import { useEffect, useMemo, useState } from "react";
import { ApiError, AOIManifest, API, getAOI, getAOIs, getConfig, getRun, RunManifest, runFileUrl, simulate } from "./lib/api";
import { clock, useClock } from "./lib/clock";
import { Globe } from "./components/Globe";
import { AgentPanel } from "./components/AgentPanel";
import { Notice } from "./components/Notice";
import { Button, DepthLegend, fmtT, InterventionChip, ProvenanceBadge, TimelineBar } from "./components/ds";

type Failure = { message: string; retryable: boolean };
const DURATION_H = 3;

// Autoplay starts after a run loads, unless the user asked for reduced motion.
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const startClock = (m: RunManifest) => clock.set({ t_s: 0, max_s: m.frames.at(-1)?.t_s ?? 0, playing: !reducedMotion() });
const stat = (v: unknown) => (typeof v === "number" ? String(v) : "n/a");

export default function App() {
  const [aoi, setAoi] = useState<AOIManifest>();
  const [provider, setProvider] = useState("fake");
  const [judgeKeyRequired, setJudgeKeyRequired] = useState(false);
  const [ionToken, setIonToken] = useState("");
  const [buildingsUrl, setBuildingsUrl] = useState("");
  const [defaultAoi, setDefaultAoi] = useState("");
  const [aois, setAois] = useState<{ aoi_id: string; name: string }[]>([]);
  const [buildingsStatus, setBuildingsStatus] = useState("loading…");
  const [runsBase, setRunsBase] = useState("/runs");
  const [run, setRun] = useState<RunManifest>();
  const [rain, setRain] = useState(120);
  const [drains, setDrains] = useState(1.0);
  const [busy, setBusy] = useState(false);
  const [simErr, setSimErr] = useState<Failure | null>(null);
  const [replayed, setReplayed] = useState(false);
  const { t_s, playing, max_s } = useClock();

  useEffect(() => {
    getAOIs().then(setAois, () => setAois([]));
    getConfig().then((h) => { setBuildingsUrl(h.buildings_url); setDefaultAoi(h.default_aoi); setRunsBase(h.runs_base); setProvider(h.agent_provider); setJudgeKeyRequired(!!h.judge_key_required); setIonToken(h.cesium_ion_token); return getAOI(h.default_aoi); }).then(setAoi);
  }, []);

  // buildings_url is the default AOI's footprint file; other AOIs serve theirs as a layer (same id/height_m format).
  const aoiBuildingsUrl = aoi && (aoi.aoi_id === defaultAoi && buildingsUrl ? buildingsUrl
    : `${API}/api/aoi/${aoi.aoi_id}/layer/buildings_geojson`);
  const switchAoi = (id: string) => { setRun(undefined); setSimErr(null); clock.set({ t_s: 0, max_s: 0, playing: false }); getAOI(id).then(setAoi); };

  const spec = useMemo(() => drains !== 1 ? [{ type: "drain_upgrade" as const, capacity_factor: drains }] : [], [drains]);
  const go = async () => {
    setBusy(true); setSimErr(null);
    try {
      const m = await simulate({ aoi_id: aoi!.aoi_id, storm: { total_mm: rain, duration_h: DURATION_H }, interventions: spec });
      setRun(m);
      startClock(m);
    } catch (e) {
      setSimErr(e instanceof ApiError ? { message: e.message, retryable: e.retryable }
        : { message: "The server is busy. Try again.", retryable: true });
    } finally { setBusy(false); }
  };

  const frameUrl = useMemo(() => {
    if (!run?.frames.length) return undefined;
    const f = run.frames.reduce((a, b) => (Math.abs(b.t_s - t_s) < Math.abs(a.t_s - t_s) ? b : a));
    return runFileUrl(runsBase, run.run_id, f.png);
  }, [run, t_s, runsBase]);

  // Timeline markers: where the cut-edge count rises, and the frame with the largest flooded area.
  const markers = useMemo(() => {
    const ts = run?.timeseries;
    if (!ts) return [];
    const out: { tS: number; label: string }[] = [];
    ts.edges_cut.forEach((c, i) => { if (c > (i ? ts.edges_cut[i - 1] : 0)) out.push({ tS: ts.t_s[i], label: "Route cut" }); });
    if (ts.flooded_area_km2.length) out.push({ tS: ts.t_s[ts.flooded_area_km2.indexOf(Math.max(...ts.flooded_area_km2))], label: "Peak" });
    return out;
  }, [run]);
  const frameStep = run && run.frames.length > 1 ? run.frames[1].t_s - run.frames[0].t_s : undefined;

  const s = run?.stats;
  const tiles: [string, string, string][] = [
    ["Buildings flooded", stat(s?.buildings_flooded), ""],
    ["Road impassable", stat(s?.road_km_impassable), "km"],
    ["Flooded area", stat(s?.flooded_area_km2), "km²"],
    ["Max depth", stat(s?.max_depth_m), "m"],
    ["Peak time", typeof s?.peak_t_s === "number" ? fmtT(s.peak_t_s) : "n/a", ""],
  ];
  const cells = run && run.scenario.interventions?.length === spec.length ? run.intervention_cells : undefined;
  const passability = typeof s?.passability_threshold_m === "number" ? s.passability_threshold_m : undefined;
  const sources = Object.values(aoi?.sources ?? {});

  return (
    <div className="dr-app body">
      <div className="dr-map">
        {aoi && <Globe aoi={aoi} frameUrl={frameUrl} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl}
          buildingDepthsUrl={run?.building_depths ? runFileUrl(runsBase, run.run_id, run.building_depths) : undefined}
          onBuildingsStatus={setBuildingsStatus} />}
        <div className="dr-badges">
          {frameUrl && <ProvenanceBadge kind={run?.backend === "fake" ? "placeholder" : "simulated"} />}
          {aoi?.is_synthetic && <ProvenanceBadge kind="synthetic" />}
          {replayed && <ProvenanceBadge kind="synthetic">Replay</ProvenanceBadge>}
        </div>
        {run && (
          <div className="dr-bottom">
            <DepthLegend edges={run.colormap?.depth_m} passabilityM={passability} />
            <TimelineBar tS={t_s} maxS={max_s} playing={playing} markers={markers} step={frameStep}
              onToggle={() => clock.set({ playing: !playing })}
              onSeek={(t) => clock.set({ t_s: t, playing: false })} />
          </div>
        )}
      </div>
      <aside className="dr-panel">
        <header className="dr-section dr-header">
          <h1 className="title">Dry Run</h1>
          {aois.length > 1 && (
            <div className="dr-field">
              <label className="label dr-field-label" htmlFor="dr-area">Area</label>
              <select id="dr-area" value={aoi?.aoi_id} onChange={(e) => switchAoi(e.target.value)}>
                {aois.map((a) => <option key={a.aoi_id} value={a.aoi_id}>{a.name}</option>)}
              </select>
            </div>
          )}
          <span className="caption dr-muted">Buildings: {buildingsStatus}</span>
        </header>

        <section className="dr-section">
          <h2 className="label dr-section-title">Scenario</h2>
          <div className="dr-field">
            <div className="dr-field-head">
              <label className="label dr-field-label" htmlFor="dr-rain">Rain total</label>
              <span className="figure">{rain} mm / {DURATION_H} h</span>
            </div>
            <input id="dr-rain" type="range" min={20} max={250} value={rain} onChange={(e) => setRain(+e.target.value)} />
          </div>
          <div className="dr-field">
            <div className="dr-field-head">
              <label className="label dr-field-label" htmlFor="dr-drain">Drain capacity</label>
              <span className="figure">×{drains.toFixed(1)}</span>
            </div>
            <input id="dr-drain" type="range" min={0.5} max={4} step={0.1} value={drains} onChange={(e) => setDrains(+e.target.value)} />
          </div>
          {spec.length > 0 && (
            <div className="dr-row">
              {spec.map((iv, i) => <InterventionChip key={i} type={iv.type} cellsChanged={cells?.[i]} />)}
            </div>
          )}
          <Button variant="primary" disabled={busy || !aoi} onClick={go}>{busy ? "Simulating" : "Simulate"}</Button>
          {simErr && (
            <Notice message={simErr.message}>
              {simErr.retryable && <Button disabled={busy} onClick={go}>Retry</Button>}
            </Notice>
          )}
          {run && (
            <>
              <div className="dr-stats">
                {tiles.map(([label, value, unit]) => (
                  <div key={label} className="ft-stat">
                    <span className="ft-stat-label">{label}</span>
                    <span className="stat">{value}{value !== "n/a" && unit && <span className="figure dr-stat-unit"> {unit}</span>}</span>
                  </div>
                ))}
              </div>
              <span className="data dr-muted dr-id">{run.run_id}</span>
            </>
          )}
        </section>

        <section className="dr-section">
          <h2 className="label dr-section-title">Agent</h2>
          <AgentPanel defaultProvider={provider} aoiId={aoi?.aoi_id} onAoi={switchAoi} judgeKeyRequired={judgeKeyRequired}
            onReplay={setReplayed}
            onRun={(id) => getRun(id).then((m) => { setRun(m); startClock(m); })} />
        </section>

        <footer className="dr-footer caption">
          <span>Built with Muse Spark Open · © OpenStreetMap contributors · Not an operational warning system</span>
          {sources.map((c, i) => <span key={i}>{c}</span>)}
        </footer>
      </aside>
    </div>
  );
}
