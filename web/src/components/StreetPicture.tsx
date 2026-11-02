// Street picture (board 12): Inspect tab, a spot pinned, Compare A and B set. Makes (or opens the cached) before/after
// pair for the spot with POST /api/render, and shows it as a swipe with the model's depth beside the depth each picture
// shows. The large view opens over the page, also from a copied link (?render=).
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArrowsLeftRight, ArrowsOut, Camera, Copy, Spinner, Square, Warning, X } from "@phosphor-icons/react";
import { API, ApiError, getPointInfo, getPointSeries, getRun, postRender, setJudgeKey, getJudgeKey } from "../lib/api";
import type { AOIManifest, RunManifest } from "../lib/api";
import { requestUnpin, usePinnedSpot } from "../lib/inspect";
import { useLockout } from "../lib/lockout";
import { useBreakpoint, useTouch } from "../lib/breakpoint";
import { checkPhoto } from "../lib/observations";
import {
  aboutMetres, clockText, DRY, fitBox, imageUrl, isDryInBoth, legendLine, makingNote, metres, mismatchNote, openLarge, renderLink, renderProblem,
  sourceNote, useLarge,
} from "../lib/streetpic";
import type { RenderResult, RenderView, StreetProblem } from "../lib/streetpic";
import { Card, FIG, Segmented, srOnly } from "./rev5";
import { Button } from "./controls/Button";
import { TextField } from "./controls/TextField";
import { LockoutNote } from "./LockoutNote";
import { Notice } from "./Notice";
import { runWhat } from "./Compare";

const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12 };
const label: CSSProperties = { color: "var(--ink-muted)" };
const value: CSSProperties = { fontWeight: 600, textAlign: "right", ...FIG };
const note: CSSProperties = { fontSize: 12, lineHeight: "16px", color: "var(--ink-muted)" };
const btn: CSSProperties = { height: 30, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6 };
const SPIN = "@keyframes dr-sp-spin{to{transform:rotate(360deg)}}@keyframes dr-sp-indet{0%{left:-40%}100%{left:100%}}";
const ACCEPT = "image/jpeg,image/png,image/webp";

/** Before/after swipe: the after picture is drawn right of the divider. Drag it, or focus it and use the arrow keys.
 *  `size` sets the box in px (the phone's large view, at the picture's own aspect ratio); otherwise it is 16:9 at full width. */
/** The picture's own shape, from the before image (both are drawn at the same size); 16:9 until it has loaded. A street
 *  picture is never cropped: every box that shows one takes this aspect. */
function useImageAspect(url: string) {
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    const img = new Image();
    img.onload = () => { if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight); };
    img.src = url;
    return () => { img.onload = null; };
  }, [url]);
  return aspect;
}

function BeforeAfter({ r, beforeLabel, afterLabel, large = false, size }: { r: RenderResult; beforeLabel: string; afterLabel: string; large?: boolean; size?: { w: number; h: number } }) {
  const [split, setSplit] = useState(0.5);
  const aspect = useImageAspect(imageUrl(API, r.before.url));
  // In the card the picture is at most this tall (full size is for Open large); its width follows the aspect.
  const cap = useBreakpoint() === "phone" ? "min(50vh, 420px)" : "360px";
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const at = (x: number) => { const b = box.current?.getBoundingClientRect(); if (b) setSplit(Math.min(1, Math.max(0, (x - b.left) / b.width))); };
  const onDown = (e: ReactPointerEvent) => { drag.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); at(e.clientX); };
  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const next = e.key === "ArrowLeft" ? split - step : e.key === "ArrowRight" ? split + step : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
    if (next == null) return;
    e.preventDefault();
    setSplit(Math.min(1, Math.max(0, next)));
  };
  const tag: CSSProperties = { position: "absolute", top: 8, padding: "2px 7px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb, var(--ground) 82%, transparent)",
    color: "var(--ink)", fontSize: large ? 12 : 11, lineHeight: "16px", fontWeight: 600, whiteSpace: "nowrap", pointerEvents: "none", ...FIG,
    // Each label keeps to its half, so the two never run into each other; an ellipsis is the last resort.
    maxWidth: "calc(50% - 12px)", overflow: "hidden", textOverflow: "ellipsis", boxSizing: "border-box" };
  const swipe = (
    <div ref={box} onPointerDown={onDown} onPointerMove={(e) => { if (drag.current) at(e.clientX); }} onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}
      style={{ position: "relative", ...(size ? { width: size.w, height: size.h, flex: "none" } : { width: "100%", maxWidth: `calc(${cap} * ${aspect})`, aspectRatio: String(aspect) }), overflow: "hidden", borderRadius: "var(--radius-sm)", background: "var(--ground)", touchAction: "none", cursor: "ew-resize", userSelect: "none" }}>
      <img src={imageUrl(API, r.before.url)} alt={`Before: ${beforeLabel}`} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
      <img src={imageUrl(API, r.after.url)} alt={`After: ${afterLabel}`} draggable={false}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", clipPath: `inset(0 0 0 ${split * 100}%)` }} />
      <span style={{ ...tag, left: 8 }}>{beforeLabel}</span>
      <span style={{ ...tag, right: 8 }}>{afterLabel}</span>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${split * 100}%`, width: 2, marginLeft: -1, background: "var(--ink)", pointerEvents: "none" }} />
      <div role="slider" tabIndex={0} aria-label="Before and after divider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split * 100)}
        aria-valuetext={`${Math.round(split * 100)}% before`} onKeyDown={onKey}
        style={{ position: "absolute", top: "50%", left: `${split * 100}%`, width: 28, height: 28, margin: "-14px 0 0 -14px", display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: "50%", background: "var(--surface)", border: "1px solid var(--control-edge)", boxShadow: "var(--raised-shadow)", color: "var(--ink)" }}>
        <ArrowsLeftRight size={14} aria-hidden="true" />
      </div>
    </div>
  );
  return size ? swipe : <div style={{ display: "flex", justifyContent: "center", borderRadius: "var(--radius-sm)", background: "var(--ground)" }}>{swipe}</div>;
}

/** "A · Baseline" from the run, or "A" while the run is loading (a link opened without Compare). */
const side = (letter: "A" | "B", m?: RunManifest) => (m ? `${letter} · ${runWhat(m)}` : letter);

/** The made pair: swipe, what it is, model vs picture depths, the mismatch note, the changes, Open large and Copy link. */
function Made({ r, a, b }: { r: RenderResult; a?: RunManifest; b?: RunManifest }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const off = mismatchNote(r);
  const changes = [...(r.changes_here ?? []), ...(r.changes_elsewhere ?? [])];
  const copy = async () => {
    try { await navigator.clipboard.writeText(renderLink(location.href, r.aoi_id, r.render_id)); setCopied("yes"); } catch { setCopied("no"); }
    window.setTimeout(() => setCopied(null), 2500);
  };
  const cell = (hl = false): CSSProperties => ({ ...FIG, fontWeight: 600, color: hl ? "var(--danfo)" : "var(--ink)" });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <BeforeAfter r={r} beforeLabel={`Before · ${metres(r.before.depth_m)}`} afterLabel={`After · ${metres(r.after.depth_m)}`} />
      <span style={note}>{sourceNote(r)}</span>
      <table style={{ borderCollapse: "collapse", fontSize: 13, lineHeight: "18px" }}>
        <thead>
          <tr style={{ color: "var(--ink-muted)", fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            <th style={{ textAlign: "left", fontWeight: 500, padding: "0 8px 4px 0" }}><span style={srOnly}>Picture</span></th>
            <th style={{ textAlign: "left", fontWeight: 500, padding: "0 8px 4px" }}>Model</th>
            <th style={{ textAlign: "left", fontWeight: 500, padding: "0 0 4px 8px" }}>Picture shows</th>
          </tr>
        </thead>
        <tbody>
          {(["before", "after"] as const).map((k) => (
            <tr key={k}>
              <th scope="row" style={{ textAlign: "left", fontWeight: 400, color: "var(--ink-muted)", padding: "2px 8px 2px 0" }}>{k === "before" ? "Before" : "After"}</th>
              <td style={{ padding: "2px 8px", ...cell() }}>{metres(r[k].depth_m)}</td>
              <td style={{ padding: "2px 0 2px 8px", ...cell(r[k].picture_matches === false) }}>{aboutMetres(r[k].picture_depth_m ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {off && (
        <div role="note" style={{ display: "flex", gap: 8, padding: "8px 12px", borderLeft: "3px solid var(--danfo)", background: "color-mix(in srgb, var(--danfo) 10%, var(--surface))", fontSize: 12, lineHeight: "16px" }}>
          <Warning size={14} weight="bold" aria-hidden="true" style={{ flex: "none", marginTop: 1, color: "var(--danfo)" }} />
          <span>The {off.which} picture shows about <b style={FIG}>{metres(off.shows)}</b> of water; the model’s depth here is <b style={FIG}>{metres(off.model)}</b>. Image models draw less water than asked, so read the numbers, not the picture.</span>
        </div>
      )}
      {changes.length > 0 && (
        <ul aria-label="Changes" style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
          {changes.map((c) => <li key={c} style={{ padding: "2px 8px", border: "1px solid var(--hairline)", borderRadius: 999, fontSize: 12, lineHeight: "18px" }}>{c}</li>)}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="raised" data-street-main="" onClick={() => openLarge(r, { a, b })} style={btn}><ArrowsOut size={14} aria-hidden="true" />Open large</Button>
        <Button variant="raised" onClick={copy} style={btn}><Copy size={14} aria-hidden="true" />Copy link</Button>
        <span role="status" style={note}>{copied === "yes" ? "Link copied" : copied === "no" ? "Could not copy the link" : ""}</span>
      </div>
    </div>
  );
}

export function StreetPictureCard({ aoi, a, b }: { aoi?: AOIManifest; a: RunManifest; b: RunManifest }) {
  const spot = usePinnedSpot();
  const touch = useTouch();
  const lock = useLockout();
  const [view, setView] = useState<RenderView>("street");
  const [place, setPlace] = useState<string | null>(null);
  const [phase, setPhase] = useState<"ready" | "making" | "made">("ready");
  const [result, setResult] = useState<RenderResult | null>(null);
  const [problem, setProblem] = useState<StreetProblem | null>(null);
  const [askKey, setAskKey] = useState(false);
  const [key, setKey] = useState(getJudgeKey);
  const [secs, setSecs] = useState(0);
  // Stop only stops waiting: the server still finishes and caches the pair, so the next Make opens it at once.
  const [stopped, setStopped] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);
  const lastPhoto = useRef<File | null>(null);

  // A new spot, runs or view starts over (and stops a pair being made for the old one).
  useEffect(() => {
    ctl.current?.abort();
    setPhase("ready"); setResult(null); setProblem(null); setAskKey(false); setStopped(false);
  }, [spot?.lon, spot?.lat, a.run_id, b.run_id, view]);
  useEffect(() => () => { ctl.current?.abort(); }, []);
  useEffect(() => {
    setPlace(null);
    if (!aoi || !spot) return;
    let off = false;
    getPointInfo(aoi.aoi_id, spot.lon, spot.lat).then((i) => { if (!off && i?.place) setPlace(i.place.inside ? i.place.name : `near ${i.place.name}`); });
    return () => { off = true; };
  }, [aoi?.aoi_id, spot?.lon, spot?.lat]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phase !== "making") return;
    const id = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);
  useEffect(() => { if (askKey) keyRef.current?.focus(); }, [askKey]);
  // Each change of state brings its main action ([data-street-main]: Make, Stop or Open large) into view, so a line that
  // appears above it (Stopped waiting…, a problem) never leaves it under a phone's tab bar or a sheet's edge.
  const card = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  useEffect(() => {
    if (!shown.current) { shown.current = true; return; }
    requestAnimationFrame(() => card.current?.querySelector<HTMLElement>("[data-street-main]")?.scrollIntoView({ block: "nearest" }));
  }, [phase, stopped, problem, askKey]);

  const make = async (photo: File | null) => {
    if (!spot) return;
    if (photo) { const bad = checkPhoto(photo); if (bad) { setProblem({ title: bad.title.replace(/\.$/, ""), detail: bad.next, action: "ok" }); return; } }
    lastPhoto.current = photo;
    const ac = new AbortController();
    ctl.current = ac;
    setProblem(null); setAskKey(false); setStopped(false); setSecs(0); setPhase("making");
    try {
      // No water in either run: say so before asking for the key or spending an image call.
      const [sa, sb] = await Promise.all([getPointSeries(a.run_id, spot.lon, spot.lat), getPointSeries(b.run_id, spot.lon, spot.lat)]);
      if (ac.signal.aborted) return;
      if (isDryInBoth(sa?.max_depth_m, sb?.max_depth_m)) { setProblem(DRY); setPhase("ready"); return; }
      const form = new FormData();
      form.append("base_run_id", a.run_id);
      form.append("alt_run_id", b.run_id);
      form.append("lon", String(spot.lon));
      form.append("lat", String(spot.lat));
      form.append("view", view);
      if (photo) form.append("file", photo, photo.name);
      const r = await postRender(form, ac.signal);
      setResult(r); setPhase("made");
    } catch (e) {
      if ((e as Error).name === "AbortError") { if (ctl.current === ac) setPhase("ready"); return; }
      const err = e instanceof ApiError ? e : null;
      setProblem(renderProblem(err?.status ?? 0, err?.message ?? "", err?.retryAfterS, new Date(), !!err?.lockout));
      setPhase("ready");
    } finally {
      if (ctl.current === ac) ctl.current = null;
    }
  };

  const act = (p: StreetProblem) => {
    if (p.action === "spot") { setProblem(null); requestUnpin(); }
    else if (p.action === "key") setAskKey(true);
    else setProblem(null);
  };
  const useKey = () => { if (!key.trim() || lock) return; setJudgeKey(key.trim()); void make(lastPhoto.current); };

  const head = phase === "made" && result?.cached ? <span style={{ marginLeft: "auto", ...note }}>Made earlier · opened at once</span> : undefined;
  return (
    <div data-tour="street" ref={card}>
      <Card title="Street picture" right={head}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px 14px", fontSize: 13, lineHeight: "18px" }}>
          {!spot ? (
            <span style={note}>{touch ? "Tap" : "Click"} a street on the map to pin a spot, then see it as a street picture, before and after your change.</span>
          ) : phase === "making" ? (
            <>
              <style>{SPIN}</style>
              <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                <span style={{ display: "flex", animation: "dr-sp-spin 1s linear infinite" }}><Spinner size={16} aria-hidden="true" /></span>
                Making the pictures…
              </div>
              <div style={{ position: "relative", height: 4, overflow: "hidden", borderRadius: 2, background: "var(--hairline)" }}>
                <span style={{ position: "absolute", top: 0, bottom: 0, width: "40%", background: "var(--depth-3)", animation: "dr-sp-indet 1.4s ease-in-out infinite" }} />
              </div>
              <div style={{ ...row, ...note, ...FIG }}><span>{clockText(secs)}</span><span>{makingNote(secs)}</span></div>
              <span style={note}>It draws the before picture, then the after picture, then checks the water in both against the model.</span>
              <div><Button variant="raised" data-street-main="" onClick={() => { setStopped(true); ctl.current?.abort(); }} style={btn}><Square size={12} weight="fill" aria-hidden="true" />Stop</Button></div>
            </>
          ) : phase === "made" && result ? (
            <Made r={result} a={a} b={b} />
          ) : (
            <>
              <span style={note}>See this spot as a street picture, before and after your change. The model draws the water at the depth the simulation found.</span>
              <div style={row}><span style={label}>Spot</span><span style={value}>{place ?? `${spot.lat.toFixed(5)}, ${spot.lon.toFixed(5)}`}</span></div>
              <div style={row}><span style={label}>Before</span><span style={value}>{side("A", a)}</span></div>
              <div style={row}><span style={label}>After</span><span style={value}>{side("B", b)}</span></div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ ...note, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" }}>View</span>
                <Segmented<RenderView> options={[{ value: "street", label: "Street" }, { value: "window", label: "From a window" }]} active={view} onChange={setView} />
              </div>
              {stopped && <span role="status" style={note}>Stopped waiting. If the pictures finish, Make the pictures opens them at once.</span>}
              {problem && (
                <Notice message={problem.title} detail={problem.detail}>
                  {problem.action === "key" && askKey ? null : (
                    <Button variant="raised" onClick={() => act(problem)} style={btn}>{problem.action === "spot" ? "Pick another spot" : problem.action === "key" ? "Enter the judge key" : "OK"}</Button>
                  )}
                </Notice>
              )}
              {askKey && (
                <form onSubmit={(e) => { e.preventDefault(); useKey(); }} style={{ display: "flex", gap: 6 }}>
                  <TextField ref={keyRef} type="password" autoComplete="off" placeholder="Paste the judge key" aria-label="Judge key" value={key} onChange={(e) => setKey(e.target.value)}
                    style={{ flex: 1, height: 30, padding: "0 8px", fontSize: 12 }} />
                  <Button variant="raised" type="submit" data-street-main="" disabled={!key.trim() || !!lock} style={btn}>Make the pictures</Button>
                </form>
              )}
              {askKey && lock && <LockoutNote lock={lock} />}
              {!askKey && (
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <Button variant="danfo" data-street-main="" onClick={() => void make(null)} style={btn}><Camera size={16} aria-hidden="true" />Make the pictures</Button>
                  <Button variant="text" onClick={() => input.current?.click()} style={{ padding: 0, color: "var(--ink-muted)" }}>Use my own photo</Button>
                </div>
              )}
              <input ref={input} type="file" accept={ACCEPT} capture={touch ? "environment" : undefined} style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void make(f); }} />
              <span style={note}>One to one and a half minutes. A new pair needs the judge key; pictures someone already made open at once.</span>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

/** The large view, over the page: the swipe at full width with each side's run and model depth. Esc or × closes it. */
export function StreetLarge() {
  const open = useLarge();
  const r = open?.r;
  const phone = useBreakpoint() === "phone";
  const [runs, setRuns] = useState<{ a?: RunManifest; b?: RunManifest }>({});
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!r) return;
    let off = false;
    setRuns({ a: open?.a, b: open?.b });
    if (!open?.a || !open?.b) {
      Promise.all([getRun(r.request.base_run_id).catch(() => undefined), getRun(r.request.alt_run_id).catch(() => undefined)])
        .then(([a, b]) => { if (!off) setRuns({ a, b }); });
    }
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { off = true; window.removeEventListener("keydown", onKey, true); };
  }, [r?.render_id]);  // eslint-disable-line react-hooks/exhaustive-deps
  // The phone view covers the page: the page under it does not scroll while it is open.
  useEffect(() => {
    if (!r || !phone) return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = was; };
  }, [r?.render_id, phone]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  function shut() {
    openLarge(null);
    // A link that opened this view leaves the address bar as the page without ?render=.
    const u = new URL(location.href);
    if (u.searchParams.has("render")) { u.searchParams.delete("render"); history.replaceState(history.state, "", u.toString()); }
    const from = open?.from as HTMLElement | null | undefined;
    if (from?.isConnected) from.focus();
  }
  const where = r!.place ?? "This spot";
  if (phone) return <PhoneLarge r={r} runs={runs} where={where} close={close} shut={shut} />;
  return <DesktopLarge r={r} runs={runs} where={where} close={close} shut={shut} />;
}

const LARGE_MAX_W = 1040, LARGE_GUTTER = 16, LARGE_PAD = 14;
/** The desktop large view: a dialog over the page with the picture as large as the window allows at its own aspect. */
function DesktopLarge({ r, runs, where, close, shut }: {
  r: RenderResult; runs: { a?: RunManifest; b?: RunManifest }; where: string; close: React.RefObject<HTMLButtonElement>; shut: () => void;
}) {
  const head = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight, head: 0 });
  useEffect(() => {
    const measure = () => setWin({ w: window.innerWidth, h: window.innerHeight, head: head.current?.offsetHeight ?? 0 });
    measure();
    const ro = new ResizeObserver(measure);
    if (head.current) ro.observe(head.current);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const aspect = useImageAspect(imageUrl(API, r.before.url));
  // The room is the dialog's content area: the window less the gutters, the dialog's border and padding, and the title bar.
  const size = fitBox(Math.min(LARGE_MAX_W, win.w - 2 * LARGE_GUTTER) - 2 - 2 * LARGE_PAD,
    win.h - 2 * LARGE_GUTTER - 2 - win.head - 2 * LARGE_PAD, aspect);
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) shut(); }}
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: LARGE_GUTTER,
        background: "color-mix(in srgb, var(--ground) 72%, transparent)" }}>
      <div role="dialog" aria-modal="true" aria-label={`${where} · street picture`}
        style={{ width: `min(${LARGE_MAX_W}px, 100%)`, maxHeight: "100%", overflow: "auto", display: "flex", flexDirection: "column", background: "var(--surface)",
          border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)" }}>
        <div ref={head} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--hairline)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{where} · street picture</span>
          <span style={note}>{r.label ?? "AI illustration, not a measurement"}</span>
          <Button ref={close} variant="icon" aria-label="Close" onClick={shut}
            style={{ marginLeft: "auto", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)" }}><X size={16} aria-hidden="true" /></Button>
        </div>
        <div style={{ padding: LARGE_PAD, display: "flex", justifyContent: "center" }}>
          {size.w > 0 && <BeforeAfter large r={r} size={size} beforeLabel={`Before · ${side("A", runs.a)} · model ${metres(r.before.depth_m)}`}
            afterLabel={`After · ${side("B", runs.b)} · model ${metres(r.after.depth_m)}`} />}
        </div>
      </div>
    </div>
  );
}

/** The phone's large view: the whole screen on the ground colour, the title and Close on top, the picture as large as it
 *  fits at its own aspect ratio (short side labels on it), and each side's run and model depth in a legend under it. */
function PhoneLarge({ r, runs, where, close, shut }: {
  r: RenderResult; runs: { a?: RunManifest; b?: RunManifest }; where: string; close: React.RefObject<HTMLButtonElement>; shut: () => void;
}) {
  const room = useRef<HTMLDivElement>(null);
  const [roomSize, setRoomSize] = useState({ w: 0, h: 0 });
  const aspect = useImageAspect(imageUrl(API, r.before.url));
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setRoomSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const size = fitBox(roomSize.w, roomSize.h, aspect);
  const legend: CSSProperties = { ...FIG, fontSize: 13, lineHeight: "18px", color: "var(--ink)", overflowWrap: "anywhere" };
  return (
    <div role="dialog" aria-modal="true" aria-label={`${where} · street picture`}
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", flexDirection: "column", background: "var(--ground)",
        padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 4px 0 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0, paddingTop: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15, lineHeight: "20px" }}>{where} · street picture</span>
          <span style={note}>{r.label ?? "AI illustration, not a measurement"}</span>
        </div>
        <Button ref={close} variant="icon" aria-label="Close" onClick={shut}
          style={{ flex: "none", width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink)" }}><X size={20} aria-hidden="true" /></Button>
      </div>
      <div ref={room} style={{ flex: "1 1 auto", minHeight: 0, margin: "12px 16px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {size.w > 0 && <BeforeAfter large r={r} size={size} beforeLabel="Before · A" afterLabel="After · B" />}
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", margin: "0 16px 16px" }}>
        <dt style={{ ...note, fontSize: 13, lineHeight: "18px" }}>Before</dt><dd style={{ ...legend, margin: 0 }}>{legendLine("A", runs.a && runWhat(runs.a), r.before.depth_m)}</dd>
        <dt style={{ ...note, fontSize: 13, lineHeight: "18px" }}>After</dt><dd style={{ ...legend, margin: 0 }}>{legendLine("B", runs.b && runWhat(runs.b), r.after.depth_m)}</dd>
      </dl>
    </div>
  );
}
