import { describe, expect, it } from 'vitest';
import { addManualBackground, addManualBand } from './manual-roi';
import { ALGORITHM_VERSION, APP_VERSION, measureSession, parseSession, recordEdit, serializeSession } from './core';
import type { Rect, ReviewSession } from './core';

function fixture(): { session: ReviewSession; gray: Uint8Array } {
  const session: ReviewSession = {
    format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
    source: { name: 'manual.png', dataUrl: 'data:image/png;base64,AQ==', width: 100, height: 80, sha256: 'b'.repeat(64) },
    panel: { x: 0, y: 0, width: 100, height: 80 },
    lanes: [{ id: 'a', label: 'Ctrl' }, { id: 'b', label: 'Treatment' }],
    rows: [{ id: 'protein', label: 'Target', role: 'target', referenceRowId: null, bands: [
      { laneId: 'a', rect: { x: 10, y: 30, width: 20, height: 8 }, backgrounds: [{ x: 10, y: 20, width: 20, height: 3 }], warnings: ['existing note'] },
    ] }],
    controlLaneId: 'a', reviewed: true, warnings: [], recognition: null,
    history: [], createdAt: '2026-10-10T10:00:00.000Z',
  };
  const gray = new Uint8Array(8000).fill(235);
  return { session: recordEdit(session, 'initial'), gray };
}
function paint(gray: Uint8Array, rect: Rect, value: number) {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) gray[y * 100 + x] = value;
}

describe('single manual ROI additions', () => {
  it('restores one missing pair at the drawn center, preserving existing geometry, history and row dimensions', () => {
    const { session, gray } = fixture();
    const original = structuredClone(session);
    const next = addManualBand(session, 'protein', 'b', { x: 50, y: 24, width: 30, height: 20 }, gray);
    expect(next.rows[0].bands[1].rect).toEqual({ x: 55, y: 30, width: 20, height: 8 });
    expect(next.rows[0].bands[0]).toEqual(original.rows[0].bands[0]);
    expect(session).toEqual(original);
    expect(next.history).toHaveLength(original.history.length + 1);
    expect(next.history[0]).toEqual(original.history[0]);
    expect(next.history.at(-1)?.rows).toEqual(next.rows);
    expect(next.reviewed).toBe(false);
    expect(next.panel).toEqual(original.panel);
  });

  it('rejects duplicate or unknown pairings and wrong pixel buffers without mutating the session', () => {
    const { session, gray } = fixture();
    const original = structuredClone(session);
    const rect = { x: 55, y: 30, width: 20, height: 8 };
    expect(() => addManualBand(session, 'protein', 'a', rect, gray)).toThrow('已有条带');
    expect(() => addManualBand(session, 'absent', 'b', rect, gray)).toThrow('蛋白与泳道');
    expect(() => addManualBand(session, 'protein', 'absent', rect, gray)).toThrow('蛋白与泳道');
    expect(() => addManualBand(session, 'protein', 'b', rect, gray.slice(1))).toThrow('灰度像素');
    expect(session).toEqual(original);
  });

  it('clamps only the new band position when row dimensions extend beyond the image', () => {
    const { session, gray } = fixture();
    const next = addManualBand(session, 'protein', 'b', { x: 98, y: 78, width: 2, height: 2 }, gray);
    expect(next.rows[0].bands[1].rect).toEqual({ x: 80, y: 72, width: 20, height: 8 });
    expect(next.rows[0].bands[0]).toEqual(session.rows[0].bands[0]);
    expect(() => addManualBand(session, 'protein', 'b', { x: 99, y: 79, width: 2, height: 2 }, gray)).toThrow('原图');
    expect(() => addManualBand(session, 'protein', 'b', { x: -1, y: 0, width: 2, height: 2 }, gray)).toThrow('原图');
  });

  it('uses the drawn dimensions for an empty row, quantizes to at least one pixel and rejects zero/NaN extents', () => {
    const { session, gray } = fixture();
    session.rows[0].bands = [];
    let next = addManualBand(session, 'protein', 'a', { x: 20, y: 30, width: 17, height: 9 }, gray);
    expect(next.rows[0].bands[0].rect).toEqual({ x: 20, y: 30, width: 17, height: 9 });
    next = addManualBand(session, 'protein', 'a', { x: 99.8, y: 79.8, width: 0.1, height: 0.1 }, gray);
    expect(next.rows[0].bands[0].rect).toEqual({ x: 99, y: 79, width: 1, height: 1 });
    expect(() => addManualBand(session, 'protein', 'a', { x: 0, y: 0, width: 0, height: 1 }, gray)).toThrow('原图');
    expect(() => addManualBand(session, 'protein', 'a', { x: NaN, y: 0, width: 1, height: 1 }, gray)).toThrow('原图');
  });

  it('proposes backgrounds only for the new band, rejecting dark and occupied candidates', () => {
    const { session, gray } = fixture();
    // Mask the entire upper search area; candidates below should remain available.
    paint(gray, { x: 50, y: 18, width: 20, height: 12 }, 0);
    const next = addManualBand(session, 'protein', 'b', { x: 50, y: 30, width: 20, height: 8 }, gray);
    const added = next.rows[0].bands[1];
    expect(added.backgrounds).toHaveLength(1);
    expect(added.backgrounds[0].y).toBeGreaterThanOrEqual(40);
    expect(next.rows[0].bands[0].backgrounds).toEqual(session.rows[0].bands[0].backgrounds);
    expect(measureSession(next, gray)[1].backgroundMean).toBe(20);
    // A band covering the same candidate area excludes that area regardless of brightness.
    session.rows.push({ id: 'neighbor', label: 'Neighbor', role: 'target', referenceRowId: null, bands: [
      { laneId: 'a', rect: { x: 50, y: 40, width: 20, height: 12 }, backgrounds: [], warnings: [] },
    ] });
    const blocked = addManualBand(session, 'protein', 'b', { x: 50, y: 30, width: 20, height: 8 }, gray);
    expect(blocked.rows[0].bands[1].backgrounds).toHaveLength(0);
    expect(measureSession(blocked, gray)[1].reason).toBe('尚未指定可用背景区域');
  });

  it('does not expand the model panel or erase outside-region warnings on a manual addition', () => {
    const { session, gray } = fixture();
    session.panel = { x: 0, y: 0, width: 35, height: 80 };
    const next = addManualBand(session, 'protein', 'b', { x: 50, y: 30, width: 20, height: 8 }, gray);
    expect(next.panel).toEqual(session.panel);
    expect(measureSession(next, gray)[1].warnings).toContain('定位异常：条带取样框超出识别的 WB 区域');
    expect(measureSession(next, gray)[1].reason).toBe('尚未指定可用背景区域');
  });

  it('adds a selected background, clearing obsolete draft notes and preserving band coordinates and current warnings', () => {
    const { session, gray } = fixture();
    session.rows[0].bands[0].backgrounds = [];
    session.rows[0].bands[0].warnings = ['未找到足够干净的邻近背景，请手动指定', '水印待核对'];
    const next = addManualBackground(session, 'protein', 'a', { x: 10, y: 20, width: 20, height: 3 });
    expect(next.rows[0].bands[0].rect).toEqual(session.rows[0].bands[0].rect);
    expect(next.rows[0].bands[0].backgrounds).toEqual([{ x: 10, y: 20, width: 20, height: 3 }]);
    expect(next.rows[0].bands[0].warnings).toEqual(['水印待核对']);
    expect(measureSession(next, gray)[0].backgroundMean).toBe(20);
    expect(next.history.at(-1)?.action).toContain('背景取样框');
    expect(session.rows[0].bands[0].backgrounds).toEqual([]);
  });

  it('rejects overlapping, unpaired, out-of-bounds, or excess background additions', () => {
    const { session } = fixture();
    const rect = { x: 10, y: 20, width: 20, height: 3 };
    expect(() => addManualBackground(session, 'protein', 'a', session.rows[0].bands[0].rect)).toThrow('与条带重叠');
    expect(() => addManualBackground(session, 'protein', 'b', rect)).toThrow('所对应的条带');
    expect(() => addManualBackground(session, 'absent', 'a', rect)).toThrow('所对应的条带');
    expect(() => addManualBackground(session, 'protein', 'a', { ...rect, x: 99 })).toThrow('原图');
    session.rows[0].bands[0].backgrounds = Array.from({ length: 20 }, () => ({ ...rect }));
    expect(() => addManualBackground(session, 'protein', 'a', rect)).toThrow('20 个背景框');
    expect(session.rows[0].bands[0].backgrounds).toHaveLength(20);
  });

  it('retains historical snapshots and exact calculations when a manual repair is saved and reloaded', () => {
    const { session, gray } = fixture();
    paint(gray, { x: 50, y: 30, width: 20, height: 8 }, 150);
    const bandAdded = addManualBand(session, 'protein', 'b', { x: 50, y: 30, width: 20, height: 8 }, gray);
    const next = addManualBackground(bandAdded, 'protein', 'b', { x: 50, y: 10, width: 20, height: 4 });
    const restored = parseSession(serializeSession(next));
    expect(restored).toEqual(next);
    expect(measureSession(restored, gray)).toEqual(measureSession(next, gray));
    expect(restored.history).toHaveLength(3);
    expect(restored.history[0].rows[0].bands).toHaveLength(1);
    expect(restored.history[1].rows[0].bands[1].backgrounds).toHaveLength(2);
    expect(restored.history[2].rows[0].bands[1].backgrounds).toHaveLength(3);
    expect(measureSession(restored, gray)[1].net).toBe(13_600);
  });
});
