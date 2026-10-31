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

Production deploys: Eng D runs `infra/scripts/deploy.sh` from a clean checkout of `main` after `ci` passes on that
commit. The GitHub `deploy` workflow is manual-only (see the note at the top of `.github/workflows/deploy.yml`).

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

### Queens, New York (`nyc-queens-v0`): Hurricane Ida, 1 Sep 2021
15 m grid (319 × 324 cells) on USGS 3DEP lidar (1/9″, first-quartile aggregation, NAVD88 → EGM2008), NYC
building footprints with roof heights, an outflow ring on every edge, and 13 mm/h of combined-sewer capacity on
all land (assumed). Rain from the gauges: LaGuardia 118 mm with a 56 mm/h peak hour, Central Park 7.13 in
(181 mm) with the record 3.15 in (80 mm) hour. Presets: 118 mm / 4 h centre-peaked (peak 59 mm/h), 181 mm /
4.5 h (peak 80 mm/h), both of those with the sewers full (no drainage: NYC sewers are designed for about 1.75 in/h
and Ida's peak hour was 3.15 in, so they surcharged), the peak hour alone (80 mm in 1 h, sewers full), the 181 mm
as a 5 km cell centred on Woodside, and the 118 mm storm with sewer capacity doubled. Each runs in 15–40 s;
mass balance 0.0 %. The demo hero is the 181 mm storm with the sewers full: the most street water (2.4 km²
deeper than 0.5 m) that is still tied to observed rain.

| Preset | Buildings with water close by | Flooded km² | Road km impassable | Max depth |
|---|---|---|---|---|
| Central Park rate, 181 mm, sewers full | 16,587 | 4.55 | 155 | 4.8 m |
| Peak hour 80 mm / 1 h, sewers full | 14,922 | 3.23 | 120 | 4.7 m |
| LaGuardia gauge, 118 mm | 12,531 | 2.24 | 92 | 4.5 m |
| Central Park rate, 181 mm | 15,171 | 3.67 | 132 | 4.7 m |
| 181 mm core over Woodside | 10,615 | 1.76 | 66 | 3.7 m |
| 118 mm, sewers ×2 | 9,113 | 1.07 | 44 | 2.3 m |

**Scored against 311 reports** (`evals/validation/nyc311_ida.py`). 350 flood-related 311 requests in the box
between 18:00 on 1 Sep and 06:00 on 2 Sep; 85 report water on the street (street flooding, catch basin, manhole),
265 sewer backup or basement water. A report is a hit when the run reaches 0.15 m within 30 m. Reports are
geocoded to street addresses, so the baseline is random road cells.

| Preset | Street reports hit (95 % CI) | Random road cells | Lift |
|---|---|---|---|
| Central Park rate, 181 mm, sewers full | 72 % (62–81 %) | 46 % | 1.6× |
| Peak hour 80 mm / 1 h, sewers full | 71 % (60–80 %) | 42 % | 1.7× |
| LaGuardia gauge, 118 mm | 64 % (53–74 %) | 36 % | 1.8× |
| Central Park rate, 181 mm | 71 % (60–80 %) | 43 % | 1.7× |
| 181 mm core over Woodside | 56 % (46–67 %) | 27 % | 2.1× |
| 118 mm, sewers ×2 | 49 % (39–61 %) | 25 % | 1.9× |

The model puts water where people reported it about twice as often as at random roads. A moving 5 km cell
(181 mm, 2 m/s over Elmhurst) was tried as a demo and floods less (0.18 km² deeper than 0.5 m): a narrow cell
drops much less water in total than its centre depth suggests. Sewer backup and
basement reports score a little lower (55 % at 118 mm, lift 1.6×); much of that water comes up through building
pipes, which the model does not represent. 311 cannot measure false alarms: a street with no report may still
have flooded. At 50 m every hit rate rises (74 % at 118 mm) but so does the baseline (53 %), so the lift falls
to 1.4×.

### Lagoon and sea level (`evals/validation/level_sensitivity.py`)
The water held at the lagoon/sea cells, re-run at −0.5 (default), +0.5, +1.0 and +1.5 m EGM2008 under each
coastal AOI's reference storm (`GET /api/aoi/{aoi_id}/level_sensitivity`):

| Level (m) | Lagos v2, 120 mm / 3 h: flooded km² | buildings | Queens, Ida (LaGuardia): flooded km² | buildings |
|---|---|---|---|---|
| −0.5 | 21.86 | 29,137 | 2.238 | 12,531 |
| +0.5 | 27.70 | 29,355 | 2.247 | 12,531 |
| +1.0 | 28.51 | 29,567 | 2.251 | 12,547 |
| +1.5 | 30.13 | 30,068 | 2.252 | 12,541 |

Lagos's lagoon fringe is low (14,667 land cells below 1.5 m), so a high lagoon adds 6–8 km² of flooding, mostly
open fringe with few buildings. Queens land is high (5th percentile 5.6 m), so sea level barely matters there;
Ida's flooding was rain, not surge.

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
- **Simulating only the rain area (contract 0.7.0):** `ScenarioSpec.domain = "rain_area"` solves only the bounding
  box of the cells that get at least 1 % of the storm depth, plus 1 km; the window's edge is open (water that
  reaches it leaves and is counted as outflow) and the result is padded back to the full grid. On Queens, a
  1.5 km cell over Woodside ran 2.4× faster (77 % of the grid) and matched the whole-grid run on 96 % of wet cells
  (0.03 km² less flooding, from flow paths cut at the window edge). A Gaussian cell's tail reaches 1.5 R, so cells
  wider than ~2 km on a 5 km AOI cover the whole grid anyway. Not available on river AOIs (the river comes from
  outside).

### Drains and sewers (`dryrun/sim/drainage.py`, contract 0.8.0)

AOIs published from 0.8.0 on (`lagos-lekki-v3`, `nyc-queens-v1`) carry a drain network instead of a fixed sink
(`dryrun/pipeline/drains.py`). Older AOIs keep the constant `drain_sink_mm_h`, and their run_ids are unchanged. The
drainage step runs after every surface step and moves water between the street and two kinds of storage:

- **Closed sewers (Queens).** Water enters only at the cells holding one of NYC DEP's 7,672 catch basins in the box,
  through the HEC-22 sag-inlet law: the smaller of a weir (Cw 1.66, perimeter 1.8 m) and an orifice (Co 0.67,
  0.18 m2), reduced by blockage. It fills one lumped sewer per zone. The 78 zones are Voronoi catchments of the CSO
  and storm outfalls cut into 500 m tiles, because NYC does not publish its sewersheds. Each zone empties through its
  outfall at up to capacity x 0.85 (runoff) x area. The default is the pre-1973 Queens standard of 1.5 in/h
  (38.1 mm/h); 44.5 and 54.1 mm/h are offered as the 5- and 10-year designs. Pipe storage is 12 mm over the zone.
  The receiving water (the tide setting) cuts the outflow, and flap gates stop it running back in. A full zone
  still takes water at inlets 1 m or more above its lowest one and pushes it out at its lowest inlets.
- **Open drains with covered sections (Lagos).** There is one channel node per 30 m cell. The 22.5 km of open
  drains, 16.7 km of ditches, 2.1 km of culverts and the canals and streams come from OpenStreetMap. A drain is also
  inferred along every drivable road, because OSM maps only 2-3 % of them. Water enters along the open banks
  (lateral weir Cw 1.60), or through a grate every 15 m on covered sections. It flows along the network by the same
  local-inertial law as the surface, with Manning n 0.015 for concrete and 0.035-0.04 for earth. It leaves at the
  117 points where a drain meets open water, against the lagoon level and with no flap gates, and overflows onto
  the street where a drain runs full. All drain sizes are assumptions, because no survey of Lekki drains is
  public: a 0.9 x 0.9 m U-drain, two 0.6 x 0.6 m roadside drains, a 6 x 2.5 m canal. Tidal channels start filled
  to the lagoon level.

Scenario controls (`ScenarioSpec.drainage`): system closed / open / mixed, capacity in mm/h or a design return
period, blockage 0-90 %, outfall tide / free / blocked, flap gates, and inferred roadside drains. Every run reports
captured, overflow, outfall and stored volumes, peak fill, the time the system filled, the overflow window, the fill
of every drain line and zone per frame (`drain_fill.json`), and the limits that apply.

Measured on the drainage AOIs (local machine, solver, mass balance 0.0 % in every run; Queens runs 8 h):

| Scenario | Fixed sink (v2 / v0) | Drain model (v3 / v1) | Runtime |
|---|---|---|---|
| Lagos 120 mm / 3 h | 21.86 km2, 29,137 buildings | 21.08 km2, 26,114 buildings (blockage 0 %: 20.70, 70 %: 21.91) | 22.2 s -> 31.3 s |
| Lagos 120 mm / 3 h, lagoon +0.5 m | | 26.91 km2 (the drains are tide-locked) | 34.7 s |
| Queens Ida peak hour 80 mm | 2.62 km2 | 1.85 km2; sewers 66 % full, overflow 0:40-2:00 | 23.6 s -> 22.5 s |
| Queens 80 mm, outfalls blocked | | 2.72 km2; full after 51 min | 24.7 s |
| Queens 44.5 mm / 1 h (5-year design storm) | 1.07 km2 | 0.97 km2 | 13.9 s -> 15.7 s |
| Queens Ida, Central Park rate (hero) | 4.55 km2 (sink off) | 4.13 km2 (outfalls blocked); 2.99 km2 (catch basins half clogged) | 36.1 s -> 36.1 s |

The open network costs about 2 x (channel nodes / cells) extra run time (`speed.DRAIN_CHANNEL_COST`). Closed zones
cost nothing measurable.

#### Validation (`evals/validation/drainage.py`)

Hurricane Ida, 181 mm / 4.5 h centre-peaked (Central Park rate), Queens. Street hit = share of the 85 street-flooding
311 reports with water within 30 m, lift = over random road cells. Backup lift = share of sewer-backup and basement
reports inside a zone the run filled (>= 95 %), over the share of road cells inside one.

| Case | Flooded | Street hit (95 % CI) | Street lift | Zones full | Backup lift |
|---|---|---|---|---|---|
| Fixed sink 13 mm/h (v0) | 3.67 km2 | 70.6 % (60-80) | 1.65 | | |
| Fixed sink, sewers off (v0 hero) | 4.55 km2 | 71.8 % (62-81) | 1.55 | | |
| Sewers 1.5 in/h (v1 default) | 2.70 km2 | 65.9 % (56-77) | 1.73 | 46 / 78 | 1.47 |
| Sewers 1.75 in/h (5-year) | 2.56 km2 | 64.7 % (54-75) | 1.73 | 42 / 78 | 1.49 |
| Sewers 0.75 in/h (half) | 3.34 km2 | 69.4 % (59-79) | 1.67 | 70 / 78 | 1.06 |
| Sewers, outfalls blocked | 4.13 km2 | 71.8 % (62-81) | 1.64 | 78 / 78 | 1.00 |
| Sewers, catch basins 50 % clogged | 2.99 km2 | 68.2 % (58-79) | 1.69 | 38 / 78 | 1.54 |

The sewer model finds the reported streets at least as well per road cell (lift 1.73 against 1.65) while flooding a
quarter less area, and the zones it fills hold 1.5 x their share of the sewer-backup reports. When every zone is
full (outfalls blocked, half capacity) the backup signal disappears, as it must. All street hit rates overlap
within their 95 % intervals: 85 reports cannot separate these cases.

Against the NYC DEP Stormwater Flood Map "Moderate, current sea level" (2.13 in/h for 1 h; wet = 0.10 m or more on
land), the fixed sink catches 61 % of DEP's flooded cells (CSI 0.113) and the sewer model 40 % (CSI 0.087). 87 % of
DEP's flooding is on roads, in street sags that DEP's pipe-by-pipe model fills from surcharging manholes. Lumped zones
spread a zone's surcharge over its lowest inlets, so they miss many of those sags. Finer zones help: 300 m tiles
(235 zones) reach 47 % (CSI 0.097) and a street hit of 68 %, but drop the backup lift to 1.36, so 500 m is kept.

Lagos: the 6 mm/h built-up loss in v2 stood in for unmapped drains. Refitted on the Sentinel-1 drain-down of 12 July
with the drain network in place (rates 2 / 3 / 4 / 6 mm/h leave 1.43 / 0.64 / 0.26 / 0.08 km2 of land wet against
the observed near-zero), it still needs 6 mm/h: the drains carry street water away, but they do not empty the
closed pits and yards that the built-up loss represents. v3 keeps 6 mm/h.

Limits: lumped sewers have no pipes, manholes or basements, so no single overflowing inlet can be named, and they
cannot reproduce DEP's street-sag flooding cell by cell. Roof leaders are not modelled: in Queens, roofs drain
straight into the sewer, so rain on buildings and yards ponds on the surface here in the design storm, where the city
expects none. Lagos drain sizes and blockage are scenario settings, not measurements, so read Lagos as relative
susceptibility, not absolute depth. In OpenStreetMap no Lekki canal or stream reaches the lagoon: the mapped canals
stop 0.5-0.9 km short, so they drain through roadside drains. All 117 outfalls are roadside drains (115) or ditches
(2), and Lagos's default capacity (2.7 mm/h) is their combined full-bank discharge, about 80 m3/s, over the 106 km2 of
land. It is an outlet capacity, not a design standard like Queens' 1.5 in/h, and it does not bind: in the 120 mm / 3 h
baseline the outfalls average about 10 m3/s, because the flat, tide-backed network fills first. No canal links are
invented to close the gap.

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
  a steady 2D run). The side pressure follows interFoam's own discrete hydrostatic balance (the textbook formula
  is ~270 Pa off in the waterline cell), and dry 2D cells hold no water level. An 8 m damping band along the
  sides relaxes velocity to rest over 20 s. Without it, an open side kept feeding energy into the box: still
  ponds in a Queens patch reached the 5 m/s speed cap within 5 minutes (they stayed below 0.2 m/s with the sides
  closed). With it, those ponds stay below 0.2 m/s (99th percentile 0.04 m/s) and match the 2D volume to 0.1 %.
  Buildings that reach into the band get no force.
- **Test (Lagos v2, 120 mm, 100 m box at 2 m, 25,565 cells, 3 CPU cores, about 8 minutes for 10 minutes of
  flow):** after a 2-minute spin-up the 3D water volume holds steady at 23 % below the 2D run's (1,480–1,590 m³
  against ~1,970 m³), and the water fraction stays bounded. The gap barely moves with bed roughness (−24 % at
  Manning n 0.03), so it comes from the nesting and the 2 m terrain, not from friction: the 3D box drains to a
  lower level than the 30 m 2D cells hold. Water speeds: median 0.27 m/s, 99th percentile 1.1 m/s, maximum 1.4 m/s
  (before the damping band: median 0.55 m/s, 99th percentile 2–3 m/s); the volume gap is the same with the band.
- **Outputs** (`/api/runs/{run_id}/patch3d`): a water-surface depth PNG and a velocity PNG (surface and mid-depth
  u, v) every 30 s, and the net horizontal force on each building from its
  wall pressures (shear is not included). The manifest records the cell count and the 3D and 2D water volume
  per frame.
- **Limits:** RANS with wall functions on 0.25–2 m cells, so wakes and near-wall shear are approximate and
  vertical velocity profiles are indicative. Cell speeds are capped at 5 m/s (flood water here moves under
  2 m/s); after the damping band only a few air cells reach it. The sides carry levels only, so water entering
  the box starts without the momentum it had in the 2D run, and the band damps flow within 8 m of the sides;
  keep the area of interest away from them. The 3D patch does
  not feed back into the 2D run.
- **Cost:** solves take minutes to hours on CPUs, so the API never solves inside a request. Showcase patches are
  precomputed; `POST /api/runs/{run_id}/patch3d` returns a stored patch to anyone. Queueing a new one (and starting
  the `DRYRUN_PATCH3D_JOB` Cloud Run Job when one is configured) needs the team token or a judge key and is capped
  per day (`DRYRUN_PATCH3D_PER_DAY`, default 20).

### In-browser 3D close-up (`web/src/lib/patch3d-gpu/`, WebGPU)
The same close-up can be solved on the viewer's own GPU, for any box, with no server compute. `GET
/api/runs/{run_id}/patch3d_inputs?lon=&lat=&size_m=&cell_m=` packs what the OpenFOAM case writer uses: the box
geometry, the 2D side levels every 30 s, the initial state and the 2D volume series (`dryrun/patch3d/inputs.py`;
`dims_only=1` returns just the grid). Boxes may be 60–500 m with cells of 0.5–4 m. The browser solves the same
window and returns the OpenFOAM patch's outputs in the same encoding: frame PNGs every 30 s, the manifest, and
buildings.json. The close-up viewer plays them unchanged.
- **Method:** water only, on a uniform staggered grid with cells of `cell_m` × `cell_m` × `cell_m`/8, with air
  as empty space.
  - The water fraction is advected with the conservative, bounded split scheme of Weymouth & Yue (2010). Each
    column is then restacked from its floor, so the free surface is single-valued (no overturning).
  - Pressure is the hydrostatic part from the water above, plus a non-hydrostatic part from a projection. The
    projection uses red-black vertical-line SOR, which handles the 8:1 cell shape exactly; 4 sweeps per step
    give the same answer as 30.
  - Momentum is advected semi-Lagrangian.
  - Bed and wall friction use the rough-wall log law (the OpenFOAM patch's ks), with a parabolic eddy viscosity
    in each column.
  - The sides are the same as the OpenFOAM patch: the 2D level held on the outer ring, the 8 m damping band,
    and the 5 m/s cap.
- **Accuracy against the OpenFOAM patch** (same box, 100 m at 2 m, 10 min, columns outside the damping band):

  | patch | depth error (mean abs.) | wet/dry agreement | surface speed median / p90 (OpenFOAM) | speed correlation | building peak force |
  |---|---|---|---|---|---|
  | Queens Elmhurst (still pond, 1.27 m deep) | 2–4 mm | 100 % | 0.03 / 0.04 m/s (0.02 / 0.03) | 0.5–0.67 | 44.1 kN (44.3) |
  | Lagos hero (street sheet flow, 0.21 m) | 4 cm (+4 cm bias) | 100 % | 0.36 / 0.74 m/s (0.37 / 0.81) | 0.80 | 17.3 and 10.6 kN (17.4 and 9.6); a small one 2.8 kN (1.3) |

  The browser solve keeps more water in the Lagos box than OpenFOAM does: −9 % of the 2D volume against −24 %.
- **Speed and memory** (AMD RX 6800 through Dawn; 13 floats per cell):

  | box / cell | cells | GPU memory | time per 30 s frame | 10-min window |
  |---|---|---|---|---|
  | 100 m / 2 m | 40 k | 3 MB | 0.15 s | 3 s |
  | 200 m / 1 m | 1.6 M | 85 MB | 0.9 s | 18 s |
  | 300 m / 1 m | 4.7 M | 240 MB | 2.5 s | 50 s |
  | 300 m / 0.5 m | 37 M | 1.9 GB | 71 s | 24 min |
  | 400 m / 0.5 m | 72 M | 3.6 GB | 140 s | 47 min |

  Largest box (m) that fits, for a vertical span of 4 m (relief plus water; Lagos and Queens):

  | cell | 512 MB | 1 GB | 2 GB | 4 GB |
  |---|---|---|---|---|
  | 0.5 m | 150 | 210 | 300 | 430 |
  | 1 m | 430 | 500 | 500 | 500 |
  | 2 m and up | 500 | 500 | 500 | 500 |

  For an 8 m span (hilly ground) the 0.5 m sizes are 110, 160, 230 and 330 m, and 1 m reaches 330 m at 512 MB.
  `memory.ts` (`fits`, `largestBox`) gives the same numbers for any grid.
- **Limits:** the surface is single-valued in each column, so plunging jets and overturning are not modelled.
  Each GPU submission is kept to about 0.25 s, because browsers reset a GPU that is busy for seconds. A laptop
  GPU is several times slower than the RX 6800.

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
Lagos (`lagos-lekki-v3`, drain network, green on "Lekki Phase 1", pond on "Open land near Ajah"), 300 runs, 5-fold CV:
R² 0.95 to 0.96 on all five targets (flooded buildings MAE ≈ 1,900, about 7 % of a typical 26,000). On v3 the drain
factor scales the effective width of the drains and canals (their conveyance and storage), and new drains add a sink
on top. Checked end to
end at 120 mm / 3 h: the top three candidates (drains x3 with new drains and green; the same plus the pond; drains x3
with new drains) cut flooded buildings from 26,114 to 4,538, 4,532 and 4,914 on the solver, so the ranking holds. It
predicted 23,488 for the baseline and 5,041 for the top candidate: absolute errors stay around 10 % here, larger when
impacts are small. The pond polygon covers 4 building cells, so pond candidates report a small `buildings_in_ponds`.
Only solver numbers are citable.

### Before/after pictures (`dryrun/meta/render.py`, Muse Image)

`POST /api/render` takes two runs of the same storm (`base_run_id`, `alt_run_id`) and a street spot, and returns a
ground-level picture of that spot in each run, labelled in the image as "AI illustration, not a measurement" with
the run's depth. Each picture is asked for that run's peak water depth in the spot's grid cell (a cell average:
31 m in Lagos, 15 m in Queens). The changes between the two runs that cover the spot are drawn, such as a rain
garden, a rebuilt drain or catch basins welling up. Changes elsewhere are listed but not drawn. With no photo, the
street is generated from the map layers (place, road, building density, nearby drains), so it is a typical street
there, not a photo of the spot. An uploaded photo is used instead when given. Uploads go through the paid path only:
the photo is decoded, capped, stripped of EXIF and GPS, and every person SAM 3.1 finds is blurred before it is stored
(private) or sent to the image model. If the check fails, the photo is not used.

How the pictures are made, and why:
- Meta's content filter refuses most edits that add deep water to a picture. It passes text-to-image at the same
  depth, and edits that take water away. So the deeper picture is generated from text, and the other picture is an
  edit of it with less water. Starting both from one picture keeps the camera and buildings the same.
- Muse Image draws less water than asked: at 57-80 cm it draws about 25-35 cm. Muse Spark vision (the citizen-photo
  depth estimator) reads each finished picture. The result reports `picture_depth_m` beside the run's `depth_m`, and
  a note says when they disagree. The run's number is always written on the picture.
- Pictures are cached by `render_id` (the runs, the grid cell, the view, the photo and the provider). A replay, or a
  second click in the same cell, costs nothing and needs no key. Identical requests in flight share one render. A new render makes two image calls and two vision
  calls, so it needs the judge or team key, counts against the per-IP cap (20/h) and the daily cap
  (`DRYRUN_RENDER_PER_DAY`, 100), and takes about 50-90 s (49-74 s locally, 89 s on Cloud Run). `provider: "fake"`
  draws offline placeholders for UI work.

## Provenance

Everything in this repository was built for the hackathon and the git history is the record —
real timestamps, nothing backdated, no pre-existing codebase or product reused. The first commit
is the team's scaffold (data contracts, placeholder backends, deploy scripts), written from our
own feasibility plan on Oct 27 2026 with AI assistance, reviewed by the team, and committed the
next morning. Everything after it is day-by-day work by the four of us, with AI assistance noted
in the commit body where it did the bulk of the writing.

The map interaction and layout borrow ideas from FireTrace (interaction and layout ideas only; no code,
assets or data from it are used).
