// Brief state: verified brief card, impassable-road bar chart, claims list.
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { Card, FIG, mono } from "../rev5";
import { Pad } from "./bits";

type Claim = { text: string; value?: number | null; model_value?: number | null; unit?: string; source_run_id?: string; field?: string; verified?: boolean };

const num = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 3 });

export function barClaims(claims: Claim[]): Claim[] {
  const area = claims.filter((c) => /^area:.+:road_km_impassable$/.test(c.field ?? "") && c.value != null);
  if (area.length) return area;
  return claims.filter((c) => c.field === "road_km_impassable" && c.value != null);
}

export function briefText(b: any): string {
  const lines = (b.claims as Claim[]).map((c) =>
    `- ${c.text}${c.value != null ? `: ${num(c.value)} ${c.unit ?? ""}`.trimEnd() : ""}${c.verified ? "" : " (unverified)"}`);
  return [b.title, "", b.summary, "", ...lines].join("\n");
}

export function BriefCard({ brief }: { brief: any }) {
  const claims: Claim[] = brief.claims ?? [];
  const nVer = claims.filter((c) => c.verified).length;
  const bars = barClaims(claims);
  const max = Math.max(...bars.map((c) => c.value as number), 0);
  const unit = bars[0]?.unit ?? "";
  return (
    <Card title="Brief" right={<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 600, color: "var(--verified)" }}>
      <CheckCircle size={14} weight="bold" aria-hidden="true" />{nVer} of {claims.length} verified</span>}>
      <Pad gap={10}>
        <h3 style={{ margin: 0, fontSize: 16, lineHeight: "22px", fontWeight: 600 }}>{brief.title}</h3>
        <p style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: "var(--ink-muted)" }}>{brief.summary}</p>
        {brief.recommended_run_id == null && (
          <div role="note" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", borderRadius: "var(--radius-md)",
            background: "color-mix(in srgb, var(--hazard) 14%, var(--surface))", fontSize: 13, lineHeight: "18px" }}>
            <Warning size={16} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--hazard)", marginTop: 1 }} />
            No tested option fully meets the goal.
          </div>
        )}
      </Pad>
      {bars.length > 0 && (
        <div style={{ borderTop: "1px solid var(--hairline)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 12, color: "var(--ink-muted)" }}><span>Impassable road, by run</span><span style={{ marginLeft: "auto" }}>{unit}</span></div>
          {bars.map((c, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", columnGap: 12, rowGap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 13 }}>{cap(c.text)}</span>
              <span style={{ ...FIG, fontSize: 13, fontWeight: 600, textAlign: "right", gridRow: "1 / span 2", gridColumn: 2 }}>{num(c.value as number)} {c.unit}</span>
              <div style={{ height: 6, borderRadius: 3, background: "var(--ground)", boxShadow: "var(--inset-shadow)" }}>
                <div style={{ height: "100%", width: `${max > 0 ? Math.max(2, ((c.value as number) / max) * 100) : 0}%`, background: "var(--hazard)", borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ borderTop: "1px solid var(--hairline)", padding: "8px 14px", fontSize: 12, color: "var(--ink-muted)" }}>{brief.provider} · {brief.model}</div>
    </Card>
  );
}

export function ClaimsCard({ brief }: { brief: any }) {
  const claims: Claim[] = brief.claims ?? [];
  const rest = claims.length - 3;
  return (
    <Card title="Claims">
      {claims.slice(0, 3).map((c, i) => {
        const ok = !!c.verified;
        return (
          <div key={i} style={{ display: "flex", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--hairline)", opacity: ok ? 1 : 0.7 }}>
            {ok ? <CheckCircle size={18} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--verified)" }} />
                : <Warning size={18} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 14, lineHeight: "20px" }}>{cap(c.text)}</span>
              <span style={{ fontSize: 12, color: ok ? "var(--verified)" : "var(--ink-muted)" }}>
                {ok ? "✓ verified" : "⚠ unverified"}
                {c.source_run_id && <> · <span style={{ fontFamily: mono }}>{c.source_run_id}</span></>}
                {!ok && c.model_value != null && <> · model said {num(c.model_value)} {c.unit}</>}
              </span>
            </div>
            {c.value != null && <span style={{ ...FIG, fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}>{num(c.value)} {c.unit}</span>}
          </div>
        );
      })}
      {rest > 0 && <div style={{ padding: "10px 14px", fontSize: 13, color: "var(--ink-muted)" }}>{rest} more claims</div>}
    </Card>
  );
}

/** Sentence case for claim text the model writes in lower case. */
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
