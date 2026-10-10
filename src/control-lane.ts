import type { ReviewSession } from './core/types';

/** Choose by observed band geometry; labels and model lane order are not positions. */
export function leftmostLaneId(session: Pick<ReviewSession, 'lanes' | 'rows'>): string | null {
  const centers = new Map(session.lanes.map(lane => [lane.id, [] as number[]]));
  for (const row of session.rows) {
    for (const band of row.bands) {
      const center = band.rect.x + band.rect.width / 2;
      if (Number.isFinite(center)) centers.get(band.laneId)?.push(center);
    }
  }

  let leftmost: string | null = null;
  let leftmostCenter = Infinity;
  for (const lane of session.lanes) {
    const positions = centers.get(lane.id)!;
    if (!positions.length) continue;
    positions.sort((a, b) => a - b);
    const middle = Math.floor(positions.length / 2);
    const center = positions.length % 2
      ? positions[middle]
      : (positions[middle - 1] + positions[middle]) / 2;
    if (center < leftmostCenter) {
      leftmost = lane.id;
      leftmostCenter = center;
    }
  }
  return leftmost ?? session.lanes[0]?.id ?? null;
}

/** Carry a deliberate control choice across recognition only by an unambiguous label match. */
export function applyControlPreference(next: ReviewSession, previous: ReviewSession): void {
  next.controlLaneMode = 'leftmost';
  next.controlLaneId = leftmostLaneId(next);
  if (!previous.rows.length || previous.controlLaneMode === 'leftmost') return;
  // Missing mode in legacy files preserves the pre-existing manual choice.
  if (previous.controlLaneId === null) {
    next.controlLaneMode = 'manual';
    next.controlLaneId = null;
    return;
  }
  const selected = previous.lanes.find(lane => lane.id === previous.controlLaneId);
  if (!selected?.label.trim()) return;
  const previousMatches = previous.lanes.filter(lane => lane.label === selected.label);
  const nextMatches = next.lanes.filter(lane => lane.label === selected.label);
  if (previousMatches.length !== 1 || nextMatches.length !== 1) return;
  next.controlLaneMode = 'manual';
  next.controlLaneId = nextMatches[0].id;
}
