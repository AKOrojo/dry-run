// PLACEHOLDER: the map agent replaces this file. It keeps the slot's props stable.
import type { AOIManifest, RunManifest } from "../lib/api";
import { runFileUrl } from "../lib/api";
import { Globe } from "./Globe";

export function MapStage({ aoi, run, frames, tS, ionToken, buildingsUrl, runsBase }: {
  aoi: AOIManifest; run?: RunManifest; frames?: { t_s: number; url: string }[]; tS: number;
  ionToken: string; buildingsUrl?: string; runsBase: string;
}) {
  return <Globe aoi={aoi} frames={frames} tS={tS} ionToken={ionToken} buildingsUrl={buildingsUrl}
    buildingDepthsUrl={run?.building_depths ? runFileUrl(runsBase, run.run_id, run.building_depths) : undefined} />;
}
