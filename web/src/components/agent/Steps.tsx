// Working state: vertical stepper built from the tool_call / tool_result stream.
import { Check, ChartBar, GitDiff, Info, Lightning, Path, Play, CircleNotch, Note } from "@phosphor-icons/react";
import type { AgentEvent } from "../../lib/api";
import { FIG, mono } from "../rev5";
import { Badge } from "./bits";
import { Tooltip } from "../controls/Tooltip";
import { Button } from "../controls/Button";

export const TOOLS: Record<string, { Icon: typeof Info; label: string }> = {
  get_aoi_info: { Icon: Info, label: "Read the study area" },
  run_simulation: { Icon: Play, label: "Ran a simulation" },
  get_run_stats: { Icon: ChartBar, label: "Read run stats" },
  get_area_stats: { Icon: ChartBar, label: "Read stats for a place" },
  surrogate_sweep: { Icon: Lightning, label: "Screened options with the surrogate" },
  compare_runs: { Icon: GitDiff, label: "Compared two runs" },
  compute_route: { Icon: Path, label: "Checked a route" },
};

export type Step = { name: string; args: any; result?: any; t0: number; t1?: number };
export type Budget = { runs_used: number; runs_max: number; elapsed_s: number; deadline_s: number };

export function buildSteps(events: AgentEvent[], ts: number[]): Step[] {
  const steps: Step[] = [];
  events.forEach((e, i) => {
    if (e.kind === "tool_call") steps.push({ name: e.data.name, args: e.data.arguments ?? {}, t0: ts[i] });
    if (e.kind === "tool_result") {
      const s = steps.find((x) => x.name === e.data.name && x.t1 === undefined);
      if (s) { s.result = e.data.result; s.t1 = ts[i]; }
    }
  });
  return steps;
}

/** The server's "phase" event marks the start of the brief call, which can take minutes on a waking model. */
export type Writing = { model: string; t0: number };
export function briefPhase(events: AgentEvent[], ts: number[]): Writing | undefined {
  const i = events.findIndex((e) => e.kind === "phase" && e.data.phase === "brief");
  return i < 0 ? undefined : { model: String(events[i].data.model ?? ""), t0: ts[i] };
}

/** The newest budget; elapsed never reads past the limit (a tool can finish after it). */
export function lastBudget(events: AgentEvent[]): Budget | undefined {
  const b: Budget | undefined = [...events].reverse().find((e) => e.kind === "tool_result" && e.data.budget)?.data.budget;
  return b && { ...b, elapsed_s: Math.min(b.elapsed_s, b.deadline_s) };
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const dur = (ms: number) => ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : mmss(ms / 1000);

function subline(s: Step): string | null {
  const a = s.args ?? {};
  const bits = [a.place ?? a.area, a.label].filter((x) => typeof x === "string" && x);
  return bits.length ? bits.join(" · ") : null;
}

const Indet = () => <div style={{ height: 3, borderRadius: 2, background: "var(--hairline)", overflow: "hidden" }}>
  <div className="dr-indet" style={{ height: "100%", width: "40%", background: "var(--danfo)" }} /></div>;

export function Stepper({ steps, running, thought, now, onRun, writing }:
  { steps: Step[]; running: boolean; thought?: string; now: number; onRun: (id: string) => void; writing?: Writing }) {
  return (
    <div>
      {steps.map((s, i) => {
        const t = TOOLS[s.name] ?? { Icon: Info, label: s.name };
        const active = running && s.t1 === undefined;
        const failed = s.result?.error;
        const runId: string | undefined = s.name === "run_simulation" ? s.result?.run_id : undefined;
        const cached = s.result?.cached === true || s.result?.cache_hit === true;
        const meta = active ? dur(now - s.t0) : cached ? "cached" : s.t1 !== undefined ? dur(s.t1 - s.t0) : "";
        const sub = subline(s);
        const tone = active ? "var(--danfo-text)" : failed ? "var(--hazard)" : "var(--verified)";
        return (
          <div key={i} style={{ display: "flex", gap: 10, padding: "9px 14px", borderBottom: "1px solid var(--hairline)" }}>
            <span style={{ width: 22, height: 22, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%",
              border: `1.5px solid ${active ? "var(--danfo)" : tone}`, color: tone }}>
              {active ? <CircleNotch size={14} weight="bold" className="dr-spin" aria-label="Running" /> : <Check size={12} weight="bold" aria-label="Done" />}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <t.Icon size={14} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />
                <Tooltip text={s.name}><span style={{ fontSize: 14, lineHeight: "20px", fontWeight: active ? 600 : 400 }}>{t.label}</span></Tooltip>
                <span style={{ ...FIG, marginLeft: "auto", fontSize: 13, color: "var(--ink-muted)" }}>{meta}</span>
              </div>
              {runId && (
                <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  <span style={{ fontFamily: mono }}>{runId}</span> · <Button variant="text" type="button" onClick={() => onRun(runId)}
                    style={{ padding: 0, border: 0, background: "none", font: "inherit", color: "var(--ink)", textDecoration: "underline" }}>Show on map</Button>
                </div>
              )}
              {s.name === "surrogate_sweep" && <span><Badge>Screening only</Badge></span>}
              {sub && <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>{sub}</div>}
              {failed && <div style={{ fontSize: 13, color: "var(--hazard)" }}>{String(failed)}</div>}
              {active && <Indet />}
            </div>
          </div>
        );
      })}
      {writing && (
        <div data-agent-writing style={{ display: "flex", gap: 10, padding: "9px 14px", borderBottom: "1px solid var(--hairline)" }}>
          <span style={{ width: 22, height: 22, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%",
            border: "1.5px solid var(--danfo)", color: "var(--danfo-text)" }}>
            <CircleNotch size={14} weight="bold" className="dr-spin" aria-label="Running" />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Note size={14} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />
              <span role="status" style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>Writing the brief{writing.model ? ` · ${writing.model}` : ""}</span>
              <span style={{ ...FIG, marginLeft: "auto", fontSize: 13, color: "var(--ink-muted)" }}>{mmss(Math.max(0, now - writing.t0) / 1000)}</span>
            </div>
            <Indet />
          </div>
        </div>
      )}
      {thought && <p style={{ margin: 0, padding: "12px 14px", fontStyle: "italic", fontSize: 13, lineHeight: "20px", color: "var(--ink-muted)" }}>&ldquo;{thought}&rdquo;</p>}
    </div>
  );
}
