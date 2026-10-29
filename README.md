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
| Muse Spark Open (via OpenRouter) | "Sovereign mode": same agent on open weights |
| SAM 3.1 | Flood-water / reference-object masks from citizen photos |
| Muse Voice Transcribe | Hands-free responder queries, biased to Lagos place names |
| Muse Image | Before/after illustrations of interventions (labelled AI illustration) |

Built with Muse Spark Open. Data attributions: `ATTRIBUTION.md`.

## Data card: Lagos AOI (`lagos-lekki-v1`)

**Area.** Lekki–Ajah corridor, W 3.470 S 6.420 E 3.620 N 6.510 (EPSG:4326), a 540 × 324 grid of 1 arc-second
cells (~30.7 × 30.5 m). The Lagos Lagoon is along the north edge and the Atlantic along the south. Built
2026-10-29 by `ee_export` → `build_layers` → `osm` (`dryrun/pipeline/`); every source and its credit line is in
`ATTRIBUTION.md` and in the AOI manifest's `sources`. AOI ids are immutable: any change ships as a new id.

| Layer | Source | How it was made | Known limits |
|---|---|---|---|
| Terrain | Copernicus GLO-30 | native grid; Eng A's `treat_dem` (see model card) | a surface model; ~7.9k lagoon-fringe cells sit at exactly 0 m |
| Land cover | ESA WorldCover 2021 | mode-resampled from 10 m | 2021 snapshot; Lekki has built up since |
| Permanent water | JRC GSW occurrence v1.5 | ≥ 90 % of 1984–2024 | seasonal water (lower occurrence) is treated as land |
| Population | WorldPop R2025A (2025, constrained, alpha) | sum-resampled from 100 m; total conserved | ~470k people: constrained products count only mapped settlements, so likely low |
| Buildings | Google Open Buildings v3 (tile 103b) | confidence ≥ 0.8, area ≥ 25 m²; 68,929 footprints | **every building is 6 m tall** (no 2.5D heights yet); centroid cell only |
| Roads | OpenStreetMap (Geofabrik 2026-10-28) | simple graph, largest connected component; cells sampled ≤ ½ cell | unmapped or mis-tagged roads are missing; bridges come from tags |
| Drains | OpenStreetMap waterway=drain/ditch/canal | lines buffered 1 cell, 10 / 10 / 25 mm/h | sparse mapping; many real drains are silted, unmapped drains count as 0 |
| Shelters | OpenStreetMap schools / places of worship / community centres | higher half of land, ≤ 300 m from a road | **candidates, assumed**: not official shelters; routing skips a shelter whose cell is flooded |
| Places | OSM neighbourhoods, named roads, open land | polygons, or Voronoi cells of named points (≤ 1.5 km); ≤ 20 vertices | neighbourhood shapes are approximate, not official boundaries; protected sites never offered as open land |

Not in v1: an observed flood extent (Sentinel-1, planned as `-v2`) and building heights.

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
| Building depth | `sim/exposure.py` | Max over the 3×3 cells around the footprint (buildings sit on raised DSM cells); `buildings_flooded_own_cell` uses the building's own cell only |

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
- **Water stays too long after a storm:** closed hollows empty only by infiltration. There is no evaporation, no
  soakaways and no unmapped drains. Against the satellite scenes the visible excess is small (drain-down check below).
- **Two building counts:** `buildings_flooded` counts a building if any of the 3×3 cells around it reaches 0.15 m. On a
  30 m grid that means flood water within about 45 m, so read it as "buildings with flood water close by". Since
  contract 0.4.0, `buildings_flooded_own_cell` also counts only buildings whose own cell reaches 0.15 m. That count is
  stricter, and the DSM bias (building cells sit high) likely makes it an undercount. The truth is probably between
  the two, so a brief should give both. On Lagos at 120 mm / 3 h the counts are 30,202 and 13,314.

### Verification (synthetic tests, `tests/test_solver.py`)
| Check | Result |
|---|---|
| Mass balance, fixture AOI, 120 mm / 3 h | \|error\| < 0.001 % (gate: < 1 %) |
| Still water on a flat bed, and a lake at rest with dry islands | unchanged to 1e-6 m after 1 h |
| Wet-bed dam break (Stoker), front position at 30 s | −7 % (gate: within 10 %) |
| Interventions | drains, new drains, green and ponds never worsen impacts; a 1.5 m tide worsens them |
| Speed, 333 × 333 grid, 6 h simulated | 21 s, single thread (gate: < 60 s on 2 vCPU; `FT_PERF=1 pytest tests/test_solver.py`) |

### Lagos (`lagos-lekki-v1`, 540 × 324 cells) on the solver
3 h centre-peaked storm, 6 h simulated, on one desktop core with frames and stats included. On Cloud Run (2 vCPU,
scaled from zero) the first uncached run took 39 s at 118 mm and a cached result returns in about 0.2 s.

| Storm | Wall time | Mass balance | Buildings flooded, 3×3 / own cell (of 68,929) | Road km cut (of 1,406) | Max depth |
|---|---|---|---|---|---|
| 50 mm | 14 s | 0.0 % | 17,719 / 5,334 | 115 | 0.85 m |
| 120 mm | 22 s | 0.0 % | 30,202 / 13,314 | 407 | 2.15 m |
| 200 mm | 26 s | 0.0 % | 37,770 / 19,437 | 597 | 2.64 m |

The share of land that floods falls steadily with height: at 120 mm, 56 % of land at 1–2 m is wet, against 1 % above
8 m. The water collects in pools rather than scattered single cells (942 of 24,566 wet cells are in patches of 4
cells or fewer). The 0 m lagoon fringe does not drive the counts (506 of those wet cells).

### Validation against observations
- **Rainfall.** The validation storms use NASA GPM IMERG V07 half-hourly rain averaged over the AOI
  (`evals/validation/imerg.py`; the Late run, since the Final run for these dates is not out yet). The series are in
  `evals/validation/imerg_lagos_*.json`. 10 Jul 2026: about 56 mm between 04:00 and 15:30 UTC, peaking at 10.5 mm/h,
  then about 18 mm early on 11 Jul. 28 Jun: 34 mm, peaking at 14:00 UTC. IMERG agrees with ERA5 on the 10 Jul daily
  total (56.7 mm).
- **Sentinel-1 CSI: not computed.** Validation was attempted on 3 same-orbit Sentinel-1 RTC pairs between 28 Jun and
  12 Jul 2026 (Microsoft Planetary Computer; VV < −18 dB with a drop of more than 3 dB). The scenes show no
  open-water flooding on land at pass time: 0 to 6 cells, and at most 0.12 km² with relaxed thresholds. CSI
  against an empty observation would score every simulated wet cell as a false alarm and says nothing about the
  model. Likely reasons: the storms in this window were moderate, Lagos flash floods drain within hours, and C-band
  cannot see water between buildings. `evals/validation/csi.py` is ready for a scene that does show flooding.
- **Drain-down check** (`evals/validation/drain_down.py --series`): this check does use the empty observations. It
  drives the solver with the IMERG rain up to each pass and compares what the model still holds with the scene.
  "Open" means no building in the 3×3 neighbourhood, which is the only water C-band can see.

  | S1 pass (UTC) | IMERG rain so far | Model wet land (≥ 0.15 m) | Of which open | S1 observed |
  |---|---|---|---|---|
  | 28 Jun 18:02, about 4 h after a 34 mm storm | 34.6 mm | 0.68 km² | 0.03 km² | 0 |
  | 30 Jun 05:29 | 54.8 mm | 0.35 km² | 0.03 km² | 0.006 km² |
  | 12 Jul 05:29, 38 h after the 10 Jul storm | 82.9 mm | 1.48 km² | 0.11 km² | 0.004 km² (≤ 0.12 relaxed) |

  The model never puts more radar-visible water on the ground than the relaxed S1 bound, so the scenes do not
  contradict it. Most of what the model still holds lies among buildings, where these scenes say nothing. With a
  synthetic 57 mm / 6 h storm the 48 h remainder in the open was 0.17 km², so part of the earlier "holds water too
  long" signal came from the assumed storm, not the model. Water still drains only by infiltration and drains, and
  the check cannot test the peak extent, which drives the impact stats.
- **Reported flood locations** (`evals/validation/hotspots.py`, Eng D): 16 of 17 places named in Lagos press reports
  geocoded. At neighbourhood scale the model is consistent with the reports but does not single them out: lift
  about 1.0–1.2 over the same area's random discs, at every depth threshold. At road scale it does: on the 6 reported
  roads, the 90th-percentile depth is deeper than on 90 / 91.5 / 95 % of 200 random road samples at 50 / 80 / 120 mm.
  Six roads is a small sample, so this is suggestive, not conclusive.

### Surrogate (screening only)
`dryrun/surrogate/`: one LightGBM model per stat, trained on a Latin hypercube of real solver runs (rain
40–250 mm, duration 1–6 h, tide −0.5–1.5 m, drain factor 0.5–3, new drains 0–60 mm/h, green and pond on named
places). It is served as plain numpy. `surrogate_sweep` ranks intervention combinations with
`is_surrogate=True`. Its numbers have no `run_id`, so the claim verifier cannot accept them, and the agent must
confirm a candidate with `run_simulation`. Fixture AOI, 300 runs, 5-fold CV: R² 0.95 to 0.97 on all five targets
(flooded buildings MAE ≈ 21 of a baseline ≈ 200). It ranks well but over-predicts when impacts are small.
Lagos (`lagos-lekki-v1`, green on "Lekki Phase 1", pond on "Open land near Ajah"), 300 runs, 5-fold CV: R² 0.95 to 0.96
on all five targets (flooded buildings MAE ≈ 2,000, about 7 % of a typical 30,000). The pond polygon covers 4 building
cells, so pond candidates report a small `buildings_in_ponds`. Checked end to end at 120 mm / 3 h: the top three
candidates all cut flooded buildings from 30,202 to about 11,500 on the solver, so the ranking holds. Absolute errors
are large when impacts are small, though: it predicted 7,232 buildings where the solver gave 11,453, and 62 road km
where the solver gave 27. The direction of the error differs between AOIs. Only solver numbers are citable.

## Provenance

Everything in this repository was built for the hackathon and the git history is the record —
real timestamps, nothing backdated, no pre-existing codebase or product reused. The first commit
is the team's scaffold (data contracts, placeholder backends, deploy scripts), written from our
own feasibility plan on Oct 27 2026 with AI assistance, reviewed by the team, and committed the
next morning. Everything after it is day-by-day work by the four of us, with AI assistance noted
in the commit body where it did the bulk of the writing.
