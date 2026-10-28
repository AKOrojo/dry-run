# Data & model attribution

Owner: Eng D. **Status is the honest one, not the aspirational one** — move a row to "In use" only
once the data is actually in the pipeline and the required credit line is visible in the app.

## In use

| Source | Use | Licence / terms | Required credit |
|---|---|---|---|
| Synthetic fixtures (`dryrun.pipeline.fixtures`) | default AOI, demo runs | ours | badged "Synthetic terrain" in the UI |
| Muse Spark Open | sovereign-mode agent | Muse Model License | "Built with Muse Spark Open" (in the app footer) |

Everything the demo currently renders is model output or synthetic. No third-party dataset ships
in this repo.

## Planned — not yet wired up

Each row needs its licence re-read against *our* use (public web demo, possibly commercial-adjacent)
before the data lands. Add the credit line to the UI in the same commit as the data.

| Source | Use | Licence / terms | Notes |
|---|---|---|---|
| OpenStreetMap contributors | roads, drains, shelters | ODbL 1.0 | share-alike on derived DB; "© OpenStreetMap contributors" must be visible |
| Google Open Buildings v3 (+2.5D Temporal) | building footprints/heights | CC BY 4.0 | attribution required |
| Copernicus DEM GLO-30 | terrain | Copernicus DEM licence | free for any use incl. commercial, attribution required |
| ESA WorldCover 10 m | land cover → roughness/infiltration | CC BY 4.0 | attribution required |
| JRC Global Surface Water | permanent water | Copernicus/JRC terms | attribution required |
| WorldPop | population | CC BY 4.0 | attribution required |
| Sentinel-1 (Copernicus) | validation flood extent | Copernicus open licence | attribution required |
| Cesium ion / basemap imagery | basemap | per provider; ion token restricted by URL | keep Cesium + imagery credits visible |

## Excluded

| Source | Why |
|---|---|
| FABDEM | CC BY-NC-SA 4.0. Non-commercial and share-alike. Do not ship it in a public demo; use Copernicus DEM instead. |
| `tile.openstreetmap.org` raster tiles | OSMF tile usage policy forbids heavy application use. Serve basemap imagery through Cesium ion. |
