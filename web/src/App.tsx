// Twin UI shell (rev 5 frame). Top bar, map + dock on the left, sidebar on the right.
// Flow: load AOI -> POST /api/simulate -> show frame for current clock time -> scrub timeline.
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentEvent, ApiError, AOIManifest, API, getAOI, getAOIs, getBoundary, getConfig, getInflows, getRun, getRunEvents, Intervention, RunManifest, runFileUrl, simulate, estimateSim, simulateStream, cancelSim } from "./lib/api";
import type { ScenarioSpec, SimEstimate, SimProgress } from "./lib/api";
import { getPresets } from "./lib/api";
import { clock, useClock } from "./lib/clock";
import { setExtras } from "./lib/extras";
import { usePinnedSeries } from "./lib/inspect";
import { resolveLink } from "./lib/link";
import { mapImage, readSharedView, setView, sharedViewUrl, useView } from "./lib/view";
import { MapStage } from "./components/MapStage";
import { AgentPanel } from "./components/AgentPanel";
import type * as Cesium from "cesium";
import { BuildingDock, BuildingOnMap, Graticule, HowToInspectCard, loadSelected, PlaceCard, SelectedBuildingCard } from "./components/PlanView";
import type { Selected } from "./components/PlanView";
import * as CesiumNS from "cesium";
import { AgentDock, AgentMapOverlay, BriefPlaceBars, deriveSession, RunsCard, usePlaceStat } from "./components/AgentMode";
import type { CompareView } from "./components/Compare";
import { lazyNamed } from "./lib/lazy";
const ByPlace = lazyNamed(() => import("./components/Compare"), "ByPlace");
const CompareCard = lazyNamed(() => import("./components/Compare"), "CompareCard");
const CompareMapOverlay = lazyNamed(() => import("./components/Compare"), "CompareMapOverlay");
const DeltaCard = lazyNamed(() => import("./components/Compare"), "DeltaCard");
const SideGlobe = lazyNamed(() => import("./components/Compare"), "SideGlobe");
const WaterBudgetCard = lazyNamed(() => import("./components/Compare"), "WaterBudgetCard");
const WhatChanges = lazyNamed(() => import("./components/Compare"), "WhatChanges");
import { byPlace, diffFrame, PlaceRow, whatChanges } from "./lib/compare";
import { fmtT, ProvenanceBadge } from "./components/ds";
import { Dock } from "./components/Dock";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Failure, Pattern, Sidebar } from "./components/Sidebar";
import type { SimBar } from "./components/Sidebar";
import { Mode, TopBar } from "./components/TopBar";
import { buildStorm, rainSummary, initRain, rain as rainStore, setRain as patchRain, domainSwitchVisible, spatialOf, stormKey, useRain, useRainPreview } from "./lib/rain";
import type { RainState } from "./lib/rain";
import { setGoogleAvailable, useLayers } from "./lib/layers";
import { tourDisabled, tourDone } from "./lib/tour";
const Tour = lazyNamed(() => import("./components/Tour"), "Tour");
const CloseUpCards = lazyNamed(() => import("./components/CloseUp"), "CloseUpCards");
const CloseUpDock = lazyNamed(() => import("./components/CloseUp"), "CloseUpDock");
import { useCloseUp } from "./lib/patch3d";
import type { Spatial } from "./lib/api";
import { resetSim, setSim } from "./lib/simstate";
import { beforeRun, GIVE_UP_MS, WAKING_MS } from "./lib/simbar";
import type { EstWait } from "./lib/simbar";
import { adoptDrainage, drainageSpec, resetDrainage, useDrainage } from "./lib/drainage";

// Autoplay starts after a run loads, unless the user asked for reduced motion.
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
/** An area's baseline preset: whole-area rain, no interventions (warmed on the server, so its run is cached). */
const isBase = (p: ScenarioSpec) => !p.interventions?.length && !p.storm.spatial && p.storm.total_mm > 0;
const startClock = (m: RunManifest) => clock.set({ t_s: 0, max_s: m.frames.at(-1)?.t_s ?? 0, playing: !reducedMotion() });
/** The contract's Storm.pattern default: what the warmed presets use, so the first Simulate opens from cache. */
const DEFAULT_PATTERN: Pattern = "center_peaked";
/** How long Simulate waits for the server's first event before showing "Starting the solver…". */
const STARTING_AFTER_MS = 600;
// A shared link (?aoi=&run=&t=) opens on that area, run and time, paused.
const shared = readSharedView();
const isBaseline = (m: RunManifest) => !m.scenario.interventions?.length;
const sameStorm = (x: RunManifest, y: RunManifest) =>
  JSON.stringify([x.scenario.storm, x.scenario.sim_hours]) === JSON.stringify([y.scenario.storm, y.scenario.sim_hours]);

/** The rain-area state a run's storm.spatial stands for; null = the whole area. */
function rainPatchOf(sp: Spatial | undefined): Partial<RainState> {
  const base = { picking: null, polygon: null as RainState["polygon"], place: null as string | null, placeAsCell: false };
  if (!sp) return { ...base, mode: "whole" };
  if (sp.kind === "cell") {
    const t = sp.track;
    return { ...base, mode: sp.place && !sp.center ? "place" : "cell", placeAsCell: !!sp.place && !sp.center, place: sp.place ?? null,
      ...(sp.center ? { center: sp.center } : {}), radius_m: sp.radius_m, profile: sp.profile, moving: !!t,
      ...(t ? { heading_deg: t.heading_deg, speed_m_s: t.speed_m_s } : {}) };
  }
  return sp.polygon ? { ...base, mode: "draw", polygon: sp.polygon } : { ...base, mode: "place", place: sp.place ?? null };
}

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
  const [pattern, setPattern] = useState<Pattern>(DEFAULT_PATTERN);
  // Model hours from the area's baseline preset (Queens 8, Texas 12); undefined = the contract default.
  const [simHours, setSimHours] = useState<number>();
  const [level, setLevel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [simErr, setSimErr] = useState<Failure | null>(null);
  // Simulate flow (board 8): the estimate for the scenario as set, the live run, and the last run Simulate made.
  const [est, setEst] = useState<SimEstimate | "failed" | null>(null);
  /** How long the estimate has gone unanswered (a cold Cloud Run instance can take tens of seconds). */
  const [estWait, setEstWait] = useState<EstWait>("waiting");
  const [live, setLive] = useState<{ startedAt: number; estS: number | null; tEnd: number; intervalS: number; framesTotal: number; prog: SimProgress | null;
    /** No `started` from the server yet (a cold instance can take tens of seconds). */ starting?: boolean;
    /** The server says this joined someone else's job for the same scenario. */ joined?: boolean } | null>(null);
  const [lastSim, setLastSim] = useState<{ run_id: string; tookS: number | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const simAbort = useRef<AbortController>();
  const simJob = useRef<{ id: string; token: string }>();
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
  const cu = useCloseUp();
  const pinSeries = usePinnedSeries();
  const aoiId = aoi?.aoi_id;
  const rainState = useRain();
  const lay = useLayers();
  const { spatial, ready: rainReady } = spatialOf(rainState);
  const stormNow = stormKey(rain, durationH, pattern, spatial);
  useEffect(() => { if (aoi) initRain(aoi.aoi_id, aoi.grid.bounds_wgs84); }, [aoi?.aoi_id]);
  // Each area starts from its baseline preset (warmed, so the first Simulate is instant): the first one in demo.json's
  // order that the Scenario tab can reproduce (whole-area rain, no interventions). Skipped when a run is already shown
  // (a shared link) or the user has edited the storm before /presets answered.
  const runRef = useRef(run);
  runRef.current = run;
  const touched = useRef(false);
  useEffect(() => {
    if (!aoiId) return;
    touched.current = false;
    let off = false;
    getPresets(aoiId).then((ps) => {
      const base = ps?.find(isBase);
      if (off || !base || runRef.current || touched.current) return;
      setRain(base.storm.total_mm); setDurationH(base.storm.duration_h);
      setPattern(base.storm.pattern ?? DEFAULT_PATTERN); setSimHours(base.sim_hours);
    });
    return () => { off = true; };
  }, [aoiId]);
  useRainPreview(aoiId, rain, durationH, pattern);
  // The preview is on the map until a run exists for this very storm; the Layers card can bring it back.
  const rainVisible = !!spatial && rainReady && (lay.rain.on || rainState.lastSimKey !== stormNow);
  useEffect(() => { patchRain({ visible: rainVisible }); }, [rainVisible]);
  const runId = run?.status === "done" ? run.run_id : undefined;
  // A loaded run (shared link, agent run, Compare pick) puts its storm and rain area back in the editor, so the area
  // matches what the run used and the water layers show instead of the preview. A run made by Simulate already matches.
  const justSimulated = useRef<string>();
  // A new area starts from its own drainage default, untouched (declared before the run effect, which may then adopt the run's).
  useEffect(() => { resetDrainage(aoi?.aoi_id ?? null, aoi?.drainage_default); }, [aoi?.aoi_id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const adoptRun = (m: RunManifest) => {
    if (m.status !== "done" || m.scenario.aoi_id !== aoiId) return;
    const st = m.scenario.storm, pat = st.pattern ?? DEFAULT_PATTERN;
    setRain(st.total_mm); setDurationH(st.duration_h); setPattern(pat); setSimHours(m.scenario.sim_hours);
    patchRain(rainPatchOf(st.spatial));
    patchRain({ lastSimKey: stormKey(st.total_mm, st.duration_h, pat, spatialOf(rainStore.get()).spatial) });
    adoptDrainage(m.scenario.drainage);
  };
  useEffect(() => {
    if (!run) return;
    if (justSimulated.current === run.run_id) justSimulated.current = undefined;
    else adoptRun(run);
  }, [run?.run_id, aoiId]);

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

  const [linkNote, setLinkNote] = useState<string | null>(null);
  // Set when the user picks an area: the link's (slower) answer must not override that choice.
  const picked = useRef(false);
  useEffect(() => {
    getAOIs().then(setAois, () => setAois([]));
    getConfig().then(async (h) => {
      setBuildingsUrl(h.buildings_url); setDefaultAoi(h.default_aoi); setRunsBase(h.runs_base); setProvider(h.agent_provider); setJudgeKeyRequired(!!h.judge_key_required); setIonToken(h.cesium_ion_token); setGoogleAvailable(!!h.google_tiles_available);
      const r = await resolveLink(shared, { getRun, getAOI, defaultAoi: h.default_aoi, successors: h.aoi_successors, picked: () => picked.current });
      if (!r) return;
      setAoi(r.aoi);
      // A dead run or area says so; the address bar keeps only what is shown (no dead ids, no stale area, a clamped time).
      if (r.note) setLinkNote(r.note);
      const u = new URL(window.location.href);
      ["aoi", "run", "t"].forEach((k) => u.searchParams.delete(k));
      Object.entries(r.query).forEach(([k, v]) => { if (v != null) u.searchParams.set(k, String(v)); });
      if (u.toString() !== window.location.href) window.history.replaceState(null, "", u.toString());
      if (r.run) {
        setRun(r.run);
        clock.set({ t_s: r.t ?? 0, max_s: r.run.frames.at(-1)?.t_s ?? 0, playing: false });
      }
    });
  }, []);

  // buildings_url is the default AOI's footprint file; other AOIs serve theirs as a layer (same id/height_m format).
  const aoiBuildingsUrl = aoi && (aoi.aoi_id === defaultAoi && buildingsUrl ? buildingsUrl
    : `${API}/api/aoi/${aoi.aoi_id}/layer/buildings_geojson`);
  const switchAoi = (id: string) => {
    picked.current = true;
    // The address bar follows the pick, so a reload does not reopen the link's run or area.
    const u = new URL(window.location.href);
    ["run", "t", "aoi"].forEach((k) => u.searchParams.delete(k));
    u.searchParams.set("aoi", id);
    window.history.replaceState(null, "", u.toString());
    stop(); setLinkNote(null); setEst(null); setSimHours(undefined); setLastSim(null); setPick({}); setRun(undefined); setSimErr(null); setLevel(null); clock.set({ t_s: 0, max_s: 0, playing: false }); getAOI(id).then(setAoi); };

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

  const interventionsNow: Intervention[] = level == null ? [] : [{ type: "tide", boundary_level_m: level }];
  const drainage = drainageSpec(useDrainage());
  const specNow: ScenarioSpec | null = aoi && rainReady
    ? { aoi_id: aoi.aoi_id, storm: buildStorm(rain, durationH, pattern, spatial), interventions: interventionsNow,
      ...(simHours != null ? { sim_hours: simHours } : {}), ...(drainage ? { drainage } : {}),
      ...(domainSwitchVisible(rainState, !!aoi.layers?.inflows) && rainState.domainOnly ? { domain: "rain_area" as const } : {}) } : null;
  const specKey = specNow ? JSON.stringify(specNow) : "";
  // The switch's note needs the rain-area window size whether or not it is on, so ask for that spec's estimate (free).
  const domainSpec = specNow && aoi && domainSwitchVisible(rainState, !!aoi.layers?.inflows) ? { ...specNow, domain: "rain_area" as const } : null;
  const domainKey = domainSpec ? JSON.stringify(domainSpec) : "";
  useEffect(() => {
    patchRain({ estCells: null });
    if (!domainSpec) return;
    const ac = new AbortController();
    const t = setTimeout(() => estimateSim(domainSpec, ac.signal).then((x) => {
      if (x.domain_cells && x.grid_cells) patchRain({ estCells: { domain: x.domain_cells, grid: x.grid_cells } });
    }, () => { /* the note falls back to "faster" */ }), 400);
    return () => { clearTimeout(t); ac.abort(); };
  }, [domainKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Cached or live, and how long, for the scenario as it stands (debounced; free on the server).
  useEffect(() => {
    setEst(null);
    setEstWait("waiting");
    if (!specNow) return;
    const ac = new AbortController();
    const timers: number[] = [];
    const t = setTimeout(() => {
      timers.push(window.setTimeout(() => setEstWait("waking"), WAKING_MS), window.setTimeout(() => setEstWait("gaveUp"), GIVE_UP_MS));
      estimateSim(specNow, ac.signal).then(setEst, () => { if (!ac.signal.aborted) setEst("failed"); });
    }, 400);
    return () => { clearTimeout(t); timers.forEach(clearTimeout); ac.abort(); };
  }, [specKey]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [!!live]);

  const go = async (retry = false) => {
    if (!specNow) return;
    simAbort.current?.abort();
    const ac = new AbortController();
    simAbort.current = ac;
    setBusy(true); setSimErr(null);
    const t0 = Date.now();
    let cached = false, again = false;
    // The map's clouds and the dock's Rain now panel follow this store (Eng B, lib/simstate.ts).
    patchRain({ picking: null });  // a half-drawn area or centre pick ends: the rain area locks now
    setSim({ running: true, startedAt: t0, estS: est && est !== "failed" ? est.est_s : null, progress: null, modelT: null, storm: specNow.storm });
    // Feedback while the server has not answered: after STARTING_AFTER_MS the card says "Starting the solver…" (a cached run
    // answers well before that, so it never flashes).
    const e0 = est && est !== "failed" ? est : null;
    const slow = setTimeout(() => {
      if (simAbort.current === ac && e0) setNow(Date.now());
      if (simAbort.current === ac && e0) setLive((l) => l ?? { startedAt: t0, estS: e0.est_s, tEnd: e0.t_end_s, intervalS: e0.output_interval_s, framesTotal: e0.frames_total, prog: null, starting: true });
    }, STARTING_AFTER_MS);
    try {
      for await (const e of simulateStream(specNow, ac.signal)) {
        if (e.kind === "started") {
          clearTimeout(slow);
          cached = e.data.cached;
          simJob.current = { id: e.data.job_id, token: e.data.cancel_token };
          setSim({ estS: e.data.est_s });
          // A cached run opens at once: no progress card, no flash.
          if (cached) setLive(null);
          else { setNow(Date.now()); setLive({ startedAt: t0, estS: e.data.est_s, tEnd: e.data.t_end_s, intervalS: e.data.output_interval_s, framesTotal: e.data.frames_total, prog: null, joined: !!e.data.joined }); }
        } else if (e.kind === "progress") {
          setLive((l) => l && { ...l, prog: e.data });
          setSim({ progress: e.data.fraction, modelT: e.data.sim_t_s });
        } else if (e.kind === "done") {
          const m = e.data.manifest;
          justSimulated.current = m.run_id;
          patchRain({ lastSimKey: stormNow });
          setRun(m);
          addRun(m);
          startClock(m);
          setLastSim({ run_id: m.run_id, tookS: cached ? null : (Date.now() - t0) / 1000 });
          setEst((x) => (x && x !== "failed" && x.run_id === m.run_id ? { ...x, cached: true, status: "done", est_s: 0 } : x));
        } else if (e.kind === "cancelled") {
          // Not our Stop (that aborts first): another viewer's cancel, or a press that joined a job being stopped. Once more.
          if (retry) setSimErr({ message: "This run was stopped on the server. Try again.", retryable: true });
          else again = true;
        } else if (e.kind === "error") {
          setSimErr({ message: e.data.message, retryable: e.data.retryable });
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        setSimErr(e instanceof ApiError ? { message: e.message, retryable: e.retryable }
          : { message: "The server is busy. Try again.", retryable: true });
      }
    } finally {
      clearTimeout(slow);
      if (simAbort.current === ac) { simAbort.current = undefined; simJob.current = undefined; setBusy(false); setLive(null); resetSim(); }
    }
    if (again && !ac.signal.aborted) go(true);
  };
  /** Stop: cancel the job by id (Cloud Run's front end keeps the stream open upstream, so an abort alone does not reach
   *  the server), then close the stream; the inputs unlock at once. */
  const stop = () => {
    if (simJob.current) cancelSim(simJob.current.id, simJob.current.token);
    simJob.current = undefined;
    simAbort.current?.abort();
  };
  /** Clear simulation: back to the scenario before any run (map, timeline and charts empty). */
  const clearSim = () => {
    setRun(undefined); setLastSim(null); setSimErr(null);
    patchRain({ lastSimKey: null });
    clock.set({ t_s: 0, max_s: 0, playing: false });
    // A shared or copied link puts the run in the address bar; drop it so a reload does not bring the run back.
    const u = new URL(window.location.href);
    if (u.searchParams.has("run") || u.searchParams.has("t")) {
      u.searchParams.delete("run"); u.searchParams.delete("t");
      window.history.replaceState(null, "", u.toString());
    }
  };
  const simBar: SimBar = live ? (() => {
    const p = live.prog, simT = p?.sim_t_s ?? 0, tEnd = p?.t_end_s ?? live.tEnd;
    return { state: "running" as const, elapsedS: (now - live.startedAt) / 1000,
      estS: p?.eta_s != null ? p.elapsed_s + p.eta_s : live.estS, fraction: p?.fraction ?? 0, simT, tEnd,
      measured: p?.measured ?? false, queued: p?.phase === "queued", joined: !!(live.joined || p?.joined), starting: !!live.starting,
      frames: [Math.min(live.framesTotal, Math.floor(simT / live.intervalS) + 1), live.framesTotal] as [number, number] };
  })()
    : lastSim && run?.run_id === lastSim.run_id && est && est !== "failed" && est.run_id === lastSim.run_id ? { state: "done", tookS: lastSim.tookS }
    : beforeRun(!!specNow, rainState.mode, est, estWait);

  // ---- Agent mode: the session's runs in the order the planner made them.
  const session = useMemo(() => deriveSession(agentEvents), [agentEvents]);
  const agentList = useMemo(() => session.runIds.map((id) => runs.find((r) => r.run_id === id)).filter((m): m is RunManifest => !!m), [session, runs]);
  const placeVals = usePlaceStat(session.place, session.runIds);
  // The GPU card's "Open the demo run": the area's baseline run, only if it is already cached (never starts a simulation).
  // If the area changes while it loads, the old area's run is dropped.
  const aoiNow = useRef(aoiId);
  aoiNow.current = aoiId;
  const openDemo = async () => {
    const id = aoiId;
    const ps = id ? await getPresets(id) : null;
    const base = ps?.find(isBase);
    const est = base && await estimateSim(base).catch(() => null);
    if (aoiNow.current !== id) return;
    if (!est?.cached) throw new Error("No demo run is ready for this area yet. Simulate one from the Scenario tab.");
    const m = await getRun(est.run_id);
    if (aoiNow.current !== id || m.status !== "done") return;
    setRun(m); addRun(m); startClock(m);
  };
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
  useEffect(() => { if (pair) adoptRun(pair.b); }, [pair?.b.run_id]);
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
      <TopBar rainText={rainSummary(rainState)} aois={aoi && aois.length && !aois.some((x) => x.aoi_id === aoi.aoi_id) ? [...aois, { aoi_id: aoi.aoi_id, name: `${aoi.name} (earlier version)` }] : aois} aoiId={aoi?.aoi_id} onAoi={switchAoi} rainMm={rain} durationH={durationH} pattern={pattern}
        mode={mode} onMode={(m) => { setMode(m); setView({ sidebar: true }); }} agentRuns={session.runIds.length} onTour={() => setTour(true)}
        onCopyLink={copyLink} onSaveImage={saveImage} />
      <div className="dr-main">
        <div className="dr-map" data-tour="map">
          <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: side ? "50%" : 0 }}>
            <ErrorBoundary name="map" resetKey={aoi?.aoi_id} style={{ position: "absolute", inset: 0 }}>
            {aoi && <MapStage aoi={aoi} run={mapRun} frames={frames} framesB={framesB} split={pair && cmpView === "Swipe" ? split : undefined} onViewer={setMainViewer} onBuilding={onBuilding} onView={(v) => setPlan(v === "Plan")} underlay={plan ? <Graticule viewer={mainViewer} /> : undefined}
              tS={t_s} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl} runsBase={runsBase}
              rainStorm={{ total_mm: rain, duration_h: durationH, pattern }} />}
            </ErrorBoundary>
          </div>
          {side && aoi && pair && (
            <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", right: 0 }}>
              <ErrorBoundary name="second map" resetKey={aoi?.aoi_id} style={{ position: "absolute", inset: 0 }}>
              <SideGlobe aoi={aoi} run={pair.b} frames={framesOf(pair.b)} tS={t_s} ionToken={ionToken} buildingsUrl={aoiBuildingsUrl} runsBase={runsBase} leader={mainViewer} />
              </ErrorBoundary>
            </div>
          )}
          {sel && !side && <BuildingOnMap viewer={mainViewer} sel={sel} second={sel2} />}
          {agentView && <AgentMapOverlay runs={agentList} shown={run?.run_id} picked={agentShown?.id === run?.run_id && !!agentShown?.picked} onShow={showAgentRun} />}
          {pair && <CompareMapOverlay a={pair.a} b={pair.b} origin={origin} view={cmpView} onView={setCmpView} split={split} onSplit={setSplit} />}
          <div className="dr-badges">
            {aoi?.is_synthetic && <ProvenanceBadge kind="synthetic" />}
            {replayed && <ProvenanceBadge kind="synthetic">Replay</ProvenanceBadge>}
          </div>
        </div>
        {view.timeline && (cu.active ? <CloseUpDock /> : buildingView ? <BuildingDock sel={sel!} second={sel2} /> : agentView ? <AgentDock runs={agentList} session={session} placeVals={placeVals} shown={run?.run_id} onShow={showAgentRun} /> : <Dock storm={{ total_mm: rain, duration_h: durationH, pattern }} run={pair ? pair.b : run} ghost={pair?.a} series={pinSeries ?? undefined}
          third={pair ? <ByPlace rows={places} /> : undefined} side={pair ? <WhatChanges changes={changes} active={activeChange} /> : undefined}
          note={pair ? "One clock drives A and B" : undefined} />)}
      </div>
      {/* The sidebar stays mounted while View hides it, so a running agent session keeps streaming. */}
      <div style={{ display: view.sidebar ? "contents" : "none" }}>
      <ErrorBoundary name="side panel" resetKey={aoi?.aoi_id} style={{ borderLeft: "1px solid var(--hairline)", minHeight: 0 }}>
      <Sidebar aoi={aoi} run={mapRun} buildingsUrl={aoiBuildingsUrl} onDemo={openDemo} sources={sources} inspectFocus={pick.id} closeup={!!cu.active}
          inspect={cu.active ? <CloseUpCards /> : sel ? <><SelectedBuildingCard sel={sel} second={sel2} onFly={() => flyTo(sel)} onClear={() => setPick({})} />
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
          rain, onRain: (v) => { touched.current = true; setRain(v); }, durationH, onDuration: (v) => { touched.current = true; setDurationH(v); },
          pattern, onPattern: (v) => { touched.current = true; setPattern(v); }, level, onLevel: setLevel,
          coastal, busy, canRun: !!aoi && rainReady, onSimulate: () => go(), err: simErr, linkNote: linkNote ? { message: linkNote, detail: `Opened ${aoi?.name ?? "the default area"} instead.`, onDismiss: () => setLinkNote(null) } : null, sim: simBar, onStop: stop, onClear: clearSim, canClear: !!run && !live && !busy,
        }} />
      </ErrorBoundary>
      </div>
      {tour && <Tour onClose={() => setTour(false)} />}
    </div>
  );
}
