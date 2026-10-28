"""Roads, buildings, shelters and named places for a real AOI (owner: Eng D).

roads.graphml  osmnx drive + walk, merged, then nx.Graph(ox.convert.to_undirected(G)) -> SIMPLE
               undirected graph written with nx.write_graphml (osmnx's save_graphml writes a
               MultiDiGraph, which exposure.road_graph rejects). Per edge: length_m, cells (JSON
               [[row,col],...] sampled every <= 1 cell), drive=1 if a drivable way (road_km counts
               drive edges only), bridge=1 for bridge=yes / tunnel (never cut by depth).
               Nodes: x=lon, y=lat, row, col.
buildings      Google Open Buildings v3 (confidence >= 0.8, area >= 25 m2; agree the cap with B Wed AM):
               buildings_index.json {"ids","row","col"} (serving path, no pandas) AND
               buildings_geojson (props id, height_m; 5-decimal coords; SAME ids; gzip it).
               Heights: Open Buildings 2.5D is Earth-Engine-only; without EE use 6 m for all (say so).
shelters       schools / places of worship / community centres in the top 20% of the DEM AND within
               300 m of a road node (routing skips any that are not), labelled "candidate shelter (assumed)".
places         10-15 named neighbourhoods/corridors/low areas: Polygon only (no MultiPolygon), simplified
               to <= 20 vertices, props name + kind (neighbourhood|corridor|low_area|open_land). The agent
               targets interventions and area stats by these names; match meta/media.LAGOS_KEYWORDS.
               Include a few `open_land` places so the agent has somewhere sensible to put ponds.
"""


def build(aoi_id: str) -> None:
    raise NotImplementedError("Eng D Day 1-2")
