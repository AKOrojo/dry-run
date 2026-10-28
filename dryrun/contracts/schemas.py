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

CONTRACT_VERSION = "0.3.0"


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
            "obs_flood_extent (Sentinel-1)."
        )
    )
    sources: dict[str, str] = Field(description="Layer name -> attribution / licence string")
    is_synthetic: bool = False


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
)


# ----------------------------------------------------------------------- Scenario
class StormPattern(str, Enum):
    uniform = "uniform"
    front_loaded = "front_loaded"
    center_peaked = "center_peaked"  # SCS-like


class Storm(_Base):
    total_mm: float = Field(ge=0, le=600, examples=[120])
    duration_h: float = Field(gt=0, le=12, examples=[3])
    pattern: StormPattern = StormPattern.center_peaked


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


class ScenarioSpec(_Base):
    contract_version: str = CONTRACT_VERSION
    aoi_id: str
    storm: Storm
    interventions: list[Intervention] = Field(default_factory=list)
    sim_hours: float = Field(gt=0, le=12, default=6)
    output_interval_min: int = Field(ge=5, le=60, default=10)
    label: str | None = Field(None, description="human label; NOT part of run_id")

    def run_id(self) -> str:
        """Deterministic id => identical scenarios share cached results.

        Canonical JSON of every field except `label`, plus SOLVER_VERSION (hash of the sim
        source + backend) and the AOI manifest hash, so a code or data change can never
        serve a stale cached run.
        """
        from dryrun import storage
        from dryrun.sim import SOLVER_VERSION

        payload = self.model_dump(mode="json", exclude={"label"})
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
    buildings_flooded: int = Field(description="buildings whose max depth (3x3 around footprint) >= 0.15 m")
    buildings_flooded_severe: int = Field(description="max depth >= 0.5 m")
    road_km_impassable: float = Field(description="road length with max depth >= passability threshold")
    people_exposed: int = Field(description="population in cells with max depth >= 0.15 m")
    flooded_area_km2: float
    max_depth_m: float
    peak_t_s: int = Field(description="time of maximum flooded area")
    rain_volume_m3: float
    drained_volume_m3: float
    infiltrated_volume_m3: float
    stored_volume_end_m3: float
    boundary_outflow_m3: float = Field(description="water leaving through the lagoon/edge boundary")
    mass_balance_error_pct: float = Field(
        description="100*(rain - drained - infiltrated - outflow - stored_end) / rain; "
        "solver sanity check, |err| should be < 1%"
    )
    buildings_in_ponds: int = Field(0, description="buildings inside pond polygons (displaced, not 'saved')")
    passability_threshold_m: float = 0.3
    is_surrogate: bool = Field(False, description="True if produced by the ML emulator, not the solver")


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
    backend: Literal["fake", "solver", "surrogate"] = "fake"  # default fails toward the honest badge
    elapsed_s: float | None = None


COMPARE_FIELDS = (
    "buildings_flooded", "buildings_flooded_severe", "road_km_impassable", "people_exposed",
    "flooded_area_km2", "max_depth_m", "drained_volume_m3", "stored_volume_end_m3", "boundary_outflow_m3",
)


class AreaStats(_Base):
    """Stats inside one named place for one run (get_area_stats tool; claim field area:<place>:<stat>)."""

    run_id: str
    place: str
    buildings_flooded: int
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
    provider: Literal["meta", "baseten", "fake"]


class AgentEvent(_Base):
    """Streamed to the UI over SSE from POST /agent (one JSON per event)."""

    kind: Literal["thought", "tool_call", "tool_result", "run_ready", "brief", "error", "done"]
    data: dict
