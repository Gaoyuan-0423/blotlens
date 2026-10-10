import { describe, expect, it } from "vitest";
import { createManualSession } from "./core";
import {
  sameSelection,
  selectedRects,
  translateSelection,
  type SelectedRect,
} from "./selection";

const items: SelectedRect[] = [
  {
    selection: { rowId: "protein", laneId: "a", backgroundIndex: null },
    rect: { x: 5, y: 10, width: 10, height: 8 },
  },
  {
    selection: { rowId: "protein", laneId: "b", backgroundIndex: 0 },
    rect: { x: 80, y: 60, width: 15, height: 5 },
  },
];

describe("ROI group translation", () => {
  it("keeps group spacing at all four image boundaries", () => {
    const rightDown = translateSelection(items, 40, 100, 100, 80);
    expect(rightDown.map(({ rect }) => [rect.x, rect.y])).toEqual([
      [10, 25],
      [85, 75],
    ]);
    const leftUp = translateSelection(items, -40, -100, 100, 80);
    expect(leftUp.map(({ rect }) => [rect.x, rect.y])).toEqual([
      [0, 0],
      [75, 50],
    ]);
    expect(rightDown[1].rect.x - rightDown[0].rect.x).toBe(75);
    expect(leftUp[1].rect.y - leftUp[0].rect.y).toBe(50);
  });

  it("rounds fractional pointer displacement once for the whole group without mutating source geometry", () => {
    const result = translateSelection(items, 1.6, -1.4, 100, 80);
    expect(
      result.map(({ rect }) => [rect.x, rect.y, rect.width, rect.height]),
    ).toEqual([
      [7, 9, 10, 8],
      [82, 59, 15, 5],
    ]);
    expect(items[0].rect).toEqual({ x: 5, y: 10, width: 10, height: 8 });
    expect(result[0].selection).toEqual(items[0].selection);
    expect(translateSelection([], 10, 10, 100, 80)).toEqual([]);
  });

  it("distinguishes bands from individual backgrounds and ignores removed selections", () => {
    const session = createManualSession(
      {
        name: "test.png",
        dataUrl: "data:image/png;base64,AQ==",
        width: 100,
        height: 80,
        sha256: "a".repeat(64),
      },
      2,
      1,
    );
    const row = session.rows[0],
      band = row.bands[0];
    band.backgrounds = [{ x: 2, y: 2, width: 10, height: 2 }];
    const selectedBand = {
      rowId: row.id,
      laneId: band.laneId,
      backgroundIndex: null,
    };
    const selectedBackground = { ...selectedBand, backgroundIndex: 0 };
    expect(sameSelection(selectedBand, { ...selectedBand })).toBe(true);
    expect(sameSelection(selectedBand, selectedBackground)).toBe(false);
    expect(
      selectedRects(session, [
        selectedBand,
        selectedBackground,
        { ...selectedBand, rowId: "removed" },
        { ...selectedBand, backgroundIndex: 3 },
      ]),
    ).toEqual([
      { selection: selectedBand, rect: band.rect },
      { selection: selectedBackground, rect: band.backgrounds[0] },
    ]);
  });
});
