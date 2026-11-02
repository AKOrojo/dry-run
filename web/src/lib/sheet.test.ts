import { describe, expect, it } from "vitest";
import { isSheetOpen, sheetOpened } from "./sheet";

describe("sheet store", () => {
  it("is open while any sheet is, and closing twice counts once", () => {
    expect(isSheetOpen()).toBe(false);
    const a = sheetOpened(), b = sheetOpened();
    expect(isSheetOpen()).toBe(true);
    a(); a();
    expect(isSheetOpen()).toBe(true);
    b();
    expect(isSheetOpen()).toBe(false);
  });
});
