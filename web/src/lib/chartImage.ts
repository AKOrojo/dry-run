// Saves a chart SVG as a PNG at 2x: the title and the area name above it, on the theme's ground colour. The SVG's CSS
// variables are resolved from the page first, since an SVG drawn as an image cannot see the page's stylesheet.
import { resolveVars } from "./chartdata";

export async function chartPng({ svg, title, area }: { svg: SVGSVGElement; title: string; area: string }): Promise<string> {
  const cs = getComputedStyle(svg);
  const lookup = (name: string) => cs.getPropertyValue(name).trim();
  const W = svg.width.baseVal.value, H = svg.height.baseVal.value;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // Values go inside attributes: a font list's double quotes would end the attribute, single quotes are the same CSS.
  const markup = resolveVars(new XMLSerializer().serializeToString(copy), (name) => lookup(name).replace(/"/g, "'"));
  const pad = 16, head = 52, scale = 2;
  const cw = W + 2 * pad, ch = head + H + pad;
  const canvas = document.createElement("canvas");
  canvas.width = cw * scale;
  canvas.height = ch * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas");
  ctx.scale(scale, scale);
  const font = lookup("--font-sans") || "sans-serif";
  ctx.fillStyle = lookup("--ground") || "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = lookup("--ink") || "#000000";
  ctx.font = `600 14px ${font}`;
  ctx.fillText(title, pad, pad + 12);
  ctx.fillStyle = lookup("--ink-muted") || "#666666";
  ctx.font = `400 12px ${font}`;
  ctx.fillText(area, pad, pad + 30);
  const img = new Image();
  await new Promise<void>((ok, bad) => {
    img.onload = () => ok();
    img.onerror = () => bad(new Error("The chart would not draw"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
  ctx.drawImage(img, pad, head, W, H);
  return canvas.toDataURL("image/png");
}
