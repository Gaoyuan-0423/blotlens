import type { Rect, ReviewSession } from "./core/types";

export interface Selection {
  rowId: string;
  laneId: string;
  backgroundIndex: number | null;
}

export interface SelectedRect {
  selection: Selection;
  rect: Rect;
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return (
    a.rowId === b.rowId &&
    a.laneId === b.laneId &&
    a.backgroundIndex === b.backgroundIndex
  );
}

export function selectedRects(
  session: ReviewSession,
  selections: Selection[],
): SelectedRect[] {
  return selections.flatMap((selection) => {
    const band = session.rows
      .find((row) => row.id === selection.rowId)
      ?.bands.find((candidate) => candidate.laneId === selection.laneId);
    const rect =
      selection.backgroundIndex === null
        ? band?.rect
        : band?.backgrounds[selection.backgroundIndex];
    return rect ? [{ selection, rect }] : [];
  });
}

/** Clamp one shared translation, preserving spacing even at image edges. */
export function translateSelection(
  items: SelectedRect[],
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): SelectedRect[] {
  if (!items.length) return [];
  const minX = Math.min(...items.map(({ rect }) => rect.x));
  const minY = Math.min(...items.map(({ rect }) => rect.y));
  const maxX = Math.max(...items.map(({ rect }) => rect.x + rect.width));
  const maxY = Math.max(...items.map(({ rect }) => rect.y + rect.height));
  const boundedX = Math.max(-minX, Math.min(imageWidth - maxX, Math.round(dx)));
  const boundedY = Math.max(
    -minY,
    Math.min(imageHeight - maxY, Math.round(dy)),
  );
  return items.map(({ selection, rect }) => ({
    selection,
    rect: { ...rect, x: rect.x + boundedX, y: rect.y + boundedY },
  }));
}
