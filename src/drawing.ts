import type { Rect } from "./core/types";

type Point = { x: number; y: number };

/** Work only in source-image pixels; CSS zoom must never change ROI geometry. */
export function drawRect(
  start: Point,
  end: Point,
  imageWidth: number,
  imageHeight: number,
  size?: { width?: number; height?: number },
): Rect {
  const width = Math.round(
    Math.max(1, Math.min(imageWidth, size?.width ?? Math.abs(end.x - start.x))),
  );
  const height = Math.round(
    Math.max(1, Math.min(imageHeight, size?.height ?? Math.abs(end.y - start.y))),
  );
  const x = size?.width === undefined
    ? Math.min(start.x, end.x)
    : (start.x + end.x - width) / 2;
  const y = size?.height === undefined
    ? Math.min(start.y, end.y)
    : (start.y + end.y - height) / 2;
  return {
    x: Math.round(Math.max(0, Math.min(imageWidth - width, x))),
    y: Math.round(Math.max(0, Math.min(imageHeight - height, y))),
    width,
    height,
  };
}

/** Ignore clicks/tremor, while allowing a one-source-pixel ROI at high zoom. */
export function isRoiDrag(
  start: Point,
  end: Point,
  screenStart: Point,
  screenEnd: Point,
): boolean {
  return Math.abs(end.x - start.x) >= 1 &&
    Math.abs(end.y - start.y) >= 1 &&
    Math.hypot(screenEnd.x - screenStart.x, screenEnd.y - screenStart.y) >= 3;
}
