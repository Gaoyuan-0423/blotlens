import { describe, expect, it } from 'vitest';
import { createManualSession, recordEdit, validateSession } from './core';
import type { ReviewSession } from './core/types';
import { captureUndoSnapshot, restoreUndoSnapshot } from './undo';

function session(): ReviewSession {
  const result = createManualSession({
    name: 'undo.png', dataUrl: 'data:image/png;base64,AQ==', width: 120, height: 100, sha256: 'a'.repeat(64),
  }, 2, 2);
  result.rows[0].label = 'Target';
  result.rows[0].referenceRowId = result.rows[1].id;
  result.rows[1].label = 'β-actin';
  result.rows[1].role = 'reference';
  result.lanes[0].label = 'Ctrl';
  result.controlLaneId = result.lanes[0].id;
  result.recognition = {
    providerBaseUrl: 'https://example.com/v1', model: 'vision', promptVersion: '1',
    rawResponse: '{"fixture":true}', createdAt: '2026-10-10T00:00:00.000Z',
  };
  result.reviewed = true;
  return validateSession(result);
}

describe('undo snapshots', () => {
  it('stores only editable state without the image or prior audit', () => {
    const snapshot = captureUndoSnapshot(session());
    expect(Object.keys(snapshot).sort()).toEqual([
      'chartStyle', 'controlLaneId', 'controlLaneMode', 'lanes', 'measurementPolicy', 'panel', 'recognition', 'reviewed', 'rows', 'warnings',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('data:image');
    expect(snapshot).not.toHaveProperty('source');
    expect(snapshot).not.toHaveProperty('history');
  });

  it('restores geometry, deleted bands, labels, pairing, panel, warnings and review state', () => {
    const original = session();
    const snapshot = captureUndoSnapshot(original);
    const changed = structuredClone(original);
    changed.rows[0].bands.pop();
    changed.rows[0].bands[0].rect.x += 3;
    changed.rows[0].bands[0].backgrounds = [];
    changed.rows[0].label = 'Renamed';
    changed.rows[0].referenceRowId = null;
    changed.lanes[0].label = 'KOA';
    changed.controlLaneId = null;
    changed.controlLaneMode = 'manual';
    changed.measurementPolicy = { maxBandOverlapFraction: 0, backgroundMode: 'none' };
    changed.panel = { x: 0, y: 0, width: 110, height: 90 };
    changed.warnings = ['changed'];
    changed.recognition = null;
    changed.reviewed = false;
    const current = recordEdit(changed, '修改');
    const restored = restoreUndoSnapshot(current, snapshot, '撤销：修改');
    expect(captureUndoSnapshot(restored)).toEqual(snapshot);
    expect(restored.source).toEqual(current.source);
    expect(restored.createdAt).toBe(current.createdAt);
    expect(restored.history).toHaveLength(current.history.length + 1);
    expect(restored.history.slice(0, -1)).toEqual(current.history);
    expect(restored.history.at(-1)).toMatchObject({
      action: '撤销：修改', rows: original.rows, lanes: original.lanes, controlLaneId: original.controlLaneId,
    });
  });

  it('keeps the complete audit when undo and redo restore previous states', () => {
    const before = session();
    const snapshotBefore = captureUndoSnapshot(before);
    const edited = structuredClone(before);
    edited.rows[0].bands[0].rect.y += 2;
    const after = recordEdit(edited, '移动框');
    const snapshotAfter = captureUndoSnapshot(after);
    const undone = restoreUndoSnapshot(after, snapshotBefore, '撤销：移动框');
    const redone = restoreUndoSnapshot(undone, snapshotAfter, '重做：移动框');
    expect(captureUndoSnapshot(redone)).toEqual(snapshotAfter);
    expect(redone.reviewed).toBe(false);
    expect(redone.history.slice(-3).map(edit => edit.action)).toEqual(['移动框', '撤销：移动框', '重做：移动框']);
    expect(redone.history).toHaveLength(after.history.length + 2);
  });

  it('isolates every snapshot and restoration from later nested mutations', () => {
    const original = session();
    const snapshot = captureUndoSnapshot(original);
    const preserved = structuredClone(snapshot);
    original.rows[0].bands[0].backgrounds[0].x += 1;
    original.lanes[0].label = 'Changed';
    original.warnings.push('Current warning');
    original.recognition!.model = 'new-model';
    expect(snapshot).toEqual(preserved);
    const currentBeforeRestore = structuredClone(original);
    const restored = restoreUndoSnapshot(original, snapshot, '撤销');
    expect(original).toEqual(currentBeforeRestore);
    restored.rows[0].bands[0].rect.x += 2;
    restored.recognition!.model = 'later-model';
    restored.history[0].action = 'Later audit mutation';
    expect(snapshot).toEqual(preserved);
    expect(original).toEqual(currentBeforeRestore);
    snapshot.rows[1].label = 'Snapshot mutation';
    expect(restored.rows[1].label).toBe('β-actin');
    expect(restored.history.at(-1)!.rows[0].bands[0].rect).toEqual(preserved.rows[0].bands[0].rect);
  });

  it('validates restoration against the current source and leaves inputs intact on rejection', () => {
    const current = session();
    const snapshot = captureUndoSnapshot(current);
    snapshot.rows[0].bands[0].rect.x = current.source.width;
    const unchanged = structuredClone(current);
    expect(() => restoreUndoSnapshot(current, snapshot, '撤销')).toThrow('越界');
    expect(current).toEqual(unchanged);
  });

  it('does not let extra snapshot metadata overwrite current source or audit', () => {
    const current = session();
    const snapshot = Object.assign(captureUndoSnapshot(current), { source: null, history: [], createdAt: 'invalid' });
    const restored = restoreUndoSnapshot(current, snapshot, '撤销');
    expect(restored.source).toEqual(current.source);
    expect(restored.createdAt).toEqual(current.createdAt);
    expect(restored.history.slice(0, -1)).toEqual(current.history);
  });
});
