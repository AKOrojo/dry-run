// Twin UI shell (rev 5 frame). Top bar, map + dock on the left, sidebar on the right.
// Flow: load AOI -> POST /api/simulate -> show frame for current clock time -> scrub timeline.
import { useEffect, useMemo, useState } from "react";
import { ApiError, AOIManifest, API, getAOI, getAOIs, getBoundary, getConfig, getInflows, getRun, getRunEvents, Intervention, RunManifest, runFileUrl, simulate } from "./lib/api";
import { clock, useClock } from "./lib/clock";
import { setExtras } from "./lib/extras";
import { usePinnedSeries } from "./lib/inspect";
import { mapImage, readSharedView, setView, sharedViewUrl, useView } from "./lib/view";
import { MapStage } from "./components/MapStage";
import { AgentPanel } from "./components/AgentPanel";
import { fmtT, ProvenanceBadge } from "./components/ds";
import { Dock } from "./components/Dock";
import { Failure, Pattern, Sidebar } from "./components/Sidebar";
import { Mode, TopBar } from "./components/TopBar";
import { Tour, tourDisabled, tourDone } from "./components/Tour";

// Autoplay starts after a run loads, unless the user asked for reduced motion.
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const startClock = (m: RunManifest) => clock.set({ t_s: 0, max_s: m.frames.at(-1)?.t_s ?? 0, playing: !reducedMotion() });
// A shared link (?aoi=&run=&t=) opens on that area, run and time, paused.
const shared = readSharedView();

export default function App() {
  const [aoi, setAoi] = useState<AOIManifest>();
  const [provider, setProvider] = useState("fake");
  const [judgeKeyRequired, setJudgeKeyRequired] = useState(false);
  const [ionToken, setIonToken] = useState("");
  const [buildingsUrl, setBuildingsUrl] = useState("");
  const [defaultAoi, setDefaultAoi] = useState("");
  const [aois, setAois] = useState<{ aoi_id: string; name: string }[]>([]);
  const [runsBase, setRunsBase] = useState("/runs");
  const [run, setRun] = useState<RunManifest>();
  const [rain, setRain] = useState(120);
  const [durationH, setDurationH] = useState(3);
  const [pattern, setPattern] = useState<Pattern>("uniform");
  const [level, setLevel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [simErr, setSimErr] = useState<Failure | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [mode, setMode] = useState<Mode>("Scenario");
  const [agentRuns, setAgentRuns] = useState(0);
  const [tour, setTour] = useState(false);
  const { t_s } = useClock();
  const view = useView();
  const pinSeries = usePinnedSeries();
  const aoiId = aoi?.aoi_id;
  const runId = run?.status === "done" ? run.run_id : undefined;

  // First visit only; ?notour=1 keeps it off in automated runs. The delay lets the layout settle.
  useEffect(() => {
    if (tourDisabled() || tourDone()) return;
    const id = window.setTimeout(() => setTour(true), 1000);
    return () => window.clearTimeout(id);
  }, []);

  // Read-only rev 5 data. A missing endpoint (404) just leaves the matching feature off.
  useEffect(() => {
    setExtras({ boundary: null, inflows: null });
    if (!aoiId) return;
    let cancelled = false;
    getBoundary(aoiId).then((b) => { if (!cancelled) setExtras({ boundary: b?.features?.length ? b : null }); });
    getInflows(aoiId).then((f) => { if (!cancelled) setExtras({ inflows: f?.features?.length ? f : null }); });
    return () => { cancelled = true; };
  }, [aoiId]);
  useEffect(() => {
    setExtras({ events: null });
    if (!runId) return;
    let cancelled = false;
    getRunEvents(runId).then((e) => { if (!cancelled) setExtras({ events: e }); });
    return () => { cancelled = true; };
  }, [runId]);

  useEffect(() => {
    getAOIs().then(setAois, () => setAois([]));
    getConfig().then(async (h) => {
      setBuildingsUrl(h.buildings_url); setDefaultAoi(h.default_aoi); setRunsBase(h.runs_base); setProvider(h.agent_provider); setJudgeKeyRequired(!!h.judge_key_required); setIonToken(h.cesium_ion_token);
      const m = shared.run ? await getRun(shared.run).catch(() => undefined) : undefined;
      const want = m?.scenario.aoi_id ?? shared.aoi ?? h.default_aoi;
      const a = await getAOI(want).catch(() => getAOI(h.default_aoi));
      setAoi(a);
      if (m?.status === "done" && m.scenario.aoi_id === a.aoi_id) {
        const max_s = m.frames.at(-1)?.t_s ?? 0;
        setRun(m);
        clock.set({ t_s: Math.min(shared.t ?? 0, max_s), max_s, playing: false });
      }
    });
  }, []);

  // buildings_url is the default AOI's footprint file; other AOIs serve theirs as a layer (same id/height_m format).
  const aoiBuildingsUrl = aoi && (aoi.aoi_id === defaultAoi && buildingsUrl ? buildingsUrl
    : `${API}/api/aoi/${aoi.aoi_id}/layer/buildings_geojson`);
  const switchAoi = (id: string) => { setRun(undefined); setSimErr(null); setLevel(null); clock.set({ t_s: 0, max_s: 0, playing: false }); getAOI(id).then(setAoi); };

  const copyLink = async () => {
    const url = sharedViewUrl({ aoi: aoi?.aoi_id, run: runId, t: t_s });
    window.history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); return "Link copied"; }
    catch { return "Copy blocked: the link is in the address bar"; }
  };
  const saveImage = () => {
    let png: string | null = null;
    try { png = mapImage(); } catch { /* a tainted canvas or lost context */ }
    if (!png) return "The map image is not available";
    const a = document.createElement("a");
    a.href = png;
    a.download = `dryrun-${aoi?.aoi_id ?? "map"}-${fmtT(t_s).replace(/[^0-9T]/g, "")}.png`;
    a.click();
    return "Image saved";
  };

  const go = async () => {
    setBusy(true); setSimErr(null);
    const interventions: Intervention[] = level == null ? [] : [{ type: "tide", boundary_level_m: level }];
    try {
      const m = await simulate({ aoi_id: aoi!.aoi_id, storm: { total_mm: rain, duration_h: durationH, pattern }, interventions });
      setRun(m);
      startClock(m);
    } catch (e) {
      setSimErr(e instanceof ApiError ? { message: e.message, retryable: e.retryable }
        : { message: "The server is busy. Try again.", retryable: true });
    } finally { setBusy(false); }
  };

  // Every frame of the run, preloaded by the map; the clock only picks which one shows.
  const frames = useMemo(() => run?.frames.map((f) => ({ t_s: f.t_s, url: runFileUrl(runsBase, run.run_id, f.png) })),
    [run, runsBase]);

  const sources = Object.values(aoi?.sources ?? {});
  // Tide only applies to coastal areas: an AOI with river inflows is inland.
  const coastal = !Object.keys(aoi?.layers ?? {}).some((k) => k.includes("inflows"));

  return (
    <div className={`dr-app body${view.sidebar ? "" : " no-sidebar"}${view.timeline ? "" : " no-timeline"}`}>
      <TopBar aois={aois} aoiId={aoi?.aoi_id} onAoi={switchAoi} rainMm={rain} durationH={durationH} pattern={pattern}
        mode={mode} onMode={(m) => { setMode(m); setView({ sidebar: true }); }} agentRuns={agentRuns} onTour={() => setTour(true)}
        onCopyLink={copyLink} onSaveImage={saveImage} />
      <div className="dr-main">
        <div className="dr-map" data-tour="map">
          {aoi && <MapStage aoi={aoi} run={run} frames={frames} tS={t_s} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl} runsBase={runsBase} />}
          <div className="dr-badges">
            {aoi?.is_synthetic && <ProvenanceBadge kind="synthetic" />}
            {replayed && <ProvenanceBadge kind="synthetic">Replay</ProvenanceBadge>}
          </div>
        </div>
        {view.timeline && <Dock run={run} series={pinSeries ?? undefined} />}
      </div>
      {!view.sidebar ? null : mode === "Agent" ? (
        <aside className="dr-panel">
          <section className="dr-section">
            <h2 className="label dr-section-title">Agent</h2>
            <AgentPanel defaultProvider={provider} aoiId={aoi?.aoi_id} onAoi={switchAoi} judgeKeyRequired={judgeKeyRequired}
              onReplay={setReplayed}
              onRun={(id) => { setAgentRuns((n) => n + 1); getRun(id).then((m) => { setRun(m); startClock(m); }); }} />
          </section>
        </aside>
      ) : (
        <Sidebar aoi={aoi} run={run} sources={sources} scenario={{
          rain, onRain: setRain, durationH, onDuration: setDurationH, pattern, onPattern: setPattern, level, onLevel: setLevel,
          coastal, busy, canRun: !!aoi, onSimulate: go, err: simErr,
        }} />
      )}
      {tour && <Tour onClose={() => setTour(false)} />}
    </div>
  );
}
