# Data & model attribution

Owner: Eng D. **Status is the honest one, not the aspirational one** — move a row to "In use" only
once the data is actually in the pipeline and the required credit line is visible in the app.

## In use

| Source | Use | Licence / terms | Required credit |
|---|---|---|---|
| Synthetic fixtures (`dryrun.pipeline.fixtures`) | default AOI, demo runs | ours | badged "Synthetic terrain" in the UI |
| Muse Spark Open | sovereign-mode agent | Muse Model License | "Built with Muse Spark Open" (in the app footer) |
| Cesium ion (Community tier) | serves the Bing basemap, World Terrain and Google 3D tiles; token restricted by URL | Cesium ion terms; Community tier is non-commercial | Cesium ion logo in the on-screen credit display. Owner decision 2026-10-30: the non-commercial tier is acceptable for this hackathon demo |
| Bing Maps Aerial, via Cesium ion (default ion imagery asset) | basemap imagery on the globe | Cesium ion terms; Microsoft Bing Maps terms | Cesium's on-screen credit display (ion and Microsoft logos); never hide `viewer.creditDisplay` |
| Google Photorealistic 3D Tiles (ion asset 2275207) | default 3D basemap (#82, live 2026-10-29); the Bing globe stays as the alternative basemap | Google Map Tiles API terms | Google logo and data attributions in Cesium's on-screen credit display; never hide or restyle `viewer.creditDisplay` |
| Cesium World Terrain (ion asset 1) | 3D terrain under the globe and building bases (#82) | Cesium ion terms | "Cesium World Terrain" in the on-screen credit display |

No third-party dataset is committed to this repo. Third-party data lives only in the GCS data bucket.

## In the pipeline — credit line NOT yet visible in the app

Published in AOI `lagos-lekki-v1` (gs://dryrun-hack-2026-data/aoi/lagos-lekki-v1/, built 2026-10-29). Each
row moves to "In use" only when its credit line is visible in the app (Eng B: footer / data card). The exact
credit strings are also in the AOI manifest's `sources`.

| Source | Version / file | Use | Licence | Required credit |
|---|---|---|---|---|
| Copernicus DEM GLO-30 | `Copernicus_DSM_COG_10_N06_00_E003_00_DEM` (AWS open data) | terrain | Copernicus WorldDEM-30 licence (free, incl. commercial) | "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" + the no-liability disclaimer |
| ESA WorldCover 10 m | v200 (2021), tile N06E003 | land cover → roughness / infiltration | CC BY 4.0 | "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium" |
| JRC Global Surface Water | occurrence v1.5 (1984–2024), tile 0E_10N | permanent water masks | free, no restriction | "Source: EC JRC/Google" (Pekel et al. 2016) |
| WorldPop | R2025A v1, NGA 2025, 100 m constrained (labelled alpha) | people per cell | CC BY 4.0 | "WorldPop (www.worldpop.org), University of Southampton. R2025A v1, DOI:10.5258/SOTON/WP00839" |
| OpenStreetMap contributors | Geofabrik Nigeria extract 2026-10-28 | roads, drains, shelters, places | ODbL 1.0 | "© OpenStreetMap contributors" linked to openstreetmap.org/copyright; our derived roads/drains/places DB is share-alike (ODbL) |
| Google Open Buildings v3 | polygons, S2 cell 103b | building footprints | CC BY 4.0 (or ODbL) | "Google Open Buildings v3 (CC BY 4.0)"; cite Sirko et al. 2021 |
| Google Open Buildings 2.5D Temporal | 2023 tiles 103bc / 103c4 (public bucket) | building heights for the 3D view (median of 2.5D heights per footprint; 98.5 % of buildings, the rest 6 m assumed); served via BUILDINGS_URL, not part of the AOI | CC BY 4.0 (or ODbL) | "Google Open Buildings 2.5D Temporal (CC BY 4.0)"; cite Sirko et al. 2023 (arXiv:2310.11622) |
| NASA GPM IMERG Late V07 | half-hourly, Jun–Jul 2026 (via Earthdata) | rainfall for validation storms (Eng A) | NASA open data | "GPM IMERG Late Precipitation L3 Half Hourly V07, NASA GES DISC" |

### NYC Queens (`nyc-queens-v0`, published 2026-10-30)

Same rule: each row moves to "In use" when its credit line is visible in the app. WorldCover and JRC rows above
cover tiles N39W075 / 80W_50N here too.

| Source | Version / file | Use | Licence | Required credit |
|---|---|---|---|---|
| USGS 3D Elevation Program (3DEP) | 1/9 arc-second lidar DEM (includes the NYC 2017 topobathymetric lidar) | terrain (Eng A: first-quartile to 15 m, NAVD88 -> EGM2008) | US public domain | "USGS 3D Elevation Program (3DEP)" (courtesy credit) |
| NYC Open Data BUILDING footprints | `5zhs-2jue`, fetched 2026-10-29 (53,970 in the box; 49,717 kept) | building footprints, HEIGHT_ROOF heights; ground_elevation for the DEM cross-check | NYC Open Data terms of use | "City of New York, NYC Open Data" |
| WorldPop | R2025A v1, USA 2025, 100 m constrained | people per cell | CC BY 4.0 | "WorldPop (www.worldpop.org), University of Southampton. R2025A v1, DOI:10.5258/SOTON/WP00839" |
| OpenStreetMap contributors | Geofabrik New York extract 2026-10-28 | roads, shelters, places | ODbL 1.0 | "© OpenStreetMap contributors" linked to openstreetmap.org/copyright |
| NOAA / NWS ASOS (LaGuardia, Central Park) | hourly precipitation, 1 Sep 2021 (Eng A) | Ida rainfall for the presets | US public domain | "NOAA NCEI / NWS ASOS" |
| NYC 311 Service Requests | `erm2-nwe9`, flood complaints 1–3 Sep 2021 (Eng A, #104) | validation (hit rate) | NYC Open Data terms of use | "City of New York, NYC 311 via NYC Open Data" |

## Planned — not yet wired up

Each row needs its licence re-read against *our* use (public web demo, possibly commercial-adjacent)
before the data lands. Add the credit line to the UI in the same commit as the data.

| Source | Use | Licence / terms | Notes |
|---|---|---|---|
| Sentinel-1 (Copernicus), via Microsoft Planetary Computer | validation flood extent (30 Jun 2026 event) | RTC: CC BY 4.0; GRD: Copernicus legal notice | "Contains modified Copernicus Sentinel data [year]" |
| Google Maps 2D Satellite (Map Tiles API, our own key; ion asset 3830182 as a second path) | judges-only Aerial option beside Bing (owner rule: Bing for everyone, Google for judges) | Google Map Tiles API terms | Google logo and imagery attributions in Cesium's on-screen credit display. Key: Secret Manager `google-tiles-key`, restricted to the Map Tiles API and our referrers, capped at 3,000 2D tiles/day (free tier: 100k/month). Move to In use when Eng B's toggle is live |

## Excluded

| Source | Why |
|---|---|
| FABDEM | CC BY-NC-SA 4.0. Non-commercial and share-alike. Do not ship it in a public demo; use Copernicus DEM instead. |
| `tile.openstreetmap.org` raster tiles | OSMF tile usage policy forbids heavy application use. Serve basemap imagery through Cesium ion. |
