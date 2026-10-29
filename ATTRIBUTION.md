# Data & model attribution

Owner: Eng D. **Status is the honest one, not the aspirational one** — move a row to "In use" only
once the data is actually in the pipeline and the required credit line is visible in the app.

## In use

| Source | Use | Licence / terms | Required credit |
|---|---|---|---|
| Synthetic fixtures (`dryrun.pipeline.fixtures`) | default AOI, demo runs | ours | badged "Synthetic terrain" in the UI |
| Muse Spark Open | sovereign-mode agent | Muse Model License | "Built with Muse Spark Open" (in the app footer) |

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

## Planned — not yet wired up

Each row needs its licence re-read against *our* use (public web demo, possibly commercial-adjacent)
before the data lands. Add the credit line to the UI in the same commit as the data.

| Source | Use | Licence / terms | Notes |
|---|---|---|---|
| Sentinel-1 (Copernicus), via Microsoft Planetary Computer | validation flood extent (30 Jun 2026 event) | RTC: CC BY 4.0; GRD: Copernicus legal notice | "Contains modified Copernicus Sentinel data [year]" |
| Cesium ion / basemap imagery | basemap | Community tier is non-commercial only; ion token restricted by URL | open question: the demo may be commercial-adjacent |

## Excluded

| Source | Why |
|---|---|
| FABDEM | CC BY-NC-SA 4.0. Non-commercial and share-alike. Do not ship it in a public demo; use Copernicus DEM instead. |
| `tile.openstreetmap.org` raster tiles | OSMF tile usage policy forbids heavy application use. Serve basemap imagery through Cesium ion. |
