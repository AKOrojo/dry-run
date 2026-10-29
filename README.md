# Dry Run

An agentic urban-flood digital twin: design a storm, change the city (drains, green
infrastructure, retention ponds, tide), and watch a 2D flood simulation, impacted
buildings and evacuation routes change, with a Muse Spark planner agent whose every
number is verified against simulator output.

> Built during the building period of the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026).
> The git history is the record of what was built and when; see **Provenance** below.
> **Not an operational flood warning system.** Layers are badged Simulated / Observed / AI-illustrated.

## Quick start (no keys, no cloud)

```bash
cp .env.example .env
make setup        # python + web deps
make fixtures     # synthetic AOI -> ./data
make smoke        # fixtures -> runs -> route -> agent brief, all offline
make api          # :8080
make web          # :5173 (proxies /api and /runs to :8080)
```

## Architecture

```
web (React + CesiumJS) --/api--> FastAPI on Cloud Run --> sim engine (local-inertial solver)
        |                              |                 --> routing (NetworkX on OSM)
        |                              |                 --> agent (Muse Spark 1.3 / Spark Open)
        +-- frames (PNG) <-- GCS runs bucket <-- run outputs (content-addressed by run_id)
                               GCS data bucket <-- offline open-data + OSM pipeline
```

| Meta model | Used for |
|---|---|
| Muse Spark 1.3 | Planner agent: tool calls over the simulator, verified briefs; vision depth estimates |
| Muse Spark Open (Baseten) | "Sovereign mode": same agent on open weights |
| SAM 3.1 | Flood-water / reference-object masks from citizen photos |
| Muse Voice Transcribe | Hands-free responder queries, biased to Lagos place names |
| Muse Image | Before/after illustrations of interventions (labelled AI illustration) |

Built with Muse Spark Open. Data attributions: `ATTRIBUTION.md`.

## Model card: flood simulation

**What it is.** A 2D local-inertial shallow-water model (Bates et al. 2010, the LISFLOOD-FP
formulation) on the AOI's ~30 m lon/lat grid: `dryrun/sim/solver.py`. Per cell face,
`q ← (q − g·h_flow·dt·∂η/∂x) / (1 + g·dt·n²·|q| / h_flow^(7/3))`, with
`h_flow = max(η) − max(z)`, no flow below 1 mm, adaptive `dt = 0.7·min(dx,dy)/√(g·h_max)` capped at
60 s. A conservative limiter stops a cell sending more water than it holds, so depth never goes
negative and the water budget closes to round-off. Rain is spatially uniform and follows the storm's
hyetograph, integrated exactly per step. Infiltration and drains remove water at fixed per-cell rates.
Open-water cells (`boundary_mask`, the lagoon and the sea, wherever they are) are held at the tide
level, so water drains out, or flows in when the tide is higher. Other domain edges are walls.
Interventions only change physics inputs (`sim/interventions.py`), never outputs. Deterministic: the same
scenario always gives the same numbers, and runs are cached by `run_id`.

**Not** a forecast or an operational warning system. It is a planning model, used to compare scenarios.

### Inputs and assumptions

| Input | Source | Assumption / limitation |
|---|---|---|
| Terrain | Copernicus GLO-30 (a DSM) | Not raised under buildings; light smoothing (σ = 1 cell) on land; lagoon/sea bed set ≤ −1 m; canals 1 m below their lowest bank (`pipeline/build_layers.py`) |
| Roughness, infiltration | ESA WorldCover → `LANDCOVER_LUT` | Literature-range values, not calibrated. Built-up n = 0.05 stands in for sub-grid buildings |
| Drains | OSM waterway=drain/ditch/canal | 10 / 10 / 25 mm/h on cells they cross; many Lagos drains are silted, and unmapped drains count as 0 |
| Open water | JRC occurrence ≥ 90 % | A body is a tide boundary if ≥ 1000 cells or touching the AOI edge; smaller water is excluded from stats only |
| Tide | scenario | Default −0.5 m, held constant through the run (no tidal cycle) |
| Rain | scenario | Uniform over the AOI; no infiltration-capacity decay (no soil saturation model) |
| Flooded / severe / passable | `sim/exposure.py` | 0.15 m / 0.5 m / 0.3 m are **assumptions**, not standards |
| Building depth | `sim/exposure.py` | Max over the 3×3 cells around the footprint (buildings sit on raised DSM cells) |

`RunStats` meanings (frozen from Thursday; new meanings get new fields): exposure stats leave out permanent
water and pond cells. `stored_volume_end_m3` is water gained on land since t = 0. The lagoon held at the
tide is the sea, not stored flood water. `boundary_outflow_m3` is the net flow from land into the
held boundary cells (negative = tide pushing water in). On the solver, `rain_volume_m3` counts rain on
land cells only.

### Known biases
- **DSM bias:** GLO-30 includes some building and canopy height, so streets in dense areas sit a little high and
  ponding there is likely under-stated.
- **30 m grid:** streets and drains narrower than a cell are sub-grid. Flow paths in flat Lagos are sensitive to
  DEM noise.
- **Sparse drain data:** OSM drain mapping is incomplete, so baseline drainage is uncertain both ways.
- **Uniform rain, constant tide, fixed rates:** no storm cell movement, tidal cycle or soil saturation.
- **Local-inertial physics:** no advection term. It is accurate for slow, deep floodplain flow and runs slightly slow for
  fast fronts (dam-break test below).

### Verification (synthetic tests, `tests/test_solver.py`)
| Check | Result |
|---|---|
| Mass balance, fixture AOI, 120 mm / 3 h | \|error\| < 0.001 % (gate: < 1 %) |
| Still water on a flat bed, and a lake at rest with dry islands | unchanged to 1e-6 m after 1 h |
| Wet-bed dam break (Stoker), front position at 30 s | −7 % (gate: within 10 %) |
| Interventions | drains, new drains, green and ponds never worsen impacts; a 1.5 m tide worsens them |
| Speed, 333 × 333 grid, 6 h simulated | 21 s, single thread (gate: < 60 s on 2 vCPU; `FT_PERF=1 pytest tests/test_solver.py`) |

### Validation against observations
- **Sentinel-1 CSI** (`evals/validation/csi.py`): *pending*. It needs the Lagos `obs_flood_extent` scene. CSI =
  hits / (hits + misses + false alarms) on max extent, with permanent water left out. It will be reported here
  even if mediocre; if Earth Engine access does not arrive, this line will say it was skipped.

### Surrogate (screening only)
`dryrun/surrogate/`: one LightGBM model per stat, trained on a Latin hypercube of real solver runs (rain
40–250 mm, duration 1–6 h, tide −0.5–1.5 m, drain factor 0.5–3, new drains 0–60 mm/h, green and pond on named
places). It is served as plain numpy. `surrogate_sweep` ranks intervention combinations with
`is_surrogate=True`. Its numbers have no `run_id`, so the claim verifier cannot accept them, and the agent must
confirm a candidate with `run_simulation`. Fixture AOI, 300 runs, 5-fold CV: R² 0.95 to 0.97 on all five targets
(flooded buildings MAE ≈ 21 of a baseline ≈ 200). It ranks well but over-predicts when impacts are small.
Lagos numbers: pending.

## Provenance

Everything in this repository was built for the hackathon and the git history is the record —
real timestamps, nothing backdated, no pre-existing codebase or product reused. The first commit
is the team's scaffold (data contracts, placeholder backends, deploy scripts), written from our
own feasibility plan on Oct 27 2026 with AI assistance, reviewed by the team, and committed the
next morning. Everything after it is day-by-day work by the four of us, with AI assistance noted
in the commit body where it did the bulk of the writing.
