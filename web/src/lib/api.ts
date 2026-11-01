// Thin typed client for the Dry Run API (owner: Eng B).
// Types are GENERATED from the Python contracts: `make contracts` -> src/contracts/gen/*.d.ts
// Until the first generation lands, the minimal hand-written types below unblock work.
// Delete them once gen/ exists and import from "../contracts/gen/..." instead.
import { noteLockout } from "./lockout";
import type { LockScope } from "./lockout";
import type { DrainageDefault } from "../contracts/gen/AOIManifest";
import type { Drainage } from "../contracts/gen/ScenarioSpec";
import type { RouteRequest } from "../contracts/gen/RouteRequest";
import type { RouteResult } from "../contracts/gen/RouteResult";

export const API = import.meta.env.VITE_API_BASE ?? "";

export type RainProfile = "gaussian" | "exponential" | "flat";
/** heading_deg is the direction the cell moves TOWARD (0 to <360); `center` is where it is at its peak intensity. */
export type RainTrack = { heading_deg: number; speed_m_s: number };
/** Where the rain falls (server 0.6.0). null = the whole area. Exactly one of center/place (cell) or polygon/place (polygon). */
export type Spatial = null
  | { kind: "cell"; center: [number, number] | null; place: string | null; radius_m: number; profile: RainProfile; track: RainTrack | null }
  | { kind: "polygon"; polygon: [number, number][] | null; place: string | null };
export type Storm = { total_mm: number; duration_h: number; pattern?: "uniform" | "front_loaded" | "center_peaked"; spatial?: Spatial };
/** POST /api/aoi/{id}/rain_field: the rain over the AOI before simulating. png is north-up on the AOI grid, already coloured. */
export type RainField = {
  png: string; bounds_wgs84: [number, number, number, number]; nx: number; ny: number; colour: string; max_alpha: number; vmax_mm: number;
  max_point_mm: number; mean_aoi_mm: number; mean_land_mm: number; wet_area_km2: number; volume_generated_m3: number; volume_in_aoi_m3: number;
  outside_share: number; peak_intensity_mm_h: number; center: [number, number] | null; warnings: string[]; note: string;
};
// Area = EITHER polygon OR place (a name from the AOI's places layer); exactly one, except
// drain_upgrade where neither means the whole AOI.
type Area = { polygon: [number, number][]; place?: never } | { place: string; polygon?: never };
export type Intervention =
  | ({ type: "drain_upgrade"; capacity_factor?: number; add_mm_h?: number } & (Area | {}))
  | ({ type: "green"; infiltration_mm_h?: number; manning?: number } & Area)
  | ({ type: "pond"; depth_m?: number } & Area)
  | { type: "tide"; boundary_level_m: number }
  | ({ type: "road_closure" } & Area);
export type ScenarioSpec = {
  aoi_id: string; storm: Storm; interventions?: Intervention[];
  sim_hours?: number; output_interval_min?: number; label?: string | null;
  /** "rain_area": simulate only the rain window (needs storm.spatial; not on AOIs with river inflows). */
  domain?: "aoi" | "rain_area";
  /** Contract 0.8.0: the drainage system; omitted or null = the area's default (lib/drainage.ts). */
  drainage?: Drainage | null;
};
export type FrameRef = { t_s: number; png: string; depth: string };
export type RunStats = Record<string, number | boolean | string> & { run_id: string };
export type RunManifest = {
  run_id: string; building_depths: string | null; intervention_cells: number[];
  timeseries: { t_s: number[]; flooded_area_km2: number[]; road_km_impassable: number[]; edges_cut: number[];
    /** 0.8.0, null on legacy runs: share of the drain network running full (0-100), outfall and surcharge flow. */
    drain_full_pct?: number[] | null; drain_outfall_m3_s?: number[] | null; surcharge_m3_s?: number[] | null } | null; status: "queued" | "running" | "done" | "failed"; frames: FrameRef[];
  max_depth_png: string | null; stats: RunStats | null; backend: "fake" | "solver" | "surrogate";
  colormap: { depth_m: number[] }; error: string | null; scenario: ScenarioSpec;
  /** 0.8.0: run file with the per-frame fill of every drain line and sewer zone, and the run's limits (null on legacy runs). */
  drain_fill?: string | null; drainage_limits?: string[] | null;
};
export type AOIManifest = {
  aoi_id: string; name: string; is_synthetic: boolean; layers?: Record<string, string>; sources?: Record<string, string>;
  /** True where Google Photorealistic 3D has real buildings; the twin then draws only flooded ones over the mesh. */
  photoreal_buildings?: boolean;
  /** 0.8.0: the area's drainage system and design values; null on areas without a drain model (no Drainage card). */
  drainage_default?: DrainageDefault | null;
  grid: { bounds_wgs84: [number, number, number, number]; nx: number; ny: number; cell_size_m: number };
};
export type AgentEvent = { kind: "thought" | "tool_call" | "tool_result" | "run_ready" | "brief" | "error" | "done"; data: any };

// Team rehearsals: run `localStorage.setItem("dr_team_token", "<DRYRUN_ADMIN_TOKEN>")` in the console
// once to bypass the public rate limits. Never commit the token.
const team = (): Record<string, string> => {
  try { const t = localStorage.getItem("dr_team_token"); return t ? { "X-Team-Token": t } : {}; } catch { return {}; }
};
const JSONH = () => ({ "Content-Type": "application/json", ...team() });

// Judges get a key through the private submission form; paid providers (meta, baseten, openrouter) need it.
// sessionStorage: the key is gone when the tab closes.
const JUDGE = "dr_judge_key";
export const getJudgeKey = () => { try { return sessionStorage.getItem(JUDGE) ?? ""; } catch { return ""; } };
export const setJudgeKey = (k: string) => { try { k ? sessionStorage.setItem(JUDGE, k) : sessionStorage.removeItem(JUDGE); } catch { /* storage blocked */ } };
const judge = (): Record<string, string> => { const k = getJudgeKey(); return k ? { "X-Judge-Key": k } : {}; };

/** A failed request, carrying the server's error envelope: {"detail", "error": {code, message, retryable}}. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryable: boolean,
              readonly retryAfterS?: number, readonly lockout?: LockScope) { super(message); }
}

async function apiError(r: Response): Promise<ApiError> {
  const ra = Number(r.headers.get("retry-after")) || undefined;
  if (!r.headers.get("content-type")?.includes("application/json")) {
    // Cloud Run's own "no available instance" page, not our app.
    const busy = r.status === 500 || r.status === 503;
    return new ApiError(busy ? "The server is busy. Try again." : r.statusText || "The request failed.",
      r.status, busy ? "unavailable" : "server_error", true, ra);
  }
  const b = await r.json().catch(() => ({}));
  const e = b?.error ?? {};
  const msg = e.message ?? (typeof b?.detail === "string" ? b.detail : "The request failed.");
  // A judge-key lockout: every key box shows it and counts down, even after a reload.
  const lock = r.status === 429 ? r.headers.get("x-auth-lockout") : null;
  const scope = lock === "ip" || lock === "global" ? lock : undefined;
  if (scope) noteLockout(scope, ra);
  return new ApiError(msg, r.status, e.code ?? "server_error", e.retryable ?? r.status >= 500, ra, scope);
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw await apiError(r);
  return r.json() as Promise<T>;
}

/** The Google Map Tiles key, for judges (X-Judge-Key) and the team only; 403 without one, 404 when the server has none. */
export const getGoogleTilesKey = () =>
  fetch(`${API}/api/tiles/google-key`, { headers: { ...team(), ...judge() }, cache: "no-store" }).then(j<{ key: string }>).then((r) => r.key);
/** Precomputed lagoon/sea level sensitivity for an AOI (404 where there is none). */
export type LevelSensitivity = { storm: string; datum: string; note: string; rows: { level_m: number; run_id: string; flooded_km2: number; buildings: number }[] };
export const getLevelSensitivity = (aoiId: string) => fetch(`${API}/api/aoi/${encodeURIComponent(aoiId)}/level_sensitivity`).then(j<LevelSensitivity>);
export const getConfig = () => fetch(`${API}/api/config`).then(j<{ runs_base: string; sim_backend: string; default_aoi: string; agent_provider: string; cesium_ion_token: string; sovereign_provider_available: boolean; buildings_url: string; judge_key_required?: boolean; google_tiles_available?: boolean;
  /** Old area id -> the published id that supersedes it (empty until a successor exists). */ aoi_successors?: Record<string, string> }>);
export type Replay = { question: string; aoi_id: string; provider: string; model: string; recorded_at: string };
export const getReplays = () => fetch(`${API}/api/replays`).then(j<Replay[]>);
export const getAOIs = () => fetch(`${API}/api/aois`).then(j<{ aoi_id: string; name: string }[]>);
export const getAOI = (id: string) => fetch(`${API}/api/aoi/${encodeURIComponent(id)}`).then(j<AOIManifest>);
export const simulate = async (s: ScenarioSpec) => {
  const post = () => fetch(`${API}/api/simulate`, { method: "POST", headers: JSONH(), body: JSON.stringify(s) });
  let r = await post();
  // Cloud Run answers a burst with a non-JSON 500/503 ("no available instance") while instances cold-start.
  // Runs are content-addressed, so one retry is idempotent (a cache hit if the first attempt finished).
  if ((r.status === 500 || r.status === 503) && !r.headers.get("content-type")?.includes("application/json")) {
    await new Promise((ok) => setTimeout(ok, 5000));
    r = await post();
  }
  return j<RunManifest>(r);
};
/** POST /api/simulate/estimate (Eng D): cached or not, and the expected compute time before pressing Simulate. */
export type SimEstimate = {
  run_id: string; cached: boolean; status: "done" | "running" | "failed" | "none";
  est_s: number | null; est_basis: "cached" | "speed_model" | "history" | null; t_end_s: number;
  output_interval_s: number; frames_total: number;
  domain_cells?: number; grid_cells?: number;
};
export const estimateSim = (s: ScenarioSpec, signal?: AbortSignal) =>
  fetch(`${API}/api/simulate/estimate`, { method: "POST", headers: JSONH(), body: JSON.stringify(s), signal }).then(j<SimEstimate>);

/** DELETE /api/simulate/jobs/{job_id}: Stop. keepalive so it still goes out when the page is changing area or closing.
 *  404 (already ended, or on another instance) and 403 are ignored: there is nothing left to stop. */
export const cancelSim = (jobId: string, token: string) =>
  fetch(`${API}/api/simulate/jobs/${jobId}`, { method: "DELETE", headers: { "X-Cancel-Token": token }, keepalive: true }).catch(() => { /* best effort */ });

export type SimProgress = {
  phase: "queued" | "solving" | "saving" | "cancelling"; sim_t_s: number; t_end_s: number; fraction: number;
  elapsed_s: number; eta_s: number | null; measured: boolean;
  /** This stream joined a job another request had already started (asked of Eng D; absent means a job of its own). */
  joined?: boolean;
  /** While queued: seconds until the engine is free for this run (null when a run ahead has no estimate), and how many
   *  runs are ahead on this instance. eta_s already includes queue_s. Both 0 once solving. */
  queue_s?: number | null; ahead?: number;
};
export type SimEvent =
  | { kind: "started"; data: { job_id: string; cancel_token: string; run_id: string; cached: boolean; est_s: number | null; t_end_s: number;
      output_interval_s: number; frames_total: number; joined?: boolean; queue_s?: number | null; ahead?: number } }
  | { kind: "progress"; data: SimProgress }
  | { kind: "done"; data: { manifest: RunManifest } }
  | { kind: "cancelled"; data: { reason: string } }
  | { kind: "error"; data: { code: string; message: string; retryable: boolean } };

/** POST /api/simulate/stream: a run with live progress. Stop is cancelSim() then aborting `signal`. A stream that ends without done, cancelled or error throws a retryable ApiError. */
export async function* simulateStream(s: ScenarioSpec, signal: AbortSignal): AsyncGenerator<SimEvent> {
  const r = await fetch(`${API}/api/simulate/stream`, { method: "POST", headers: JSONH(), body: JSON.stringify(s), signal });
  if (!r.ok) throw await apiError(r);
  if (!r.body) throw new ApiError("The server is busy. Try again.", 0, "stream_closed", true);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", ended = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i).replace(/^data: /, "");
      buf = buf.slice(i + 2);
      if (!chunk.trim()) continue;
      const e = JSON.parse(chunk) as SimEvent;
      if (e.kind === "done" || e.kind === "cancelled" || e.kind === "error") ended = true;
      yield e;
    }
  }
  if (!ended) throw new ApiError("The connection to the simulation dropped. Try again.", 0, "stream_closed", true);
}
/** GET /api/aoi/{id}/presets: the area's warmed scenarios, verbatim (null where the server has none). */
export const getPresets = (aoiId: string) =>
  fetch(`${API}/api/aoi/${encodeURIComponent(aoiId)}/presets`).then((r) => (r.ok ? (r.json() as Promise<ScenarioSpec[]>) : null)).catch(() => null);
export const getRainField = (aoiId: string, storm: Storm, signal?: AbortSignal) =>
  fetch(`${API}/api/aoi/${encodeURIComponent(aoiId)}/rain_field`, { method: "POST", headers: JSONH(), body: JSON.stringify({ storm }), signal }).then(j<RainField>);
export const getRun = (id: string) => fetch(`${API}/api/runs/${encodeURIComponent(id)}`).then(j<RunManifest>);
/** POST /api/route (Safe route): the dry path from `origin` at `t_s`; destination null = the nearest shelter. */
export const postRoute = (req: RouteRequest, signal?: AbortSignal) =>
  fetch(`${API}/api/route`, { method: "POST", headers: JSONH(), body: JSON.stringify(req), signal }).then(j<RouteResult>);

/** URL of a run file (frame PNG etc). runsBase comes from /api/config ("/runs" locally, GCS URL in prod). */
export const runFileUrl = (runsBase: string, runId: string, rel: string) => `${runsBase.replace(/\/$/, "")}/${runId}/${rel}`;

/** The server's limit on a question (AgentRequest.question in dryrun/api/agent_routes.py). */
export const QUESTION_MAX = 1000;

/** POST /api/agent streams Server-Sent Events; EventSource can't POST, so read the stream manually. */
export async function* askAgent(question: string, provider = "meta", aoi_id?: string): AsyncGenerator<AgentEvent> {
  const r = await fetch(`${API}/api/agent`, {
    method: "POST", headers: { ...JSONH(), ...judge() }, body: JSON.stringify({ question, provider, aoi_id }),
  });
  if (!r.ok) throw await apiError(r);
  if (!r.body) throw new Error("no stream");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i).replace(/^data: /, "");
      buf = buf.slice(i + 2);
      if (chunk.trim()) yield JSON.parse(chunk) as AgentEvent;
    }
  }
}

// ---- rev 5 read-only data endpoints. Each resolves to null when the server does not have it (404 while deploying). ----
export type RunEvent = {
  event: string; kind: "pond_closure" | "first_cut" | "cut_jump" | "peak_area"; t_s: number; t: string | null; count?: number; road_km?: number; flooded_area_km2?: number;
  point: [number, number] | null; place: string | null; new_cuts_by_place?: Record<string, number>; place_flooded_km2?: number;
};
export type EventPlace = {
  place: string; kind: string; label_point: [number, number]; ten_pct_wet_s: number | null; ten_pct_wet: string | null;
  first_road_cut_s: number | null; first_road_cut: string | null; peak_pct_wet: number;
};
export type RunEvents = {
  run_id: string; aoi_id: string; threshold_m: { flooded: number; road_impassable: number }; frame_interval_s: number; note: string;
  events: RunEvent[]; places: EventPlace[];
};
export type PointSeries = {
  run_id: string; lon: number; lat: number; cell: [number, number]; cell_center: [number, number]; permanent_water: boolean;
  t_s: number[]; depth_m: number[]; max_depth_m: number; first_flooded_s: number | null; first_impassable_s: number | null;
  threshold_m: { flooded: number; road_impassable: number };
};
export type BoundaryCollection = {
  type: "FeatureCollection";
  features: { type: "Feature"; properties: { kind: string; default_level_m?: number; note?: string };
    geometry: { type: "MultiLineString" | "LineString"; coordinates: any } }[];
};
export type InflowPoint = { name: string; gauges?: string[]; hydrograph: [number, number][]; units: string };
export type InflowCollection = {
  type: "FeatureCollection"; properties?: { t0_utc?: string; note?: string };
  features: { type: "Feature"; properties: InflowPoint; geometry: { type: "Point"; coordinates: [number, number] } }[];
};

/** GET a JSON endpoint; any non-2xx (404 while the server deploys, 400/409 for series) or network failure gives null. */
async function optional<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

export const getRunEvents = (runId: string) => optional<RunEvents>(`${API}/api/runs/${encodeURIComponent(runId)}/derived/events.json`);
export const getBoundary = (aoiId: string) => optional<BoundaryCollection>(`${API}/api/aoi/${encodeURIComponent(aoiId)}/boundary.geojson`);
export const getInflows = (aoiId: string) => optional<InflowCollection>(`${API}/api/aoi/${encodeURIComponent(aoiId)}/layer/inflows`);

/** Callers debounce hover by this much before asking for a series. */
export const SERIES_DEBOUNCE_MS = 200;
// Coordinates are rounded to 4 decimals (about 10 m, finer than a cell) so repeated hovers over one cell are cache hits, in memory and in the browser.
const seriesCache = new Map<string, Promise<PointSeries | null>>();
export function getPointSeries(runId: string, lon: number, lat: number): Promise<PointSeries | null> {
  const lo = lon.toFixed(4), la = lat.toFixed(4), key = `${runId}|${lo}|${la}`;
  let p = seriesCache.get(key);
  if (!p) {
    p = optional<PointSeries>(`${API}/api/runs/${encodeURIComponent(runId)}/series?lon=${lo}&lat=${la}`).then((s) => {
      if (!s) seriesCache.delete(key);
      return s;
    });
    seriesCache.set(key, p);
    if (seriesCache.size > 400) seriesCache.delete(seriesCache.keys().next().value as string);
  }
  return p;
}

/** GET /api/aoi/{id}/point: what is at a point without a run (waypoints). ground_m is the model's ground, not the 3D terrain. */
export type PointInfo = {
  aoi_id: string; lon: number; lat: number; cell: [number, number]; ground_m: number;
  open_water: boolean | null; permanent_water: boolean | null;
  place: { name: string; inside: boolean; distance_m: number } | null;
  building: { id: string; cell: [number, number]; distance_m: number } | null;
  is_synthetic: boolean;
};
export const getPointInfo = (aoiId: string, lon: number, lat: number) =>
  optional<PointInfo>(`${API}/api/aoi/${encodeURIComponent(aoiId)}/point?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}`);
/** A run's building_depths.json (max depth per building id) as a map. */
export const getBuildingDepths = (url: string) => optional<{ ids: string[]; max_depth_m: number[] }>(url)
  .then((b) => (b ? new Map(b.ids.map((id, i) => [String(id), b.max_depth_m[i]])) : null));
