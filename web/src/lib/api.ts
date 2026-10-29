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
  aoi_id: string; name: string; is_synthetic: boolean;
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
