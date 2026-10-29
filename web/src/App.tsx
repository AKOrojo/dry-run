// Day-1 skeleton (owner: Eng B). Proves the full loop against the fake backend:
// load AOI -> POST /api/simulate -> show frame for current clock time -> scrub timeline.
// Cesium globe replaces the <img> preview in Globe.tsx on Day 1-2.
import { useEffect, useMemo, useState } from "react";
import { AOIManifest, API, getAOI, getAOIs, getConfig, getRun, RunManifest, runFileUrl, simulate } from "./lib/api";
import { clock, useClock } from "./lib/clock";
import { Globe } from "./components/Globe";
import { AgentPanel } from "./components/AgentPanel";

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
  const { t_s, playing } = useClock();

  useEffect(() => {
    getAOIs().then(setAois, () => setAois([]));
    getConfig().then((h) => { setBuildingsUrl(h.buildings_url); setDefaultAoi(h.default_aoi); setRunsBase(h.runs_base); setProvider(h.agent_provider); setJudgeKeyRequired(!!h.judge_key_required); setIonToken(h.cesium_ion_token); return getAOI(h.default_aoi); }).then(setAoi);
  }, []);

  // buildings_url is the default AOI's footprint file; other AOIs serve theirs as a layer (same id/height_m format).
  const aoiBuildingsUrl = aoi && (aoi.aoi_id === defaultAoi && buildingsUrl ? buildingsUrl
    : `${API}/api/aoi/${aoi.aoi_id}/layer/buildings_geojson`);
  const switchAoi = (id: string) => { setRun(undefined); clock.set({ t_s: 0, max_s: 0, playing: false }); getAOI(id).then(setAoi); };

  const go = async () => {
    const m = await simulate({
      aoi_id: aoi!.aoi_id, storm: { total_mm: rain, duration_h: 3 },
      interventions: drains !== 1 ? [{ type: "drain_upgrade", capacity_factor: drains }] : [],
    });
    setRun(m);
    clock.set({ t_s: 0, max_s: m.frames.at(-1)?.t_s ?? 0, playing: true });
  };

  const frameUrl = useMemo(() => {
    if (!run?.frames.length) return undefined;
    const f = run.frames.reduce((a, b) => (Math.abs(b.t_s - t_s) < Math.abs(a.t_s - t_s) ? b : a));
    return runFileUrl(runsBase, run.run_id, f.png);
  }, [run, t_s, runsBase]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <div style={{ position: "relative" }}>
        {aoi && <Globe aoi={aoi} frameUrl={frameUrl} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl}
          buildingDepthsUrl={run?.building_depths ? runFileUrl(runsBase, run.run_id, run.building_depths) : undefined}
          onBuildingsStatus={setBuildingsStatus} />}
        {run?.backend === "fake" && <div className="badge" style={{ position: "absolute", top: 8, left: 8, background: "#b45309", color: "#fff", padding: "2px 8px" }}>PLACEHOLDER PHYSICS</div>}
        {aoi?.is_synthetic && <div style={{ position: "absolute", top: 8, right: 8, background: "#444", color: "#fff", padding: "2px 8px" }}>SYNTHETIC TERRAIN</div>}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 12, background: "rgba(0,0,0,.6)", color: "#fff" }}>
          <button onClick={() => clock.set({ playing: !playing })}>{playing ? "Pause" : "Play"}</button>{" "}
          <input type="range" min={0} max={clock.get().max_s} value={t_s} style={{ width: "70%" }}
            onChange={(e) => clock.set({ t_s: +e.target.value, playing: false })} />{" "}
          <span className="num" style={{ fontFamily: "var(--font-mono)" }}>T+{(t_s / 3600).toFixed(2)} h</span>
        </div>
      </div>
      <aside style={{ padding: 12, overflow: "auto", borderLeft: "1px solid #ddd" }}>
        <h3>Scenario</h3>
        {aois.length > 1 && <label>Area: <select value={aoi?.aoi_id} onChange={(e) => switchAoi(e.target.value)}>
          {aois.map((a) => <option key={a.aoi_id} value={a.aoi_id}>{a.name}</option>)}
        </select></label>}
        <div style={{ fontSize: 12, marginBottom: 8 }}>Buildings: {buildingsStatus}</div>
        <label>Rain (mm / 3 h): {rain} <input type="range" min={20} max={250} value={rain} onChange={(e) => setRain(+e.target.value)} /></label><br />
        <label>Drain capacity: x{drains.toFixed(1)} <input type="range" min={0.5} max={4} step={0.1} value={drains} onChange={(e) => setDrains(+e.target.value)} /></label><br />
        <button onClick={go}>Simulate</button>
        {run?.stats && <pre className="num" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{JSON.stringify(run.stats, null, 1)}</pre>}
        <AgentPanel defaultProvider={provider} aoiId={aoi?.aoi_id} judgeKeyRequired={judgeKeyRequired} onRun={(id) => getRun(id).then((m) => { setRun(m); clock.set({ t_s: 0, max_s: m.frames.at(-1)?.t_s ?? 0, playing: true }); })} />
        <footer style={{ fontSize: 11, marginTop: 16, opacity: 0.7 }}>
          Built with Muse Spark Open · © OpenStreetMap contributors · Not an operational warning system
        </footer>
      </aside>
    </div>
  );
}
