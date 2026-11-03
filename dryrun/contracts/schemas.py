"""Shared data contracts for Dry Run.

THIS FILE IS THE SOURCE OF TRUTH between all four workstreams.
- Changes need a PR approved by at least one engineer from another workstream
  (see .github/CODEOWNERS). Bump CONTRACT_VERSION on any breaking change.
- `make contracts` exports JSON Schema to contracts/jsonschema/ and TypeScript
  types to web/src/contracts/ (Eng B consumes those, never hand-edits them).

Coordinate conventions (everyone):
- ONE CRS everywhere: WGS84 lon/lat (EPSG:4326). AOI rasters are a regular lon/lat grid whose
  cell steps are chosen so cells are ~30 m x 30 m (at Lagos, 6.45 N, the two steps differ by <1%).
  This keeps bounds_wgs84 an exact rectangle, so Cesium overlays, /depth lookups and polygon
  masks line up with no reprojection. The solver uses dx_m/dy_m for physics.
- Raster arrays are row-major [row, col], row 0 = NORTH edge (GeoTIFF convention).
- Depth in metres (float32) internally; frames for display are RGBA PNGs.
- Time in the simulation = seconds since storm start (int). Wall-clock is irrelevant.
"""

from __future__ import annotations

import hashlib
import json
from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = "0.8.0"


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --------------------------------------------------------------------------- AOI
class GridSpec(_Base):
    """Describes every raster in an AOI. All AOI rasters share this grid exactly."""

    crs: Literal["EPSG:4326"] = "EPSG:4326"
    cell_size_m: float = Field(gt=0, examples=[30.0], description="nominal cell size (= sqrt(dx_m*dy_m))")
    dx_m: float = Field(gt=0, description="east-west cell size in metres")
    dy_m: float = Field(gt=0, description="north-south cell size in metres")
    nx: int = Field(gt=0, description="columns")
    ny: int = Field(gt=0, description="rows")
    bounds_wgs84: tuple[float, float, float, float] = Field(
        description="west, south, east, north in degrees; used by the UI to place frames"
    )


class AOIManifest(_Base):
    """Written by the data pipeline (Eng D) to gs://<data-bucket>/aoi/<aoi_id>/manifest.json."""

    contract_version: str = CONTRACT_VERSION
    aoi_id: str = Field(examples=["lagos-lekki-v1", "fixture-synthetic"])
    name: str
    grid: GridSpec
    layers: dict[str, str] = Field(
        description=(
            "Layer name -> path relative to the AOI folder. Required keys: dem, manning, "
            "infiltration_mm_h, drain_sink_mm_h, buildings, roads_graph, population, shelters. "
            "Rasters: float32 .npy on the AOI grid (the serving image has no rasterio/pandas; keep "
            ".tif/.parquet copies alongside only for QGIS/offline work). "
            "Optional: buildings_geojson (UI), places (agent geography; Polygon features only, <= 20 vertices), "
            "obs_flood_extent (Sentinel-1), inflows (inland AOIs: river gauge hydrographs, see pipeline/inflows.py), "
            "drainage (AOIs with drainage_default): drain_network, inlets_count, sewer_zones, drains_geojson."
        )
    )
    sources: dict[str, str] = Field(description="Layer name -> attribution / licence string")
    is_synthetic: bool = False
    photoreal_buildings: bool = Field(False, description="Google Photorealistic 3D Tiles have real (photogrammetric) "
                                      "buildings here: the UI hides its own extrusions and draws only flooded ones "
                                      "(added in 0.6.0)")
    drainage_default: DrainageDefault | None = Field(
        None, description="the drainage system this AOI models when a scenario turns drainage on (or leaves "
                          "ScenarioSpec.drainage unset on an AOI that has this). None = the constant drain_sink_mm_h "
                          "only (AOIs published before 0.8.0). Added in 0.8.0")


# AOI ids are IMMUTABLE: never overwrite files under an existing aoi_id; publish -v2 instead.
# (Every process caches AOI layers in memory; overwriting would serve stale data forever.)
REQUIRED_AOI_LAYERS = (
    "dem",  # float32 .npy [ny,nx], metres
    "manning",  # float32 .npy, Manning's n
    "infiltration_mm_h",  # float32 .npy
    "drain_sink_mm_h",  # float32 .npy, baseline drain removal rate
    "boundary_mask",  # uint8/float .npy, 1 = open water held at tide level (lagoon/sea; JRC occurrence >= 90%)
    "exclude_mask",  # uint8/float .npy, 1 = permanent water: never counted as flooding
    "buildings",  # buildings_index.json {"ids":[...],"row":[...],"col":[...]}
    "roads_graph",  # GraphML nx.Graph (simple, undirected); nodes x=lon,y=lat,row,col;
    #                 edges length_m, cells JSON, optional drive=1, bridge=1 (bridges skip depth sampling)
    "population",  # float32 .npy, people per cell
    "shelters",  # GeoJSON points, props: name, row, col
)
OPTIONAL_AOI_LAYERS = (
    "buildings_geojson",  # footprints for the UI, props id + height_m; SAME ids as buildings
    "places",  # GeoJSON Polygons (<=20 vertices), props name, kind: agent geography + area stats
    "obs_flood_extent",  # .npy Sentinel-1 flood mask for validation
    "inflows",  # inflows.json {t0_utc, sources: [{name, gauges, cells [[r,c]], hydrograph [[t_s, m3_s]]}], note}
    # drainage (0.8.0, AOIs with drainage_default; built by dryrun/pipeline/drains.py):
    "drain_network",  # drain_network.json: channel nodes/links/outfalls, sewer zones, feature -> node lists
    "inlets_count",  # float32 .npy, drain inlets (catch basins) per cell
    "sewer_zones",  # int32 .npy, lumped sewer zone per cell, -1 = none
    "drains_geojson",  # UI layer, see DRAINS_GEOJSON below
)

# drains_geojson (0.8.0): one FeatureCollection. Every feature has properties `id` (string, prefixed by kind:
# "drain:", "gutter:", "canal:", "zone:", "inlet:", "outfall:") and `kind`, one of
#   open_drain | covered_drain | gutter_inferred | canal   LineString; width_m, depth_m, source "osm"|"inferred",
#                                                          name (null if unnamed)
#   sewer_zone                                             Polygon/MultiPolygon; name, capacity_mm_h, inlets,
#                                                          receiving, gated
#   inlet                                                  Point (catch basin; Queens only, from NYC DEP)
#   outfall                                                Point; name, receiving, gated
# The line and zone ids are the ids in a run's drain_fill.


# ----------------------------------------------------------------------- Scenario
class StormPattern(str, Enum):
    uniform = "uniform"
    front_loaded = "front_loaded"
    center_peaked = "center_peaked"  # SCS-like


Polygon = list[tuple[float, float]]  # closed or open ring of (lon, lat)


class _Area(_Base):
    """An intervention area: EITHER a lon/lat polygon OR the name of a feature in the AOI's
    `places` layer (resolved server-side, so the agent never has to copy coordinates)."""

    polygon: Polygon | None = None
    place: str | None = Field(None, description="name from get_aoi_info places")

    @model_validator(mode="after")
    def _one_area(self):
        if (self.polygon is None) == (self.place is None) and self.__class__.__name__ != "DrainUpgrade":
            raise ValueError("give exactly one of polygon or place")
        if self.polygon is not None and self.place is not None:
            raise ValueError("give polygon or place, not both")
        return self


class RainProfile(str, Enum):
    gaussian = "gaussian"
    exponential = "exponential"
    flat = "flat"


class StormTrack(_Base):
    """A moving storm cell: the centre starts at RainCell.center and travels in a straight line."""

    heading_deg: float = Field(ge=0, lt=360, description="direction the cell moves TOWARD, compass degrees "
                               "(0 = north, 90 = east, 270 = west)")
    speed_m_s: float = Field(ge=0, le=20, description="West African squall lines move ~11-18 m/s westward")


class RainCell(_Base):
    """Rain from one storm cell. Intensity falls off with distance d from the centre:
    gaussian exp(-2 (d/R)^2), exponential exp(-2 d/R), flat 1 inside R, so R (radius_m) is where a gaussian or
    exponential cell is down to e^-2 = 13.5 % of its peak. Storm.total_mm is the POINT depth at the centre of a
    stationary cell; the rain field preview reports the area-average depth and volume."""

    kind: Literal["cell"] = "cell"
    center: tuple[float, float] | None = Field(None, description="(lon, lat) of the cell centre; a moving cell is here at the rain peak (the start for front_loaded, mid-storm otherwise)")
    place: str | None = Field(None, description="centre on this `places` feature instead (its centroid)")
    radius_m: float = Field(5000, ge=1000, le=15000, description="radar cells are ~35-90 km2: R ~ 3-5 km")
    profile: RainProfile = RainProfile.gaussian
    track: StormTrack | None = Field(None, description="None = a stationary cell")

    @model_validator(mode="after")
    def _one_centre(self):
        if (self.center is None) == (self.place is None):
            raise ValueError("give exactly one of center or place")
        return self


class RainPolygon(_Area):
    """Rain only inside an area (uniform there, none outside): a polygon or a `places` name."""

    kind: Literal["polygon"] = "polygon"


RainArea = Annotated[Union[RainCell, RainPolygon], Field(discriminator="kind")]


class Storm(_Base):
    total_mm: float = Field(ge=0, le=600, examples=[120], description=(
        "rain depth over the storm: everywhere by default; inside the polygon for a rain polygon; at the centre "
        "of a stationary rain cell (a point depth, so the area average is lower)"))
    duration_h: float = Field(gt=0, le=12, examples=[3])
    pattern: StormPattern = StormPattern.center_peaked
    spatial: RainArea | None = Field(None, description="where the rain falls; None = the whole area")


class DrainUpgrade(_Area):
    """No polygon/place = whole AOI."""

    type: Literal["drain_upgrade"] = "drain_upgrade"
    capacity_factor: float = Field(1.0, ge=0, le=5, description="multiplies EXISTING drains: 1.4 = +40%")
    add_mm_h: float = Field(0, ge=0, le=200, description="NEW drainage inside the area (where none is mapped)")


class GreenInfrastructure(_Area):
    type: Literal["green"] = "green"
    infiltration_mm_h: float = Field(ge=0, le=200, default=40)
    manning: float = Field(ge=0.01, le=0.3, default=0.08)


class RetentionPond(_Area):
    """Draw on open land. Buildings inside are reported as buildings_in_ponds (displaced), roads are cut."""

    type: Literal["pond"] = "pond"
    depth_m: float = Field(gt=0, le=10, default=2.0)


class TideLevel(_Base):
    type: Literal["tide"] = "tide"
    boundary_level_m: float = Field(ge=-2, le=5, description="water level at outflow boundary")


class RoadClosure(_Area):
    type: Literal["road_closure"] = "road_closure"  # routing-only; ignored by the solver


Intervention = Annotated[
    Union[DrainUpgrade, GreenInfrastructure, RetentionPond, TideLevel, RoadClosure],
    Field(discriminator="type"),
]


DrainageSystem = Literal["closed", "open", "mixed"]


class Drainage(_Base):
    """The drain/sewer model (0.8.0). Every field left None takes the AOI's drainage_default.

    closed: rain enters only at inlet cells (catch basins), fills a lumped sewer per zone that empties at a capped
            rate through its outfall; when full or tide-locked it surcharges back onto the lowest inlet cells.
    open:   rain enters roadside channels along their open edges (covered sections only through inlets); the
            channels carry it along the network (Manning) to outfalls and overflow onto the street when full.
    mixed:  both (a what-if, e.g. Lagos with closed sewers under the roads as well).
    """

    system: DrainageSystem | None = None
    capacity_mm_h: float | None = Field(None, ge=0, le=200, description=(
        "design rain intensity the system carries (Queens pre-1973 standard 1.5 in/h = 38.1 mm/h). Closed: pipe "
        "flow cap = this x runoff coefficient x zone area. Open: scales channel widths relative to the AOI default"))
    return_period_yr: Literal[1, 2, 3, 5, 10, 25, 50, 100] | None = Field(None, description=(
        "alternative to capacity_mm_h: the design storm, mapped through drainage_default."
        "design_mm_h_by_return_period (400 if the AOI has no entry for it)"))
    blockage_pct: float | None = Field(None, ge=0, le=90, description=(
        "share of inlet and channel capacity lost to solid waste and sediment"))
    outfall: Literal["tide", "free", "blocked"] = Field("tide", description=(
        "tide: water leaves only while the level inside is above the receiving water (lagoon/tide; TideLevel "
        "raises it). free: ignore the receiving water. blocked: nothing leaves; the system only stores, then overflows"))
    flap_gates: bool | None = Field(None, description="outfalls let no outside water back in")
    roadside_gutters: bool | None = Field(None, description=(
        "open/mixed: add inferred drains along drivable roads (OSM maps only 2-3 % of them in Lagos)"))

    @model_validator(mode="after")
    def _one_capacity(self):
        if self.capacity_mm_h is not None and self.return_period_yr is not None:
            raise ValueError("give capacity_mm_h or return_period_yr, not both")
        return self


class DrainageDefault(_Base):
    """AOIManifest.drainage_default (0.8.0): what this AOI's drainage is, and what it can honestly claim."""

    system: DrainageSystem
    label: str = Field(examples=["Closed sewers: catch basins into pipes"])
    capacity_mm_h: float = Field(ge=0, description="default design rain intensity")
    return_period_yr: int | None = Field(None, description="the design storm of the default, if known")
    design_mm_h_by_return_period: dict[str, float] = Field(
        default_factory=dict, description='{"3": 38.1, "5": 44.5, "10": 54.1}: keys are years as strings; empty '
                                          "where no design standard is published (Lagos)")
    blockage_pct: float = Field(ge=0, le=90)
    blockage_range_pct: tuple[float, float] = Field(description="plausible range for a slider")
    flap_gates: bool
    roadside_gutters: bool
    receiving: str = Field(examples=["Lagos Lagoon", "East River and Flushing Bay"])
    runoff_coefficient: float = Field(0.85, gt=0, le=1)
    storage_mm: float = Field(ge=0, description="closed sewers: pipe storage per zone area, mm")
    limits: list[str] = Field(description="what the model cannot claim here, one sentence each")
    sources: list[str] = Field(default_factory=list)


class ScenarioSpec(_Base):
    contract_version: str = CONTRACT_VERSION
    aoi_id: str
    storm: Storm
    interventions: list[Intervention] = Field(default_factory=list)
    sim_hours: float = Field(gt=0, le=12, default=6)
    output_interval_min: int = Field(ge=5, le=60, default=10)
    domain: Literal["aoi", "rain_area"] = Field(
        "aoi", description="aoi: simulate the whole grid. rain_area: only the cells the storm's rain area wets "
                           "(storm.spatial), plus a 1 km buffer; water reaching the window edge flows out and "
                           "is counted. Faster for a small storm; flow from outside the window is not modelled. Not "
                           "available on river AOIs (AOIManifest.layers has 'inflows'): 400.")
    drainage: Drainage | None = Field(
        None, description="the drain/sewer model. None = the AOI's drainage_default if it has one, else the constant "
                          "drain_sink_mm_h (older AOIs). On an AOI without drainage_default a Drainage is a 400. "
                          "Added in 0.8.0")
    # Stored in the PUBLIC runs bucket and reachable from public input: short, no URLs or markup.
    label: str | None = Field(None, max_length=60, pattern=r"^[\w .,+%()/×-]*$",
                              description="human label; NOT part of run_id")

    @model_validator(mode="after")
    def _domain_needs_rain_area(self):
        if self.domain == "rain_area" and self.storm.spatial is None:
            raise ValueError("domain rain_area needs storm.spatial (a cell or a polygon)")
        return self

    def run_id(self) -> str:
        """Deterministic id => identical scenarios share cached results.

        Canonical JSON of every field except `label`, plus SOLVER_VERSION (hash of the sim
        source + backend) and the AOI manifest hash, so a code or data change can never
        serve a stale cached run.
        """
        from dryrun import storage
        from dryrun.sim import SOLVER_VERSION

        payload = self.model_dump(mode="json", exclude={"label"})
        if payload["storm"].get("spatial") is None:  # whole-area rain hashes as before the field existed
            payload["storm"].pop("spatial", None)
        if payload.get("domain") == "aoi":  # likewise for the whole-grid domain
            payload.pop("domain", None)
        if payload.get("drainage") is None:  # and for no explicit drainage
            payload.pop("drainage", None)
        payload["_solver"] = SOLVER_VERSION
        payload["_aoi"] = storage.aoi_hash(self.aoi_id)
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return "r_" + hashlib.sha256(blob.encode()).hexdigest()[:16]


# ------------------------------------------------------------------------- Run
class RunStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class FrameRef(_Base):
    t_s: int = Field(description="seconds since storm start")
    png: str = Field(description="path relative to run folder, e.g. frames/f_0006.png")
    depth: str = Field(description="path to float16 .npy depth grid (metres), for /depth queries")


class RunStats(_Base):
    """Every number the agent is allowed to cite MUST come from here (or RouteResult)."""

    run_id: str
    # All exposure stats EXCLUDE permanent water (exclude_mask) and retention-pond cells.
    buildings_flooded: int = Field(description="buildings whose max depth (3x3 around footprint) >= 0.15 m; at "
                                   "30 m cells that is flood water within about 45 m, so read it as 'water close by'")
    buildings_flooded_severe: int = Field(description="max depth >= 0.5 m")
    buildings_flooded_own_cell: int = Field(
        0, description="buildings whose OWN cell's max depth >= 0.15 m: stricter than buildings_flooded (3x3), "
        "added in contract 0.4.0 (0 on older runs)")
    road_km_impassable: float = Field(description="road length with max depth >= passability threshold")
    people_exposed: int = Field(description="population in cells with max depth >= 0.15 m")
    flooded_area_km2: float
    max_depth_m: float
    peak_t_s: int = Field(description="time of maximum flooded area")
    rain_volume_m3: float
    rain_generated_m3: float | None = Field(None, description="rain the storm produces, including any that falls "
                                            "outside the AOI (spatial rain only; added in 0.6.0)")
    rain_in_aoi_m3: float | None = Field(None, description="rain falling inside the AOI on land and water; "
                                         "rain_volume_m3 is the part applied to land (added in 0.6.0)")
    domain_cells: int | None = Field(None, description="cells simulated: the whole grid, or the rain-area window "
                                     "(domain rain_area); added in 0.7.0")
    domain_bbox: tuple[float, float, float, float] | None = Field(
        None, description="lon/lat [w, s, e, n] of the simulated window (domain rain_area); null for domain aoi. "
                          "Outside it nothing was modelled: frames there hold the t=0 state, and point depths, "
                          "series and building depths are null. Added in 0.7.0")
    inflow_volume_m3: float = Field(0.0, description="river inflow entering the domain (gauge hydrograph); added in "
                                    "contract 0.5.0 (0 on older runs and on AOIs without inflows)")
    drained_volume_m3: float
    infiltrated_volume_m3: float
    stored_volume_end_m3: float
    boundary_outflow_m3: float = Field(description="water leaving through the lagoon/edge boundary")
    mass_balance_error_pct: float = Field(
        description="100*(rain + inflow - drained - infiltrated - outflow - stored_end) / (rain + inflow); "
        "solver sanity check, |err| should be < 1%"
    )
    buildings_in_ponds: int = Field(0, description="buildings inside pond polygons (displaced, not 'saved')")
    passability_threshold_m: float = 0.3
    is_surrogate: bool = Field(False, description="True if produced by the ML emulator, not the solver")
    # drainage (0.8.0): all null on runs without the drainage model (older AOIs, older runs). Then
    # drained_volume_m3 = drain_outfall_m3 + drain_storage_end_m3 (net taken off the surface), so
    # mass_balance_error_pct keeps its formula.
    sewer_captured_m3: float | None = Field(None, description="GROSS surface water taken in by inlets and open drains: "
                                            "water that overflows and is taken in again counts each time. Net "
                                            "taken off the streets = drained_volume_m3")
    sewer_surcharge_m3: float | None = Field(None, description="water pushed back onto the street (system full or "
                                             "outfall drowned)")
    drain_outfall_m3: float | None = Field(None, description="left through outfalls (net: negative if the receiving "
                                           "water flowed in)")
    drain_storage_end_m3: float | None = Field(None, description="water gained by pipes and channels since the start "
                                               "(tidal water already in channels at t=0 not counted)")
    drain_peak_full_pct: float | None = Field(None, description="peak system-wide fill, 0-100")
    drain_full_t_s: int | None = Field(None, description="first time the system was >= 95 % full; null if never")
    drain_surcharge_start_t_s: int | None = Field(None, description="first time water overflowed onto the street")
    drain_surcharge_end_t_s: int | None = Field(None, description="last time water overflowed onto the street")


class Patch3DRequest(_Base):
    """A 3D patch: a small square around `center`, solved with a 3D free-surface solver (OpenFOAM interFoam) and
    driven at its edges by the parent 2D run (one-way nesting). A batch job, not the live request path."""

    run_id: str = Field(pattern=r"^r_[0-9a-f]{16}$", description="the parent 2D run (must be done)")
    center: tuple[float, float] = Field(description="(lon, lat) of the patch centre")
    size_m: float = Field(200, ge=60, le=300, description="side of the square patch")
    cell_m: float = Field(2.0, ge=1.0, le=4.0, description="horizontal cell size; vertical cells are cell_m / 8")
    t_window_s: tuple[float, float] | None = Field(
        None, description="[t0, t1] seconds since storm start; default: 10 min ending at the 2D peak at the patch")

    def patch_id(self) -> str:
        blob = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return "p_" + hashlib.sha256((blob + CONTRACT_VERSION).encode()).hexdigest()[:16]


class Patch3DFrame(_Base):
    t_s: float = Field(description="seconds since storm start")
    surface: str = Field(description="PNG: water depth above the patch ground, see Patch3DManifest.encoding")
    velocity: str = Field(description="PNG: surface and mid-depth velocity, see Patch3DManifest.encoding")


class Patch3DManifest(_Base):
    patch_id: str
    request: Patch3DRequest
    status: RunStatus
    error: str | None = None
    solver: str = "OpenFOAM interFoam (VOF), one-way nested in the 2D run"
    bounds_wgs84: tuple[float, float, float, float] | None = None
    nx: int | None = None
    ny: int | None = None
    t_window_s: tuple[float, float] | None = None
    frames: list[Patch3DFrame] = Field(default_factory=list)
    encoding: dict = Field(default_factory=dict, description="how to decode the frame PNGs (scales in m and m/s)")
    buildings: str | None = Field(None, description='JSON {"ids", "peak_force_kN", "t_s", ...} for footprints '
                                  "in the patch")
    checks: dict = Field(default_factory=dict, description="water volume vs the 2D run, mesh size, timings")
    cells: int | None = None
    elapsed_s: float | None = None


class RunManifest(_Base):
    """gs://<runs-bucket>/runs/<run_id>/manifest.json"""

    contract_version: str = CONTRACT_VERSION
    run_id: str
    scenario: ScenarioSpec
    status: RunStatus
    frames: list[FrameRef] = Field(default_factory=list)
    max_depth_png: str | None = None
    intervention_cells: list[int] = Field(
        default_factory=list, description="grid cells whose inputs each intervention actually CHANGED (0 = no effect)")
    timeseries: Timeseries | None = None
    building_depths: str | None = Field(
        None, description='JSON {"ids": [...], "max_depth_m": [...]} per building; the UI joins by id '
        "to the buildings_geojson features and colours extrusions with it"
    )
    stats: RunStats | None = None
    colormap: dict[str, list[float]] = Field(
        default_factory=lambda: {"depth_m": [0.05, 0.15, 0.3, 0.5, 1.0, 2.0]},
        description="bin edges used to colour the PNGs; UI legend reads this",
    )
    error: str | None = None
    drain_fill: str | None = Field(None, description="path to drain_fill.json (DrainFill): per-frame fill of every "
                                   "drain line and sewer zone. Null without the drainage model. Added in 0.8.0")
    drainage_limits: list[str] | None = Field(None, description="what this run's drainage model cannot claim, one "
                                              "sentence each (the AOI's limits plus scenario-specific ones). Added "
                                              "in 0.8.0")
    backend: Literal["fake", "solver", "surrogate"] = "fake"  # default fails toward the honest badge
    elapsed_s: float | None = None


COMPARE_FIELDS = (
    "buildings_flooded", "buildings_flooded_severe", "buildings_flooded_own_cell", "road_km_impassable",
    "people_exposed", "flooded_area_km2", "max_depth_m", "drained_volume_m3", "stored_volume_end_m3", "boundary_outflow_m3",
)


class AreaStats(_Base):
    """Stats inside one named place for one run (get_area_stats tool; claim field area:<place>:<stat>)."""

    run_id: str
    place: str
    buildings_flooded: int
    buildings_flooded_own_cell: int = 0
    people_exposed: int
    road_km_impassable: float
    max_depth_m: float
    flooded_area_km2: float


class Timeseries(_Base):
    """Per-frame series for charts and event markers on the shared clock (same order as frames)."""

    t_s: list[int]
    flooded_area_km2: list[float]
    road_km_impassable: list[float]
    edges_cut: list[int]
    drain_full_pct: list[float] | None = Field(None, description="system-wide drain fill, 0-100 (0.8.0)")
    drain_outfall_m3_s: list[float] | None = Field(None, description="outfall discharge, m3/s (0.8.0)")
    surcharge_m3_s: list[float] | None = Field(None, description="overflow back onto the street, m3/s (0.8.0)")


class DrainFill(_Base):
    """runs/<run_id>/drain_fill.json (0.8.0). fill_pct[f][k] = fill of ids[k] at t_s[f], 0-100 (same frames as
    RunManifest.frames). ids are drains_geojson line and sewer_zone ids."""

    t_s: list[int]
    ids: list[str]
    kind: list[Literal["open_drain", "covered_drain", "gutter_inferred", "canal", "sewer_zone"]]
    fill_pct: list[list[int]]


class CompareResult(_Base):
    base_run_id: str
    alt_run_id: str
    delta: dict[str, float] = Field(description="alt - base for each field in COMPARE_FIELDS")


# ---------------------------------------------------------------------- Routing
class RouteRequest(_Base):
    run_id: str
    t_s: int = Field(description="use the flood state at this time")
    origin: tuple[float, float]  # lon, lat
    destination: tuple[float, float] | None = Field(None, description="None = nearest shelter")


class RouteResult(_Base):
    run_id: str
    t_s: int
    reachable: bool
    path: list[tuple[float, float]] = Field(default_factory=list, description="lon/lat polyline")
    length_km: float | None = None
    eta_min: float | None = Field(None, description="assumes walking 4 km/h unless noted")
    edges_removed: int = Field(description="road edges cut by flooding at t_s")
    destination_name: str | None = None


# ------------------------------------------------------------------ Observations
class Observation(_Base):
    """Produced by /observe (SAM 3.1 + Muse Spark vision). Shown as pins on the map."""

    obs_id: str
    lon: float
    lat: float
    t_s: int | None = Field(None, description="aligned to sim clock if known")
    source: Literal["citizen_photo", "drone_video", "satellite_chip"]
    est_depth_m: float | None
    depth_low_m: float | None = None
    depth_high_m: float | None = None
    reference_object: str | None = Field(None, examples=["car tyre", "door"])
    water_fraction: float = Field(ge=0, le=1, description="share of image masked as flood water")
    mask_png: str | None = None
    model_notes: str | None = None
    sim_depth_m: float | None = Field(None, description="filled by backend for a given run_id")


# ------------------------------------------------------------------------ Muse Image before/after

RENDER_LABEL = "AI illustration, not a measurement"


class RenderRequest(_Base):
    """POST /api/render: a ground-level picture of one street spot in two runs of the same storm (Muse Image).
    Each picture is asked for the run's peak depth in the grid cell holding `center`; the change is the difference
    between the two runs' scenarios. The deeper picture is generated from text and the other is an edit of it, so
    the camera and buildings match. Additive in 0.8.0: run_ids and patch_ids are unchanged."""

    base_run_id: str = Field(pattern=r"^r_[0-9a-f]{16}$", description="'before': the run without the change")
    alt_run_id: str = Field(pattern=r"^r_[0-9a-f]{16}$", description="'after': the run with the change; same AOI "
                            "and storm as base_run_id")
    center: tuple[float, float] = Field(description="(lon, lat) of the street spot")
    view: Literal["street", "window"] = Field("street", description="street: eye level from the road; window: "
                                              "looking down from a first-floor window")
    provider: Literal["meta", "fake"] = Field("meta", description="fake: offline placeholder pictures, no cost")


class RenderImage(_Base):
    url: str = Field(description="WebP, labelled in the image itself with RENDER_LABEL and the depth")
    run_id: str
    depth_m: float = Field(description="the run's peak water depth in this grid cell (cell average)")
    depth_text: str = Field(description="the depth cue the image model was given, e.g. 'over the kerb'")
    picture_depth_m: float | None = Field(None, description="Muse Spark vision's estimate of the depth the picture "
                                          "actually shows (the image model tends to draw less water than asked)")
    picture_matches: bool | None = Field(None, description="picture_depth_m within max(0.1 m, 35 %) of depth_m")


class RenderResult(_Base):
    render_id: str = Field(description="cache key: same runs, grid cell, view, photo and provider = same pictures")
    request: RenderRequest
    aoi_id: str
    cell: tuple[int, int] = Field(description="[row, col] of the grid cell the depths come from")
    place: str | None = Field(None, description="named place holding or nearest to the spot")
    photo: str | None = Field(None, description="URL of the uploaded street photo (EXIF stripped), when one was sent")
    before: RenderImage
    after: RenderImage
    changes_here: list[str] = Field(default_factory=list, description="changes drawn at this spot")
    changes_elsewhere: list[str] = Field(default_factory=list, description="changes in the alt run that are not "
                                         "at this spot (they still change the water here)")
    source_photo: Literal["generated", "uploaded"]
    label: str = RENDER_LABEL
    model: str = Field(description="muse-image-1.0, or fake")
    prompts: dict[str, str] = Field(default_factory=dict, description="before / after instructions sent")
    notes: list[str] = Field(default_factory=list)
    cached: bool = False


# ------------------------------------------------------------------------ Agent
class Claim(_Base):
    """The model supplies text, unit, source_run_id and field. The VERIFIER looks the number up
    and writes it into `value`; the model's own number is kept in `model_value` for audit."""

    text: str
    value: float | None = Field(None, description="filled by verify.py from storage (truth)")
    model_value: float | None = Field(None, description="what the model claimed")
    unit: str
    source_run_id: str
    field: str = Field(
        description="Where the value came from. One of: '<RunStats field>' | "
        "'delta:<RunStats field>:<base_run_id>' (value = this run minus base) | "
        "'route:<route_id>:<RouteResult field>' | 'area:<place name>:<AreaStats field>'"
    )
    verified: bool = Field(False, description="lookup ok AND model_value matched (ints exact) AND text has no digits")


class Brief(_Base):
    title: str
    summary: str = Field(description="prose with NO numbers; numbers live in claims")
    claims: list[Claim]
    recommended_run_id: str | None = None
    model: str
    provider: Literal["meta", "baseten", "openrouter", "modal", "fake"]


class AgentEvent(_Base):
    """Streamed to the UI over SSE from POST /agent (one JSON per event)."""

    kind: Literal["thought", "tool_call", "tool_result", "phase", "run_ready", "brief", "error", "done"]
    data: dict
