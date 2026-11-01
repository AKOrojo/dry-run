// Button (board 11): one button for the raised, text, segment, icon and danfo looks. A variant gives only its shared base;
// the call site's style is spread after it, so sizes and overrides stay where they were. One disabled look for every variant.
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { raisedButton } from "../rev5";

type Common = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { type?: "button" | "submit" | "reset" };
export type ButtonProps =
  | (Common & { variant: "raised" })
  | (Common & { variant: "text" })
  | (Common & { variant: "segment"; pressed: boolean })
  | (Common & { variant: "icon"; "aria-label": string })
  | (Common & { variant: "danfo" });
export type ButtonVariant = ButtonProps["variant"];

const textBase: CSSProperties = { background: "transparent", border: 0, color: "var(--ink-muted)", font: "inherit", cursor: "pointer" };
const iconBase: CSSProperties = { background: "transparent", border: 0, padding: 0, cursor: "pointer" };
const danfoBase: CSSProperties = {
  background: "linear-gradient(180deg, color-mix(in srgb, var(--danfo) 88%, white) 0%, var(--danfo) 100%)", color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px var(--elev-drop), 0 2px 6px var(--elev-drop-soft)",
};
// The segmented look: the pressed segment is the inked one.
const segmentBase = (pressed: boolean): CSSProperties => ({
  padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", fontSize: 12,
  ...(pressed ? { background: "var(--pressed-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ground)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)" }),
});

/** The merged style: the variant's base, then the call site's own style, then the one disabled look (it wins). */
export function buttonStyle(variant: ButtonVariant, pressed: boolean, disabled: boolean, style?: CSSProperties): CSSProperties {
  const base = variant === "raised" ? raisedButton : variant === "text" ? textBase : variant === "segment" ? segmentBase(pressed)
    : variant === "icon" ? iconBase : danfoBase;
  return { ...base, ...style, ...(disabled ? { opacity: 0.45, cursor: "default" } : {}) };
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const { variant, type = "button", style, disabled, pressed, ...rest } = props as ButtonProps & { pressed?: boolean; style?: CSSProperties };
  return <button ref={ref} type={type} {...rest} disabled={disabled} style={buttonStyle(variant, !!pressed, !!disabled, style)}
    {...(variant === "segment" ? { "aria-pressed": pressed } : {})} />;
});
