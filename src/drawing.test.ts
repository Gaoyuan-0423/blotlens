import { describe, expect, it } from "vitest";
import { drawRect, isRoiDrag } from "./drawing";

describe("manual ROI drawing", () => {
  it("creates integer rectangles in both drag directions", () => {
    expect(drawRect({ x: 20, y: 25 }, { x: 8, y: 10 }, 100, 80)).toEqual({
      x: 8, y: 10, width: 12, height: 15,
    });
    expect(drawRect({ x: 8.2, y: 10.2 }, { x: 9.4, y: 11.4 }, 100, 80)).toEqual({
      x: 8, y: 10, width: 1, height: 1,
    });
  });

  it("centers a matching-row rectangle at the drawn region and clamps at image edges", () => {
    expect(drawRect({ x: 20, y: 30 }, { x: 60, y: 50 }, 100, 80, { width: 10, height: 8 })).toEqual({
      x: 35, y: 36, width: 10, height: 8,
    });
    expect(drawRect({ x: 98, y: 78 }, { x: 103, y: 83 }, 100, 80, { width: 10, height: 8 })).toEqual({
      x: 90, y: 72, width: 10, height: 8,
    });
  });

  it("distinguishes a zoomed one-pixel drag from a click or pointer tremor", () => {
    expect(isRoiDrag({ x: 5, y: 5 }, { x: 6, y: 6 }, { x: 50, y: 50 }, { x: 53, y: 53 })).toBe(true);
    expect(isRoiDrag({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 50, y: 50 }, { x: 50, y: 50 })).toBe(false);
    expect(isRoiDrag({ x: 5, y: 5 }, { x: 6, y: 6 }, { x: 50, y: 50 }, { x: 51, y: 51 })).toBe(false);
    expect(isRoiDrag({ x: 5, y: 5 }, { x: 5.9, y: 15 }, { x: 50, y: 50 }, { x: 60, y: 80 })).toBe(false);
  });
});
