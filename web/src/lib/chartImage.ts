// Saves a chart SVG as a PNG at 2x: the title and the area name above it, on the theme's ground colour. The SVG's CSS
// variables are resolved from the page first, since an SVG drawn as an image cannot see the page's stylesheet, and the
// fonts its text uses go in as data: URLs, since it cannot fetch them either.
import { coversText, resolveVars } from "./chartdata";

const fontData = new Map<string, Promise<string>>();
const dataUrl = (url: string) => {
  let p = fontData.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`font ${r.status}`)))).then((b) => new Promise<string>((ok, bad) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result as string);
      fr.onerror = () => bad(fr.error);
      fr.readAsDataURL(b);
    }));
    p.catch(() => fontData.delete(url));
    fontData.set(url, p);
  }
  return p;
};

/** The page's @font-face rules for the families and weights the SVG's text uses, covering its characters, with each
 *  font file inlined (woff2). */
async function fontFaces(svg: SVGSVGElement): Promise<string> {
  const used = new Set<string>();
  let chars = "";
  for (const t of svg.querySelectorAll("text")) {
    const cs = getComputedStyle(t);
    used.add(`${cs.fontFamily.split(",")[0].trim().replace(/["']/g, "")}|${cs.fontWeight}|${cs.fontStyle}`);
    chars += t.textContent ?? "";
  }
  const faces: Promise<string>[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }  // another origin's sheet
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const st = r.style, family = st.getPropertyValue("font-family").replace(/["']/g, "").trim();
      const weight = st.getPropertyValue("font-weight") || "400", style = st.getPropertyValue("font-style") || "normal";
      if (!used.has(`${family}|${weight}|${style}`) || !coversText(st.getPropertyValue("unicode-range"), chars)) continue;
      const src = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(st.getPropertyValue("src"))?.[1];
      if (!src) continue;
      const url = new URL(src, sheet.href ?? location.href).href;
      faces.push(dataUrl(url).then((d) => `@font-face{font-family:'${family}';font-weight:${weight};font-style:${style};src:url(${d}) format('woff2')}`));
    }
  }
  return (await Promise.all(faces)).join("");
}

export async function chartPng({ svg, title, unit, area }: { svg: SVGSVGElement; title: string; unit: string; area: string }): Promise<string> {
  const cs = getComputedStyle(svg);
  const lookup = (name: string) => cs.getPropertyValue(name).trim();
  const W = svg.width.baseVal.value, H = svg.height.baseVal.value;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const faces = await fontFaces(svg).catch(() => "");
  if (faces) {
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = faces;
    copy.insertBefore(style, copy.firstChild);
  }
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
  const heading = `${title} (${unit})`;
  await Promise.all([document.fonts.load(`600 14px ${font}`, heading), document.fonts.load(`400 12px ${font}`, area)]).catch(() => {});
  ctx.fillStyle = lookup("--ground") || "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = lookup("--ink") || "#000000";
  ctx.font = `600 14px ${font}`;
  ctx.fillText(heading, pad, pad + 12);
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
