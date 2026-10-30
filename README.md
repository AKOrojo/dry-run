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
| Muse Spark Open (Baseten; OpenRouter fallback) | "Sovereign mode": same agent on open weights |
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
- **Constant tide, fixed rates:** no tidal cycle or soil saturation. Rain is uniform by default; since contract 0.6.0
  a storm can be a cell, a moving cell or a polygon (see "Where the rain falls" below), but observed events use one
  AOI-mean IMERG series, which has no detail inside the AOI.
- **Local-inertial physics:** no advection term. It is accurate for slow, deep floodplain flow and runs slightly slow for
  fast fronts (dam-break test below).
- **Water stays too long after a storm:** closed hollows empty only by infiltration. There is no evaporation, no
  soakaways and no unmapped drains. Against the satellite scenes the visible excess is small (drain-down check below).
  `evals/validation/pits.py` shows where it sits: the DEM's closed depressions (priority-flood fill to the lagoon, sea
  and grid edge) cover 21 km² of land at ≥ 0.15 m and could hold 147 mm over all land. At the 12 Jul pass, **96.5 % of
  the land the model still has wet (1.42 of 1.48 km²) is in such depressions** (median depth 0.49 m), so the excess is
  water that cannot drain overland, not slow flow.
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

### Lagos (`lagos-lekki-v2`, 540 × 324 cells) on the solver
3 h centre-peaked storm, 6 h simulated, on one desktop core with frames and stats included. On Cloud Run (2 vCPU,
scaled from zero) the first uncached run took 39 s at 118 mm and a cached result returns in about 0.2 s.

| Storm | Wall time | Mass balance | Buildings flooded, 3×3 / own cell (of 68,929) | Road km cut (of 1,406) | Max depth |
|---|---|---|---|---|---|
| 50 mm | 14 s | 0.0 % | 15,103 / 4,037 | 66 | 0.78 m |
| 120 mm | 22 s | 0.0 % | 29,137 / 12,420 | 385 | 2.05 m |
| 200 mm | 26 s | 0.0 % | 37,163 / 18,895 | 585 | 2.59 m |

v2 differs from v1 only in the built-up loss rate (2 → 6 mm/h, calibrated below). v1 gave 17,719 / 30,202 / 37,770
buildings and 115 / 407 / 597 road km at the same storms: the calibration matters most for small storms.

**Built-up loss calibration (`lagos-lekki-v2`, `evals/validation/calibrate_builtup.py`).** One parameter, the loss on
built-up cells (WorldCover 50, about half the land), fitted to the Sentinel-1 drain-down (calibration, not
validation). Lekki stands on coastal sand, compounds drain to soakaways and many drains are unmapped, so 2 mm/h
(v1, assumed) was a guess.

| Built-up loss | Wet land at the 12 Jul pass | Of which open | 120 mm preset: flooded km² / buildings |
|---|---|---|---|
| 2 mm/h (v1) | 1.48 km² | 0.11 km² | 23.2 / 30,202 |
| **6 mm/h (v2)** | **0.06 km²** | 0.06 km² | 21.9 / 29,137 |
| 10 mm/h | 0.06 km² | 0.06 km² | 20.6 / 28,019 |
| 15 mm/h | 0.06 km² | 0.06 km² | 18.9 / 26,442 |

6 mm/h is the lowest rate that drains the closed depressions by the pass; higher rates gain nothing against the scene
and only shrink the flood. The 0.06 km² left is open, non-built ground (wetland, grass), still under S1's relaxed
bound of 0.12 km². IMERG underestimates intense rain, so the true rain was likely larger and 6 mm/h is a lower bound
on the loss.

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
- **Press-reported places on v2:** at 120 mm / 3 h the reported roads' 90th-percentile depth beats 93.5 % of random
  road samples (95 % on v1); at 50 mm, 80 % (90 % on v1). Driving the model with the observed IMERG rain for 28 Jun –
  4 Jul 2026 (117 mm in a week, peak 6 mm/h as an AOI mean; `evals/validation/event_hotspots.py`) floods none of the
  15 reported places on either version: IMERG's 11 km, 30 min average flattens the convective bursts that flooded
  them, so the event replay cannot score the model.
- **Reported flood locations** (`evals/validation/hotspots.py`, Eng D): 16 of 17 places named in Lagos press reports
  geocoded. At neighbourhood scale the model is consistent with the reports but does not single them out: lift
  about 1.0–1.2 over the same area's random discs, at every depth threshold. At road scale it does: on the 6 reported
  roads, the 90th-percentile depth is deeper than on 90 / 91.5 / 95 % of 200 random road samples at 50 / 80 / 120 mm.
  Six roads is a small sample, so this is suggestive, not conclusive.

### Texas Guadalupe (`texas-guadalupe-v0`): 4 Jul 2025 replay
An inland river AOI from Hunt to Kerrville, including Camp Mystic, on a 2″ grid (486 × 198, ~55 × 61 m). A 1″
grid would force ~1.6 s steps in 15 m deep water, at about 5 min per run; 2″ runs in ~12 s. The river enters as
**USGS gauge inflows** (`pipeline/inflows.py`, `evals/scenarios/texas_inflows.json`) from 06:00 UTC: the North
Fork (08165300), Johnson Creek (08166000), and the **South Fork, which is ungauged** and is estimated as Hunt
(08165500) minus North Fork. Gauges downstream of an entry are read earlier by river distance ÷ 2.85 m/s (the
observed Hunt → Kerrville travel). The South Fork carried the main pulse (peak ≈ 8,200 m³/s), so the most important
input is also the least certain one. Rain on the valley is the scenario storm; IMERG Final gives 85 mm over the 12 h.

Inland layer rules (`build_layers`, behind `outlet_side`): no sea boundary; the river leaves through a free-outflow
outlet on the east edge; river cells are carved so each runs downhill to the outlet (at 2″ the canyon averages into
10–28 m ridges across the bed) and get Manning n 0.035 (natural channel) instead of tree cover's 0.1. None of these
values was fitted to the gauges.

**Timing check** (`evals/validation/gauge_timing.py`): the flood front, i.e. the first time the model depth reaches
half its maximum, against the first time the observed discharge reaches half its peak. Model crests are broad and
flat, so peak times are not compared.

| Gauge | Model front (UTC) | Observed | Error |
|---|---|---|---|
| Guadalupe at Hunt | 09:20 | 09:41 | −22 min |
| Guadalupe at Kerrville | 10:45 | 11:14 | −29 min |
| Hunt → Kerrville travel | 85 min | 93 min | −9 % |

Mass balance 0.0 %. **Depths run high:** the model's maximum is 12–14 m at the gauges, against observed stage rises
of ≥ 9.1 m at Hunt (the gauge failed at the crest) and 11.3 m at Kerrville. Likely causes are the 2″ grid narrowing
the effective channel and floodplain storage being under-represented. The replay is a plausible reconstruction, not a
calibrated forecast. Shelters are candidates at least 15 m above the nearest river cell (observed rise 11.3 m plus
margin); all stayed dry in the replay. Impact (12 h, river plus 85 mm rain): 1,863 buildings with flood water close by
(1,063 by own cell), 1,067 people, 115 road km. With the river alone it is 1,743 buildings, so the river dominates.

**Scored against observations** (`evals/validation/texas_hwm.py`). Both references come from one observation set:
FIMbench's extent is interpolated from the same high-water marks, and USGS rebuilt the Hunt peak flow (one of our
inputs) from them after the gauge failed. So these are not independent tests.
- **Flood extent vs FIMbench** (University of Alabama / CIROH, CC-BY-4.0, doi:10.5281/zenodo.22961099). The 10 m
  flooded/dry map is aggregated to model cells (flooded if at least half the cell is) and scored inside its own
  boundary: 81,861 cells, 4,581 observed flooded. At a 0.15 m model threshold, **CSI 0.71, POD 0.87, FAR 0.21**,
  bias 1.10, and it barely moves between 0.05 and 0.3 m.
- **Water level at USGS high-water marks** (STN event 357, 224 marks in the AOI, NAVD88 converted to EGM2008 with
  PROJ, +1.02 m). For the 151 marks rated Excellent, Good or Fair, the highest model water surface in the 3×3 cells
  around each mark is **+1.7 m high at the median** (mean +3.2 m, RMSE 4.8 m, n = 145). The model is dry at 6
  marks. On the 43 marks that record the water depth there, the model is +0.8 m deeper at the median (observed
  median 1.2 m). The extent is right and the levels run high, as the gauge depths already suggested.

**Channel depth and roughness sensitivity** (`evals/validation/calibrate_channel.py`). Lowering every river cell by
0–10 m and scaling the channel Manning n by 0.6–1.0 moves the median water-surface error at the marks only from
+1.67 m to +1.28 m at best, while extent skill falls (CSI 0.71 to 0.64) and more marks go dry (6 to 18). So the
channel shape is not the main cause of the high levels, and the published replay keeps the v0 channel unchanged.
More likely causes are the estimated South Fork inflow (Hunt minus North Fork, the largest and least certain input)
and floodplain storage the 2″ grid cannot resolve. The gauge-rise comparison was dropped: the channel starts dry, so
the model has no pre-event level to measure a rise from.

### Where the rain falls (contract 0.6.0)
`Storm.spatial` sets the footprint; `null` keeps rain on the whole area. Every option builds one rain field on the
grid, as TUFLOW, HEC-RAS 2D and LISFLOOD-FP do with rainfall grids (report: `docs/` research, not in the repo).
- **Cell:** a centre (or a place's centroid) and radius R. Intensity falls with distance d as exp(−2(d/R)²)
  (Gaussian), exp(−2d/R) (exponential) or 1 inside R (flat). `total_mm` is the point depth at the centre, so the
  area average is lower. Defaults: R = 5 km, range 1–15 km (radar convective cells are about 35–90 km²).
- **Moving cell:** the cell's centre travels in a straight line (heading, 0–20 m/s; West African squall lines move
  about 11–18 m/s westward) and passes over the given centre when the rain is heaviest (the start for
  `front_loaded`, mid-storm otherwise), so the storm's peak falls where the user put it. The field is refreshed every 60 s and the solver never steps across a refresh. A fast
  cell leaves much less rain at any point than its centre depth.
- **Polygon or place:** uniform depth inside, none outside.
- **Mass balance:** `rain_generated_m3` (the whole storm), `rain_in_aoi_m3` (inside the grid) and `rain_volume_m3`
  (applied to land). Rain outside the grid is not simulated. On a river AOI, rain upstream of the grid is also not
  routed in; the gauge inflows carry the historical event. `POST /api/aoi/{aoi_id}/rain_field` previews the storm
  total per cell and warns above 100 mm/h peak intensity (measured 1-hour extremes: 133–153 mm/h in Texas, July
  2025) or when more than 25 % of the rain falls outside the grid.
- The intensity profiles, radius range and track speeds come from radar studies elsewhere and the Texas event;
  there are no measured sub-hourly cell sizes or intensities for Lagos.

### Close-up 3D flow (`dryrun/patch3d/`, contract 0.6.0)
The city-scale run stays 2D (depth-averaged); a full 3D solve of a city is days of compute per scenario. For a
close-up, a 60–300 m box can be re-solved in 3D with OpenFOAM v2406 `interFoam` (two-phase VOF, k-ω SST), nested
one way in a finished 2D run:
- **Mesh:** hex cells of `cell_m` (1–4 m) horizontally and `cell_m`/8 vertically; ground and buildings (the AOI's
  footprints and heights) are cut out with `subsetMesh`, so they are stair-stepped walls. Walls are rough
  (wall functions, Ks ≈ 0.017 m from a bare urban surface, Manning n 0.02): the 2D run's built-up n of 0.05
  includes building drag, which the 3D mesh resolves. A laminar first version had almost no bed resistance;
  water ran down the 2D surface slope at 5 m/s and the box sloshed (volume −20 % to +52 % of the 2D run).
- **Sides:** every side holds the 2D water level over time (hydrostatic pressure); the velocity follows from
  that pressure, water enters with the 2D water fraction and leaves with its own. The top is open air. We do
  not impose the 2D velocity on the sides: ours is estimated from the 2D water-surface slope, not solved, and
  imposing it added water faster than the other sides let it out (the box gained 120 % in 10 minutes against
  a steady 2D run).
- **Test (Lagos v2, 120 mm, 100 m box at 2 m, 25,565 cells, 3 CPU cores, about 8 minutes for 10 minutes of
  flow):** after a 2-minute spin-up the 3D water volume holds steady at 23 % below the 2D run's (1,480–1,590 m³
  against ~1,970 m³), and the water fraction stays bounded. The gap barely moves with bed roughness (−24 % at
  Manning n 0.03), so it comes from the nesting and the 2 m terrain, not from friction: the 3D box drains to a
  lower level than the 30 m 2D cells hold. Water speeds: median 0.55 m/s, 99th percentile 2–3 m/s.
- **Outputs** (`/api/runs/{run_id}/patch3d`): a water-surface depth PNG and a velocity PNG (surface and mid-depth
  u, v) every 30 s, and the net horizontal force on each building from its
  wall pressures (shear is not included). The manifest records the cell count and the 3D and 2D water volume
  per frame.
- **Limits:** RANS with wall functions on 0.25–2 m cells, so wakes and near-wall shear are approximate and
  vertical velocity profiles are indicative. The side pressure drives spurious air currents in a few cells (in
  corners and just above the water at the sides); cell speeds are capped at 5 m/s (flood water here moves
  under 2 m/s), so these currents cannot grow, but the capped air speeds are not physical. The sides carry levels only, so water entering the box starts
  without the momentum it had in the 2D run; keep the area of interest away from the sides. The 3D patch does
  not feed back into the 2D run.
- **Cost:** solves take minutes to hours on CPUs, so the API never solves inside a request. Showcase patches are
  precomputed; `POST /api/runs/{run_id}/patch3d` returns a stored patch to anyone. Queueing a new one (and starting
  the `DRYRUN_PATCH3D_JOB` Cloud Run Job when one is configured) needs the team token or a judge key and is capped
  per day (`DRYRUN_PATCH3D_PER_DAY`, default 20).

### The 3D map: model ground vs the terrain it is drawn on
The solver's DEM uses EGM2008 heights; Cesium World Terrain uses ellipsoid heights. The geoid offset N is +22.0 to
+22.6 m over Lagos and −23.3 to −22.9 m over Texas. `evals/validation/terrain_match.py` decodes the World Terrain mesh
(level 13) over each AOI and compares it with DEM + N at every vertex (positive means the model ground is higher):

| AOI | Vertices | Median | \|diff\| p50 | \|diff\| p90 |
|---|---|---|---|---|
| Lagos | 29,814 | −1.1 m | 2.1 m | 6.1 m |
| Texas, land | 11,828 | +0.9 m | 5.4 m | 14.6 m |
| Texas, river cells | 1,653 | +8.1 m | 8.3 m | 13.9 m |

So a 3D water surface at model ground + depth would float or sink by metres against the visible terrain, and along the
Guadalupe it would sit about 8 m above the drawn river. Depth frames are therefore **draped** on the terrain: each pixel
shows the model's depth at that place, whatever height the map draws there. Building bases come from the drawn
terrain, not the DEM. The 8 m in the river channel matches the coarse grid problem above: at 2″ the canyon floor
averages up toward its walls.

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

The map interaction and layout borrow ideas from FireTrace (interaction and layout ideas only; no code,
assets or data from it are used).
