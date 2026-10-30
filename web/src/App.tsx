// Twin UI shell (rev 5 frame). Top bar, map + dock on the left, sidebar on the right.
// Flow: load AOI -> POST /api/simulate -> show frame for current clock time -> scrub timeline.
import { useEffect, useMemo, useState } from "react";
import { AgentEvent, ApiError, AOIManifest, API, getAOI, getAOIs, getBoundary, getConfig, getInflows, getRun, getRunEvents, Intervention, RunManifest, runFileUrl, simulate } from "./lib/api";
import { clock, useClock } from "./lib/clock";
import { setExtras } from "./lib/extras";
import { usePinnedSeries } from "./lib/inspect";
import { mapImage, readSharedView, setView, sharedViewUrl, useView } from "./lib/view";
import { MapStage } from "./components/MapStage";
import { AgentPanel } from "./components/AgentPanel";
import type * as Cesium from "cesium";
import { BuildingDock, BuildingOnMap, Graticule, HowToInspectCard, loadSelected, PlaceCard, SelectedBuildingCard } from "./components/PlanView";
import type { Selected } from "./components/PlanView";
import * as CesiumNS from "cesium";
import { AgentDock, AgentMapOverlay, BriefPlaceBars, deriveSession, RunsCard, usePlaceStat } from "./components/AgentMode";
import { ByPlace, CompareCard, CompareMapOverlay, CompareView, DeltaCard, SideGlobe, WaterBudgetCard, WhatChanges } from "./components/Compare";
import { byPlace, diffFrame, PlaceRow, whatChanges } from "./lib/compare";
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
const isBaseline = (m: RunManifest) => !m.scenario.interventions?.length;
const sameStorm = (x: RunManifest, y: RunManifest) =>
  JSON.stringify([x.scenario.storm, x.scenario.sim_hours]) === JSON.stringify([y.scenario.storm, y.scenario.sim_hours]);

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
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentShown, setAgentShown] = useState<{ id: string; picked: boolean }>();
  const [tour, setTour] = useState(false);
  // Finished runs this session (Scenario and Agent), newest first: the Compare choices.
  const [runs, setRuns] = useState<RunManifest[]>([]);
  const [cmp, setCmp] = useState<{ a?: string; b?: string }>({});
  const [cmpView, setCmpView] = useState<CompareView>("Swipe");
  const [split, setSplit] = useState(0.5);
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [mainViewer, setMainViewer] = useState<Cesium.Viewer>();
  const [baseBusy, setBaseBusy] = useState(false);
  const addRun = (m: RunManifest) => { if (m.status === "done") setRuns((p) => [m, ...p.filter((r) => r.run_id !== m.run_id)]); };
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
  const switchAoi = (id: string) => { setPick({}); setRun(undefined); setSimErr(null); setLevel(null); clock.set({ t_s: 0, max_s: 0, playing: false }); getAOI(id).then(setAoi); };

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
      addRun(m);
      startClock(m);
    } catch (e) {
      setSimErr(e instanceof ApiError ? { message: e.message, retryable: e.retryable }
        : { message: "The server is busy. Try again.", retryable: true });
    } finally { setBusy(false); }
  };

  // ---- Agent mode: the session's runs in the order the planner made them.
  const session = useMemo(() => deriveSession(agentEvents), [agentEvents]);
  const agentList = useMemo(() => session.runIds.map((id) => runs.find((r) => r.run_id === id)).filter((m): m is RunManifest => !!m), [session, runs]);
  const placeVals = usePlaceStat(session.place, session.runIds);
  const showAgentRun = (m: RunManifest) => { setRun(m); startClock(m); setAgentShown({ id: m.run_id, picked: true }); };
  const agentView = mode === "Agent" && agentList.length > 0;


  // ---- Compare: A defaults to the baseline of B's storm, B to the newest run that is not a baseline.
  const here = useMemo(() => runs.filter((r) => r.scenario.aoi_id === aoiId), [runs, aoiId]);
  const comparing = mode === "Compare";
  useEffect(() => {
    if (!comparing || !here.length || baseBusy) return;
    const latest = here.find((r) => !isBaseline(r)) ?? here[0];
    if (isBaseline(latest) || here.some((r) => isBaseline(r) && sameStorm(r, latest))) return;
    // Its baseline is usually a cache hit (the warmed presets); runs are content-addressed, so this is idempotent.
    setBaseBusy(true);
    simulate({ ...latest.scenario, interventions: [], label: null }).then(addRun, () => { /* compare what exists */ }).finally(() => setBaseBusy(false));
  }, [comparing, here]);
  useEffect(() => {
    if (!comparing) return;
    const has = (id?: string) => here.some((r) => r.run_id === id);
    if (has(cmp.a) && has(cmp.b)) return;
    const b = here.find((r) => !isBaseline(r)) ?? here[0];
    const a = b && (here.find((r) => r !== b && isBaseline(r) && sameStorm(r, b)) ?? here.find((r) => r !== b));
    if (a?.run_id !== cmp.a || b?.run_id !== cmp.b) setCmp({ a: a?.run_id, b: b?.run_id });
  }, [comparing, here, cmp]);
  const aRun = here.find((r) => r.run_id === cmp.a), bRun = here.find((r) => r.run_id === cmp.b);
  const pair = comparing && aRun && bRun && aRun !== bRun ? { a: aRun, b: bRun } : undefined;
  useEffect(() => { if (pair) clock.set({ max_s: pair.b.frames.at(-1)?.t_s ?? 0 }); }, [pair?.b.run_id]);
  // Side by side: A on the left map, B on the right one. A single run view shows that run; the others show B's buildings.
  const mapRun = pair ? (cmpView === "A" || cmpView === "Side by side" ? pair.a : pair.b) : run;
  const framesOf = (m?: RunManifest) => m?.frames.map((f) => ({ t_s: f.t_s, url: runFileUrl(runsBase, m.run_id, f.png) }));
  const origin = (m: RunManifest) => (agentIds.has(m.run_id) ? "made by the agent" : isBaseline(m) ? "no interventions" : "made in Scenario");
  const [places, setPlaces] = useState<PlaceRow[] | null>(null);
  useEffect(() => {
    setPlaces(null);
    if (!pair || !aoiId) return;
    let off = false;
    byPlace(aoiId, pair.a.run_id, pair.b.run_id).then((r) => { if (!off) setPlaces(r); }, () => { if (!off) setPlaces([]); });
    return () => { off = true; };
  }, [aoiId, pair?.a.run_id, pair?.b.run_id]);
  const changes = useMemo(() => (pair ? whatChanges(pair.a, pair.b) : []), [pair?.a.run_id, pair?.b.run_id]);
  const activeChange = changes.reduce((k, c, i) => (c.tB != null && c.tB <= t_s && (k < 0 || c.tB >= (changes[k].tB ?? 0)) ? i : k), -1);
  // Difference: one B-minus-A frame for the frame under the playhead, drawn in the browser.
  const diffT = pair && cmpView === "Difference" ? pair.b.frames.reduce((best, f) => (Math.abs(f.t_s - t_s) < Math.abs(best - t_s) ? f.t_s : best), 0) : null;
  const [diff, setDiff] = useState<{ t_s: number; url: string }[]>();
  useEffect(() => {
    if (!pair || diffT == null) { setDiff(undefined); return; }
    let off = false;
    diffFrame(runsBase, pair.a, pair.b, diffT).then((url) => { if (!off) setDiff([{ t_s: diffT, url }]); }, () => { /* keep the last difference frame */ });
    return () => { off = true; };
  }, [pair?.a.run_id, pair?.b.run_id, diffT, runsBase]);

  // Every frame of the run, preloaded by the map; the clock only picks which one shows.
  const frames = useMemo(() => (pair && cmpView === "Difference" ? diff : pair && cmpView === "Swipe" ? framesOf(pair.a) : framesOf(mapRun)),
    [mapRun, runsBase, pair?.a.run_id, cmpView, diff]);
  const framesB = useMemo(() => (pair && cmpView === "Swipe" ? framesOf(pair.b) : undefined), [pair?.b.run_id, cmpView, runsBase]);
  const side = !!pair && cmpView === "Side by side";

  // ---- Plan view: click a building (shift: a second one to compare); ?building=<id> selects one on load.
  const [plan, setPlan] = useState(false);
  const [pick, setPick] = useState<{ id?: string; id2?: string; fly?: boolean }>(() => {
    try { const id = new URLSearchParams(window.location.search).get("building") ?? undefined; return { id, fly: !!id }; } catch { return {}; }
  });
  const [sel, setSel] = useState<Selected | null>(null);
  const [sel2, setSel2] = useState<Selected | null>(null);
  const flyTo = (s: Selected) => mainViewer?.camera.flyTo({ destination: CesiumNS.Cartesian3.fromDegrees(s.b.lon, s.b.lat, 600),
    orientation: { heading: 0, pitch: -CesiumNS.Math.PI_OVER_TWO, roll: 0 }, duration: 1.2 });
  useEffect(() => {
    if (!pick.id || !aoi || !aoiBuildingsUrl) { setSel(null); return; }
    let off = false;
    loadSelected(pick.id, aoi, aoiBuildingsUrl, mapRun, runsBase).then((s) => { if (!off) setSel(s); }, () => { if (!off) setSel(null); });
    return () => { off = true; };
  }, [pick.id, aoi?.aoi_id, aoiBuildingsUrl, mapRun?.run_id, runsBase]);
  useEffect(() => {
    if (!pick.id2 || !aoi || !aoiBuildingsUrl) { setSel2(null); return; }
    let off = false;
    loadSelected(pick.id2, aoi, aoiBuildingsUrl, mapRun, runsBase).then((s) => { if (!off) setSel2(s); }, () => { if (!off) setSel2(null); });
    return () => { off = true; };
  }, [pick.id2, aoi?.aoi_id, aoiBuildingsUrl, mapRun?.run_id, runsBase]);
  useEffect(() => { if (sel && pick.fly && mainViewer) { flyTo(sel); setPick((p) => ({ ...p, fly: false })); } }, [sel, mainViewer]);
  const onBuilding = (id: string, shift: boolean) => setPick((p) => (shift && p.id && p.id !== id ? { ...p, id2: id } : { id }));
  const buildingView = !!sel && !pair && !agentView;

  const sources = Object.values(aoi?.sources ?? {});
  // Tide only applies to coastal areas: an AOI with river inflows is inland.
  const coastal = !Object.keys(aoi?.layers ?? {}).some((k) => k.includes("inflows"));

  return (
    <div className={`dr-app body${view.sidebar ? "" : " no-sidebar"}${view.timeline ? "" : " no-timeline"}`}>
      <TopBar aois={aois} aoiId={aoi?.aoi_id} onAoi={switchAoi} rainMm={rain} durationH={durationH} pattern={pattern}
        mode={mode} onMode={(m) => { setMode(m); setView({ sidebar: true }); }} agentRuns={session.runIds.length} onTour={() => setTour(true)}
        onCopyLink={copyLink} onSaveImage={saveImage} />
      <div className="dr-main">
        <div className="dr-map" data-tour="map">
          <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: side ? "50%" : 0 }}>
            {aoi && <MapStage aoi={aoi} run={mapRun} frames={frames} framesB={framesB} split={pair && cmpView === "Swipe" ? split : undefined} onViewer={setMainViewer} onBuilding={onBuilding} onView={(v) => setPlan(v === "Plan")}
              tS={t_s} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl} runsBase={runsBase} />}
          </div>
          {side && aoi && pair && (
            <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", right: 0 }}>
              <SideGlobe aoi={aoi} run={pair.b} frames={framesOf(pair.b)} tS={t_s} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl} runsBase={runsBase} leader={mainViewer} />
            </div>
          )}
          {plan && !side && <Graticule viewer={mainViewer} />}
          {sel && !side && <BuildingOnMap viewer={mainViewer} sel={sel} second={sel2} />}
          {agentView && <AgentMapOverlay runs={agentList} shown={run?.run_id} picked={agentShown?.id === run?.run_id && !!agentShown?.picked} onShow={showAgentRun} />}
          {pair && <CompareMapOverlay a={pair.a} b={pair.b} origin={origin} view={cmpView} onView={setCmpView} split={split} onSplit={setSplit} />}
          <div className="dr-badges">
            {aoi?.is_synthetic && <ProvenanceBadge kind="synthetic" />}
            {replayed && <ProvenanceBadge kind="synthetic">Replay</ProvenanceBadge>}
          </div>
        </div>
        {view.timeline && (buildingView ? <BuildingDock sel={sel!} second={sel2} /> : agentView ? <AgentDock runs={agentList} session={session} placeVals={placeVals} shown={run?.run_id} onShow={showAgentRun} /> : <Dock run={pair ? pair.b : run} ghost={pair?.a} series={pinSeries ?? undefined}
          third={pair ? <ByPlace rows={places} /> : undefined} side={pair ? <WhatChanges changes={changes} active={activeChange} /> : undefined}
          note={pair ? "One clock drives A and B" : undefined} />)}
      </div>
      {/* The sidebar stays mounted while View hides it, so a running agent session keeps streaming. */}
      <div style={{ display: view.sidebar ? "contents" : "none" }}>
      <Sidebar aoi={aoi} run={mapRun} sources={sources} inspectFocus={pick.id}
          inspect={sel ? <><SelectedBuildingCard sel={sel} second={sel2} onFly={() => flyTo(sel)} onClear={() => setPick({})} />
            {sel.place && <PlaceCard place={sel.place} runId={mapRun?.status === "done" ? mapRun.run_id : undefined} />}<HowToInspectCard /></> : undefined}
          inspectAfter={plan ? <HowToInspectCard /> : undefined} onScenario={() => setMode("Scenario")} agentMode={mode === "Agent"} agent={
          <>
            {agentList.length > 0 && <RunsCard runs={agentList} shown={run?.run_id} recommended={session.recommended} onShow={showAgentRun} />}
            <AgentPanel defaultProvider={provider} aoiId={aoi?.aoi_id} onAoi={switchAoi} judgeKeyRequired={judgeKeyRequired} onReplay={setReplayed} onEvents={setAgentEvents}
              briefExtra={session.place && agentList.length > 1 ? <BriefPlaceBars place={session.place} runs={agentList} vals={placeVals} session={session} shown={run?.run_id} onShow={showAgentRun} /> : undefined}
              onRun={(id) => { setAgentIds((p) => new Set(p).add(id)); getRun(id).then((m) => { setRun(m); addRun(m); startClock(m); setAgentShown((s) => (s?.id === id ? s : { id, picked: false })); }); }} />
          </>
        } compare={comparing ? (
          <>
            <CompareCard runs={here} a={cmp.a} b={cmp.b} busy={baseBusy} onScenario={() => setMode("Scenario")}
              onA={(a) => setCmp((c) => ({ ...c, a }))} onB={(b) => setCmp((c) => ({ ...c, b }))} onSwap={() => setCmp((c) => ({ a: c.b, b: c.a }))} />
            {pair && <><DeltaCard a={pair.a} b={pair.b} /><WaterBudgetCard a={pair.a} b={pair.b} /></>}
          </>
        ) : undefined} scenario={{
          rain, onRain: setRain, durationH, onDuration: setDurationH, pattern, onPattern: setPattern, level, onLevel: setLevel,
          coastal, busy, canRun: !!aoi, onSimulate: go, err: simErr,
        }} />
      </div>
      {tour && <Tour onClose={() => setTour(false)} />}
    </div>
  );
}
