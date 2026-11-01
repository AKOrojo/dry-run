// TextField (docs/design/rev5-ref/Controls.dc.html): key, note, goal and mono coordinates.
import { forwardRef, useState } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode, Ref } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";

type Props = (InputHTMLAttributes<HTMLInputElement> & { multiline?: false }) |
  (TextareaHTMLAttributes<HTMLTextAreaElement> & { multiline: true; type?: never });
export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, Props & { leadingIcon?: ReactNode; mono?: boolean }>(
  function TextField({ multiline, leadingIcon, mono, style, className, type, ...props }, ref) {
    const [shown, setShown] = useState(false);
    const box = { display: "flex", alignItems: multiline ? "stretch" : "center", gap: 8, height: multiline ? "auto" : 32, padding: multiline ? 10 : "0 10px", background: "var(--ground)", border: `1px solid ${props["aria-invalid"] ? "var(--hazard)" : "var(--control-edge)"}`, borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 2px var(--elev-drop-soft)", minWidth: 0, boxSizing: "border-box", ...style } as const;
    const field = { flex: 1, width: "100%", minWidth: 0, padding: 0, border: 0, background: "transparent", color: "var(--ink)", font: "inherit", fontFamily: mono ? "var(--font-mono)" : undefined, outline: "none", resize: "vertical" } as const;
    return <div className={`dr-text-field ${className ?? ""}`} style={box}>
      {leadingIcon}
      {multiline ? <textarea {...props as TextareaHTMLAttributes<HTMLTextAreaElement>} ref={ref as Ref<HTMLTextAreaElement>} style={field} /> :
        <input {...props as InputHTMLAttributes<HTMLInputElement>} ref={ref as Ref<HTMLInputElement>} type={type === "password" && shown ? "text" : type ?? "text"} style={field} />}
      {type === "password" && <button type="button" aria-label={shown ? "Hide key" : "Show key"} aria-pressed={shown} onClick={() => setShown(!shown)} style={{ display: "inline-flex", padding: 0, border: 0, background: "transparent", color: "var(--ink-muted)" }}>{shown ? <EyeSlash size={14} /> : <Eye size={14} />}</button>}
    </div>;
  });
