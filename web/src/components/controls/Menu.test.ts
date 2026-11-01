import { describe, expect, it } from "vitest";
import { nextIndex, typeahead } from "./Menu";
import type { MenuEntry } from "./Menu";

const noop = () => {};
const list: MenuEntry[] = [
  { kind: "caption", label: "Imagery" },
  { kind: "item", label: "Share link", onSelect: noop },
  { kind: "separator" },
  { kind: "radio", label: "Colour", checked: true, onSelect: noop },
  { kind: "check", label: "Coordinates", disabled: true, onSelect: noop },
  { kind: "item", label: "Clear route", onSelect: noop },
];
// Navigable rows are 1, 3 and 5.

describe("nextIndex", () => {
  it("moves Down and Up over separators, captions and disabled items", () => {
    expect(nextIndex("ArrowDown", 1, list)).toBe(3);
    expect(nextIndex("ArrowDown", 3, list)).toBe(5);
    expect(nextIndex("ArrowUp", 5, list)).toBe(3);
    expect(nextIndex("ArrowUp", 3, list)).toBe(1);
  });

  it("wraps at both ends", () => {
    expect(nextIndex("ArrowDown", 5, list)).toBe(1);
    expect(nextIndex("ArrowUp", 1, list)).toBe(5);
  });

  it("starts from the first item on Down and the last on Up when nothing is active", () => {
    expect(nextIndex("ArrowDown", -1, list)).toBe(1);
    expect(nextIndex("ArrowUp", -1, list)).toBe(5);
  });

  it("Home and End go to the first and last navigable item", () => {
    expect(nextIndex("Home", 5, list)).toBe(1);
    expect(nextIndex("End", 1, list)).toBe(5);
  });

  it("returns -1 for other keys and for a menu with nothing to move to", () => {
    expect(nextIndex("a", 1, list)).toBe(-1);
    expect(nextIndex("ArrowDown", 0, [{ kind: "separator" }, { kind: "caption", label: "x" }])).toBe(-1);
    expect(nextIndex("Home", 0, [{ kind: "item", label: "Off", disabled: true, onSelect: noop }])).toBe(-1);
  });
});

describe("typeahead", () => {
  it("finds the next item that starts with the typed text, from the row after the active one", () => {
    expect(typeahead("c", list, 1)).toBe(3);
    expect(typeahead("cl", list, 1)).toBe(5);
    expect(typeahead("sh", list, 5)).toBe(1);
  });

  it("skips disabled items and captions", () => {
    expect(typeahead("coord", list, 1)).toBe(-1);
    expect(typeahead("imag", list, 0)).toBe(-1);
  });

  it("cycles through items that start with one repeated letter", () => {
    const items: MenuEntry[] = [
      { kind: "item", label: "Alpha", onSelect: noop },
      { kind: "item", label: "Apple", onSelect: noop },
      { kind: "item", label: "Beta", onSelect: noop },
    ];
    expect(typeahead("a", items, -1)).toBe(0);
    expect(typeahead("a", items, 0)).toBe(1);
    expect(typeahead("aa", items, 1)).toBe(0);
  });

  it("returns -1 for an empty buffer or no match", () => {
    expect(typeahead("", list, 0)).toBe(-1);
    expect(typeahead("zz", list, 0)).toBe(-1);
  });
});
