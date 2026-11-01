// Observation pins (board 12): uploaded observations on the map, the "Water outline" card a pin opens, and the Inspect card that adds a photo of the water.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Camera, Spinner, X } from "@phosphor-icons/react";
import * as Cesium from "cesium";
import { ApiError, API, getPointInfo, postObservation } from "../lib/api";
import type { AOIManifest, RunManifest } from "../lib/api";
import type { Observation } from "../contracts/gen/Observation";
import { setLayer, useLayers } from "../lib/layers";
import { useClock } from "../lib/clock";
import { useTouch } from "../lib/breakpoint";
import { useLockout } from "../lib/lockout";
import {
  addObservation, agrees, cardHeading, checkPhoto, endAddObservation, openObservation, PROVENANCE, pinLabel, ringColour, sizeMB, uploadProblem,
  useObsUi, waterInPhoto,
} from "../lib/observations";
import type { UploadProblem } from "../lib/observations";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { FIG, Card } from "./rev5";
import { fmtT } from "./ds";
import { Button } from "./controls/Button";
import { LockoutNote } from "./LockoutNote";
import { Notice } from "./Notice";
import { coord } from "./WaypointDetails";

const pillStyle: CSSProperties = {
  padding: "2px 7px", background: "color-mix(in srgb, var(--ground) 86%, transparent)", backdropFilter: "blur(6px)", border: "1px solid var(--hairline)",
  borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", fontSize: 11, whiteSpace: "nowrap", ...FIG,
};

export function ObservationPins({ viewer, scene, anchors, aoiId, list, hidden }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; aoiId?: string; list: Observation[] | null; hidden?: boolean;
}) {
  const on = useLayers().photos.on && !hidden && !!viewer && !!aoiId;
  const { open } = useObsUi();
  const picked = on && list ? list.find((o) => o.obs_id === open) : undefined;
  useEffect(() => {
    if (!picked) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") openObservation(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [picked]);
  if (!on || !list) return null;
  return (
    <>
      {list.map((o) => {
        const agree = agrees(o);
        const isOpen = picked?.obs_id === o.obs_id;
        return (
          <Anchored key={o.obs_id} anchors={anchors} scene={scene} lon={o.lon} lat={o.lat}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Button variant="icon" aria-label={`Observation: ${pinLabel(o)}`} onClick={() => openObservation(isOpen ? null : o.obs_id)}
                style={{ pointerEvents: "auto", width: 26, height: 26, borderRadius: "50%", background: "var(--surface-raised)", border: `2px solid ${ringColour(agree)}`,
                  display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px var(--elev-drop)", color: "var(--ink)", padding: 0, cursor: "pointer" }}>
                <Camera size={14} aria-hidden="true" />
              </Button>
              <span aria-hidden="true" style={{ ...pillStyle, pointerEvents: "none" }}>{pinLabel(o)}</span>
            </span>
            {isOpen && picked && <ObservationCard o={picked} />}
          </Anchored>
        );
      })}
    </>
  );
}

const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12 };
const label: CSSProperties = { color: "var(--ink-muted)" };
const value: CSSProperties = { fontWeight: 600, textAlign: "right", ...FIG };
const note: CSSProperties = { fontSize: 12, lineHeight: "16px", color: "var(--ink-muted)" };

/** The "Pin opened" card: the photo's water outline, what the photo measured and what the model has there. */
function ObservationCard({ o }: { o: Observation }) {
  const water = waterInPhoto(o);
  return (
    <div style={{ position: "absolute", left: 16, top: -10, width: 300, pointerEvents: "auto", background: "var(--surface)", border: "1px solid var(--hairline)",
      borderRadius: 6, boxShadow: "var(--card-shadow)", overflow: "hidden", display: "flex", flexDirection: "column", fontSize: 13, lineHeight: "18px" }}>
      <div style={{ position: "relative", height: 150, background: "var(--ground)" }}>
        {o.mask_png != null && <img src={`${API}/api/observations/${encodeURIComponent(o.obs_id)}/mask.png`} alt="Water outline found in the photo"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />}
        <span style={{ ...pillStyle, position: "absolute", left: 8, bottom: 8 }}>Water outline · photo private</span>
        <Button variant="icon" aria-label="Close" onClick={() => openObservation(null)}
          style={{ position: "absolute", top: 6, right: 6, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-md)",
            background: "color-mix(in srgb, var(--ground) 86%, transparent)", color: "var(--ink)", cursor: "pointer" }}>
          <X size={12} aria-hidden="true" />
        </Button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px 12px" }}>
        <b>{cardHeading(o, o.t_s != null ? fmtT(o.t_s) : null)}</b>
        {water && <div style={row}><span style={label}>Water in the photo</span><span style={value}>{water}</span></div>}
        {o.reference_object && <div style={row}><span style={label}>Measured against</span><span style={value}>{o.reference_object}</span></div>}
        {o.sim_depth_m != null && <div style={row}><span style={label}>Model here</span><span style={value}>{`${o.sim_depth_m.toFixed(2)} m`}</span></div>}
        <span style={note}>{PROVENANCE}</span>
      </div>
    </div>
  );
}

// ============================================================ the Inspect card: add a photo of the water
const SPIN = "@keyframes dr-obs-spin{to{transform:rotate(360deg)}}@keyframes dr-obs-indet{0%{left:-40%}100%{left:100%}}";
const PRIVACY = "The photo goes to SAM 3.1 and Muse Spark to find the water and judge its depth. People are blurred and the location data in the file is removed. The photo is kept private; only the water outline and the depth are shown. Up to 20 an hour.";
const hint: CSSProperties = { margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" };

/** The Inspect tab's add card for the spot in obsUi; keyed by the spot so a new spot starts clean. */
export function AddObservationSlot({ aoi, run }: { aoi?: AOIManifest; run?: RunManifest }) {
  const { spot } = useObsUi();
  if (!spot) return null;
  return <AddObservationCard key={spot.seq} spot={spot} aoi={aoi} run={run} />;
}

function AddObservationCard({ spot, aoi, run }: { spot: { lon: number; lat: number }; aoi?: AOIManifest; run?: RunManifest }) {
  const { t_s } = useClock();
  const touch = useTouch();
  const lock = useLockout();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [phase, setPhase] = useState<"choose" | "ready" | "reading">("choose");
  const [problem, setProblem] = useState<UploadProblem | null>(null);
  const [secs, setSecs] = useState(0);
  const [place, setPlace] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);

  // The place name for the spot (nearest place, as the waypoint cards say).
  useEffect(() => {
    setPlace(null);
    if (!aoi) return;
    let off = false;
    getPointInfo(aoi.aoi_id, spot.lon, spot.lat).then((i) => {
      if (!off && i?.place) setPlace(i.place.inside ? i.place.name : `near ${i.place.name}`);
    });
    return () => { off = true; };
  }, [aoi?.aoi_id, spot.lon, spot.lat]);  // eslint-disable-line react-hooks/exhaustive-deps

  // The preview's object URL is revoked when it is replaced or the card closes.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  // Closing or changing the spot while a photo is being read aborts it.
  useEffect(() => () => { ctl.current?.abort(); }, []);
  useEffect(() => {
    if (phase !== "reading") return;
    const id = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    const bad = checkPhoto(f);
    if (bad) { setProblem(bad); return; }
    setProblem(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setPhase("ready");
  };

  const send = async () => {
    if (!file) return;
    const ac = new AbortController();
    ctl.current = ac;
    setProblem(null);
    setSecs(0);
    setPhase("reading");
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("lon", String(spot.lon));
    form.append("lat", String(spot.lat));
    form.append("t_s", String(Math.round(t_s)));
    if (run?.run_id) form.append("run_id", run.run_id);
    form.append("source", "citizen_photo");
    try {
      const o = await postObservation(form, ac.signal);
      if (aoi) addObservation(aoi.aoi_id, run?.run_id, o);
      setLayer("photos", { on: true });
      openObservation(o.obs_id);
      endAddObservation();
    } catch (e) {
      if ((e as Error).name === "AbortError") { setPhase("ready"); return; }
      setProblem(uploadProblem(e instanceof ApiError ? e.status : 0, e instanceof ApiError ? e.retryAfterS : undefined));
      setPhase("ready");
    } finally {
      ctl.current = null;
    }
  };

  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const spotText = `${coord(spot.lat, spot.lon)}${place ? ` · ${place}` : ""}`;
  const accept = "image/jpeg,image/png,image/webp";

  return (
    <Card title="Add an observation" right={<Button variant="icon" aria-label="Close" onClick={() => { ctl.current?.abort(); endAddObservation(); }}
      style={{ marginLeft: "auto", width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", cursor: "pointer" }}><X size={14} aria-hidden="true" /></Button>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px 14px", fontSize: 13, lineHeight: "18px" }}>
        <div style={row}><span style={label}>Spot</span><span style={{ ...value, fontWeight: 400 }}>{spotText}</span></div>
        <div style={row}><span style={label}>Time</span><span style={{ ...value, fontWeight: 400 }}>{fmtT(t_s)} <span style={{ color: "var(--ink-muted)" }}>· the timeline's time</span></span></div>

        {phase === "reading" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <style>{SPIN}</style>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ display: "flex", animation: "dr-obs-spin 1s linear infinite" }}><Spinner size={18} aria-hidden="true" /></span>
              <span style={{ flex: 1, fontWeight: 600 }}>Finding the water in the photo…</span>
              <span style={{ ...value, fontWeight: 400, color: "var(--ink-muted)" }}>{clock}</span>
            </div>
            <div style={{ position: "relative", height: 4, overflow: "hidden", borderRadius: 2, background: "var(--hairline)" }}>
              <span style={{ position: "absolute", top: 0, bottom: 0, width: "40%", background: "var(--depth-3)", animation: "dr-obs-indet 1.4s ease-in-out infinite" }} />
            </div>
            <span style={note}>Usually under a minute. The pin appears on the map when it is done, and this card opens it.</span>
            <div><Button variant="raised" onClick={() => ctl.current?.abort()} style={{ height: 30, padding: "0 12px" }}>Cancel</Button></div>
          </div>
        ) : (
          <>
            {phase === "ready" && preview && (
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <img src={preview} alt="" style={{ width: 96, height: 64, flex: "none", objectFit: "cover", borderRadius: "var(--radius-sm)", background: "var(--ground)" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{file?.name}</span>
                  <span style={note}>{`${sizeMB(file?.size ?? 0)} MB · only on this device until you send it`}</span>
                  <div><Button variant="text" onClick={() => input.current?.click()} style={{ padding: 0, color: "var(--ink)" }}>Choose another</Button></div>
                </div>
              </div>
            )}
            {phase === "choose" && <div><Button variant="raised" onClick={() => input.current?.click()} style={{ height: 30, padding: "0 12px" }}>Choose a photo</Button></div>}
            {phase === "choose" && <span style={hint}>JPEG, PNG or WebP, up to 8 MB. On a phone this opens the camera.</span>}
            <input ref={input} type="file" accept={accept} capture={touch ? "environment" : undefined} style={{ display: "none" }}
              onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />

            {problem && (problem.key && lock
              ? <LockoutNote lock={lock} />
              : problem.key
                ? <div style={{ padding: "12px 14px", borderLeft: "3px solid var(--danfo)", background: "color-mix(in srgb, var(--danfo) 10%, var(--surface))" }}>{problem.title}</div>
                : <Notice message={problem.title} detail={problem.next} />)}

            {phase === "ready" && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button variant="danfo" onClick={send} style={{ height: 30, padding: "0 12px" }}>Send the photo</Button>
                <Button variant="raised" onClick={() => endAddObservation()} style={{ height: 30, padding: "0 12px" }}>Cancel</Button>
              </div>
            )}
            <span style={note}>{PRIVACY}</span>
          </>
        )}
      </div>
    </Card>
  );
}
