// Thin typed client for the Dry Run API (owner: Eng B).
// Types are GENERATED from the Python contracts: `make contracts` -> src/contracts/gen/*.d.ts
// Until the first generation lands, the minimal hand-written types below unblock work.
// Delete them once gen/ exists and import from "../contracts/gen/..." instead.

export const API = import.meta.env.VITE_API_BASE ?? "";

export type Storm = { total_mm: number; duration_h: number; pattern?: "uniform" | "front_loaded" | "center_peaked" };
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
};
export type FrameRef = { t_s: number; png: string; depth: string };
export type RunStats = Record<string, number | boolean | string> & { run_id: string };
export type RunManifest = {
  run_id: string; building_depths: string | null; intervention_cells: number[];
  timeseries: { t_s: number[]; flooded_area_km2: number[]; road_km_impassable: number[]; edges_cut: number[] } | null; status: "queued" | "running" | "done" | "failed"; frames: FrameRef[];
  max_depth_png: string | null; stats: RunStats | null; backend: "fake" | "solver" | "surrogate";
  colormap: { depth_m: number[] }; error: string | null; scenario: ScenarioSpec;
};
export type AOIManifest = {
  aoi_id: string; name: string; is_synthetic: boolean; layers?: Record<string, string>; sources?: Record<string, string>;
  /** True where Google Photorealistic 3D has real buildings; the twin then draws only flooded ones over the mesh. */
  photoreal_buildings?: boolean;
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
              readonly retryAfterS?: number) { super(message); }
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
  return new ApiError(msg, r.status, e.code ?? "server_error", e.retryable ?? r.status >= 500, ra);
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw await apiError(r);
  return r.json() as Promise<T>;
}

export const getConfig = () => fetch(`${API}/api/config`).then(j<{ runs_base: string; sim_backend: string; default_aoi: string; agent_provider: string; cesium_ion_token: string; sovereign_provider_available: boolean; buildings_url: string; judge_key_required?: boolean }>);
export type Replay = { question: string; aoi_id: string; provider: string; model: string; recorded_at: string };
export const getReplays = () => fetch(`${API}/api/replays`).then(j<Replay[]>);
export const getAOIs = () => fetch(`${API}/api/aois`).then(j<{ aoi_id: string; name: string }[]>);
export const getAOI = (id: string) => fetch(`${API}/api/aoi/${id}`).then(j<AOIManifest>);
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
export const getRun = (id: string) => fetch(`${API}/api/runs/${id}`).then(j<RunManifest>);

/** URL of a run file (frame PNG etc). runsBase comes from /api/config ("/runs" locally, GCS URL in prod). */
export const runFileUrl = (runsBase: string, runId: string, rel: string) => `${runsBase.replace(/\/$/, "")}/${runId}/${rel}`;

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

export const getRunEvents = (runId: string) => optional<RunEvents>(`${API}/api/runs/${runId}/derived/events.json`);
export const getBoundary = (aoiId: string) => optional<BoundaryCollection>(`${API}/api/aoi/${aoiId}/boundary.geojson`);
export const getInflows = (aoiId: string) => optional<InflowCollection>(`${API}/api/aoi/${aoiId}/layer/inflows`);

/** Callers debounce hover by this much before asking for a series. */
export const SERIES_DEBOUNCE_MS = 200;
// Coordinates are rounded to 4 decimals (about 10 m, finer than a cell) so repeated hovers over one cell are cache hits, in memory and in the browser.
const seriesCache = new Map<string, Promise<PointSeries | null>>();
export function getPointSeries(runId: string, lon: number, lat: number): Promise<PointSeries | null> {
  const lo = lon.toFixed(4), la = lat.toFixed(4), key = `${runId}|${lo}|${la}`;
  let p = seriesCache.get(key);
  if (!p) {
    p = optional<PointSeries>(`${API}/api/runs/${runId}/series?lon=${lo}&lat=${la}`).then((s) => {
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
  optional<PointInfo>(`${API}/api/aoi/${aoiId}/point?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}`);
/** A run's building_depths.json (max depth per building id) as a map. */
export const getBuildingDepths = (url: string) => optional<{ ids: string[]; max_depth_m: number[] }>(url)
  .then((b) => (b ? new Map(b.ids.map((id, i) => [String(id), b.max_depth_m[i]])) : null));
