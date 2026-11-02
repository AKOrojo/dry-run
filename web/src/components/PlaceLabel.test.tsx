import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaceLabel } from "./PlaceLabel";

// The accessible name of a button without aria-label is its text content.
const accessibleName = (html: string) => {
  expect(html).not.toMatch(/<button[^>]*aria-label=/);
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};

describe("place label accessible name", () => {
  it("includes the wet status, not only the name", () => {
    const html = renderToStaticMarkup(createElement(PlaceLabel, { name: "Ajah", sub: ["10 % wet at T+01:40"], selected: false, onClick: () => {} }));
    expect(accessibleName(html)).toBe("Ajah 10 % wet at T+01:40");
  });
  it("is the name alone when there is no status (phone)", () => {
    expect(accessibleName(renderToStaticMarkup(createElement(PlaceLabel, { name: "Ajah", selected: true, onClick: () => {} })))).toBe("Ajah");
  });
});
