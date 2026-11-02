# Data & model attribution

Owner: Eng D. **Status is the honest one, not the aspirational one**: a row is "In use" only once the data is in
the live site and its credit line is visible in the app. Each live area's credit strings are its AOI manifest's
`sources` (GET `/api/aoi/{aoi_id}`), shown in the app's Sources panel. Last checked against the live site on
2026-11-02.

No third-party dataset is committed to this repo. Third-party data lives only in the GCS data bucket.

## In use: the whole app

| Source | Use | Licence / terms | Required credit |
|---|---|---|---|
| Muse Spark Open | sovereign-mode agent (served through OpenRouter; the Baseten deployment was never listed) | Muse Model License | "Built with Muse Spark Open" (in the app footer) |
| Cesium ion (Community tier) | serves the Bing basemap, World Terrain and Google 3D tiles; token restricted by URL | Cesium ion terms; Community tier is non-commercial | Cesium ion logo in the on-screen credit display. Owner decision 2026-10-30: the non-commercial tier is acceptable for this hackathon demo |
| Bing Maps Aerial, via Cesium ion (default ion imagery asset) | basemap imagery on the globe | Cesium ion terms; Microsoft Bing Maps terms | Cesium's on-screen credit display (ion and Microsoft logos); never hide `viewer.creditDisplay` |
| Google Photorealistic 3D Tiles (ion asset 2275207) | 3D basemap (#82); the Bing globe stays as the alternative basemap | Google Map Tiles API terms | Google logo and data attributions in Cesium's on-screen credit display; never hide or restyle `viewer.creditDisplay` |
| Google Maps 2D Satellite (Map Tiles API, our own key) | judges-only Aerial option beside Bing (owner rule: Bing for everyone, Google for judges) | Google Map Tiles API terms | Google logo and imagery attributions in Cesium's on-screen credit display. Key: Secret Manager `google-tiles-key`, restricted to the Map Tiles API and our referrers, capped at 3,000 2D tiles/day |
| Cesium World Terrain (ion asset 1) | 3D terrain under the globe and building bases (#82) | Cesium ion terms | "Cesium World Terrain" in the on-screen credit display |

## In use: the live areas

Live areas: `lagos-lekki-v3` (default), `nyc-queens-v1` and `texas-guadalupe-v0`. A cell marked ✓ means that
area uses the source.

| Source | Version / file | Use | Lagos | Queens | Texas | Licence | Required credit |
|---|---|---|---|---|---|---|---|
| Copernicus DEM GLO-30 | AWS open data COGs (Lagos `N06_00_E003_00`) | terrain | ✓ | | ✓ | Copernicus WorldDEM-30 licence (free, incl. commercial) | "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" + the no-liability disclaimer |
| USGS 3D Elevation Program (3DEP) | 1/9 arc-second lidar DEM (includes the NYC 2017 topobathymetric lidar) | terrain (first quartile to 15 m, NAVD88 -> EGM2008) | | ✓ | | US public domain | "USGS 3D Elevation Program (3DEP)" (courtesy credit) |
| ESA WorldCover 10 m | v200 (2021) | land cover -> roughness / infiltration | ✓ | ✓ | ✓ | CC BY 4.0 | "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium" |
| JRC Global Surface Water | occurrence v1.5 (1984–2024) | permanent water masks | ✓ | ✓ | ✓ | free, no restriction | "Source: EC JRC/Google" (Pekel et al. 2016) |
| WorldPop | R2025A v1, 2025, 100 m constrained (labelled alpha) | people per cell | ✓ | ✓ | ✓ | CC BY 4.0 | "WorldPop (www.worldpop.org), University of Southampton. R2025A v1, DOI:10.5258/SOTON/WP00839" |
| OpenStreetMap contributors | Geofabrik extracts, 2026-10-28 | roads, shelters, places; Lagos drains (incl. covered/culvert sections) | ✓ | ✓ | ✓ | ODbL 1.0 | "© OpenStreetMap contributors" linked to openstreetmap.org/copyright; our derived roads/drains/places DB is share-alike (ODbL) |
| Google Open Buildings v3 | polygons, S2 cell 103b | building footprints (heights: 6 m assumed for all) | ✓ | | | CC BY 4.0 (or ODbL) | "Google Open Buildings v3 (CC BY 4.0)"; cite Sirko et al. 2021 |
| NYC Open Data BUILDING footprints | `5zhs-2jue`, fetched 2026-10-29 (49,717 kept) | building footprints, HEIGHT_ROOF heights (6 m where unknown) | | ✓ | | NYC Open Data terms of use | "City of New York, NYC Open Data" |
| Microsoft Global ML Building Footprints | | building footprints | | | ✓ | ODbL | "Microsoft Global ML Building Footprints, ODbL" |
| NYC DEP Citywide Catch Basins | `2w2g-fk3i`, fetched 2026-10-30 (7,672 in the box) | inlets of the closed-sewer model | | ✓ | | NYC Open Data terms of use | "NYC Department of Environmental Protection (DEP), NYC Open Data" |
| NYC DEP Citywide Outfalls | `8rjn-kpsh`, fetched 2026-10-30 (363 near the box, 21 CSO) | sewer outfalls of the closed-sewer model | | ✓ | | NYC Open Data terms of use | "NYC DEP, NYC Open Data" |
| USGS NWIS instantaneous values | provisional 15-min discharge, 4 Jul 2025: 08165300, 08166000, 08165500 | river inflows (South Fork ungauged: Hunt minus North Fork, an estimate) | | | ✓ | US public domain | "USGS NWIS instantaneous values (provisional)" |

The drain and sewer models also cite their engineering references in the same credit lines: FHWA HEC-22 and the
SWMM 5.2 manual (Lagos), and the NYC DEP 2024 Stormwater Analysis Report plus HEC-22 (Queens).

## Validation only: scored offline, not shown as a layer

| Source | Version / file | Use | Licence | Required credit |
|---|---|---|---|---|
| NASA GPM IMERG V07 | half-hourly Late (Lagos, Jun–Jul 2026) and Final (Texas, 4 Jul 2025), via Earthdata | rainfall for validation storms | NASA open data | "GPM IMERG Precipitation L3 Half Hourly V07, NASA GES DISC" |
| NOAA / NWS ASOS (LaGuardia, Central Park) | hourly precipitation, 1 Sep 2021 | Ida rainfall for the Queens presets | US public domain | "NOAA NCEI / NWS ASOS" |
| NYC 311 Service Requests | `erm2-nwe9`, flood complaints 1–3 Sep 2021 | Queens hit rate | NYC Open Data terms of use | "City of New York, NYC 311 via NYC Open Data" |
| NYC Stormwater Flood Maps | `9i7c-xyvv` (2024 release; 3 of 4 scenarios readable) | Queens closed-sewer model check | NYC Open Data terms of use | "NYC DEP, NYC Stormwater Resiliency Plan" |
| USGS STN high-water marks | event 312 "2021 Ida" (32 marks at 16 sites in the Queens box); event 357 "2025 July TX Flood" (224 marks in the Texas AOI), from the STN API | water level and depth at the marks (`evals/validation/queens_hwm.py`, `texas_hwm.py`) | US public domain | "USGS Short-Term Network (STN) high-water marks" |
| Sentinel-1 RTC (Copernicus), via Microsoft Planetary Computer | 3 same-orbit pairs, 28 Jun – 12 Jul 2026 | Lagos built-up loss fitted to the 12 Jul drain-down; flood-extent CSI not computed (no flooding on land in the scenes) | CC BY 4.0 | "Contains modified Copernicus Sentinel data (2026)" |
| FIMbench | University of Alabama / CIROH, tile `HWM_20250702_20250706_991439W300048N` | Texas flood extent (interpolated from the same marks, so not an independent test) | CC BY 4.0 | cite doi:10.5281/zenodo.22961099 |

## Not in use

| Source | Why |
|---|---|
| Google Open Buildings 2.5D Temporal (2023 tiles 103bc / 103c4) | Built into a heights file for the old `lagos-lekki-v1` footprints, served through `BUILDINGS_URL`. The live site does not set `BUILDINGS_URL`, so Lagos v3 uses its own Open Buildings v3 footprints at 6 m. Licence if revived: CC BY 4.0, "Google Open Buildings 2.5D Temporal (CC BY 4.0)", cite Sirko et al. 2023 (arXiv:2310.11622) |
| Synthetic fixtures (`dryrun.pipeline.fixtures`) | ours; local development and tests only (`make fixtures`), badged "Synthetic terrain" when shown |

## Excluded

| Source | Why |
|---|---|
| FABDEM | CC BY-NC-SA 4.0. Non-commercial and share-alike. Do not ship it in a public demo; use Copernicus DEM instead. |
| `tile.openstreetmap.org` raster tiles | OSMF tile usage policy forbids heavy application use. Serve basemap imagery through Cesium ion. |
