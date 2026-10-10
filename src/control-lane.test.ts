import { describe, expect, it } from 'vitest';
import { applyControlPreference, leftmostLaneId } from './control-lane';
import { createManualSession, parseSession, recordEdit, serializeSession, validateSession } from './core';
import type { ProteinRow, ReviewSession } from './core/types';

const row = (bands: Array<[laneId: string, x: number, width?: number]>): ProteinRow => ({
  id: 'protein', label: 'Protein', role: 'target', referenceRowId: null,
  bands: bands.map(([laneId, x, width = 10]) => ({
    laneId, rect: { x, y: 10, width, height: 5 }, backgrounds: [], warnings: [],
  })),
});

describe('control preference across recognition and export', () => {
  function session(): ReviewSession {
    return createManualSession({ name: 'control.png', width: 80, height: 50,
      dataUrl: 'data:image/png;base64,AQ==', sha256: 'a'.repeat(64) }, 2, 2);
  }

  it('defaults new sessions to automatic leftmost mode and persists mode in snapshots', () => {
    const original = session();
    expect(original.controlLaneMode).toBe('leftmost');
    expect(original.controlLaneId).toBe('lane-1');
    original.controlLaneMode = 'manual'; original.controlLaneId = 'lane-2';
    const saved = parseSession(serializeSession(recordEdit(original, '选择对照')));
    expect(saved.controlLaneMode).toBe('manual');
    expect(saved.history.at(-1)?.controlLaneMode).toBe('manual');
    delete original.controlLaneMode;
    expect(parseSession(serializeSession(original)).controlLaneMode).toBeUndefined();
  });

  it('maps a manual selection by unique exact label even when IDs and lane order change', () => {
    const previous = session(), next = session();
    previous.controlLaneMode = 'manual'; previous.controlLaneId = 'lane-2';
    next.lanes[1].id = 'new-id';
    next.rows.forEach(row => { row.bands[1].laneId = 'new-id'; });
    const before = structuredClone(previous);
    applyControlPreference(next, previous);
    expect(next.controlLaneId).toBe('new-id');
    expect(next.controlLaneMode).toBe('manual');
    expect(previous).toEqual(before);
  });

  it('preserves legacy explicit choices and explicitly cleared controls', () => {
    const previous = session(), next = session();
    delete previous.controlLaneMode;
    previous.controlLaneId = 'lane-2';
    applyControlPreference(next, previous);
    expect(next.controlLaneId).toBe('lane-2');
    expect(next.controlLaneMode).toBe('manual');
    previous.controlLaneId = null;
    applyControlPreference(next, previous);
    expect(next.controlLaneId).toBeNull();
    expect(next.controlLaneMode).toBe('manual');
  });

  it('does not carry an initial blank control or an automatic geometry-based selection', () => {
    const previous = session(), next = session();
    previous.controlLaneId = 'lane-2';
    applyControlPreference(next, previous);
    expect(next.controlLaneId).toBe('lane-1');
    previous.rows = []; previous.controlLaneMode = 'manual'; previous.controlLaneId = null;
    applyControlPreference(next, previous);
    expect(next.controlLaneId).toBe('lane-1');
    expect(next.controlLaneMode).toBe('leftmost');
  });

  it.each(['changed label', 'duplicate old label', 'duplicate new label', 'empty label'])(
    'falls back to leftmost for %s, never guessing by a reused ID', ambiguity => {
      const previous = session(), next = session();
      previous.controlLaneMode = 'manual'; previous.controlLaneId = 'lane-2';
      if (ambiguity === 'changed label') next.lanes[1].label = 'different';
      if (ambiguity === 'duplicate old label') previous.lanes[0].label = previous.lanes[1].label;
      if (ambiguity === 'duplicate new label') next.lanes[0].label = next.lanes[1].label;
      if (ambiguity === 'empty label') previous.lanes[1].label = next.lanes[1].label = '   ';
      applyControlPreference(next, previous);
      expect(next.controlLaneId).toBe('lane-1');
      expect(next.controlLaneMode).toBe('leftmost');
    },
  );

  it('rejects unsupported control selection modes in current or historical state', () => {
    const original = session();
    expect(() => validateSession({ ...original, controlLaneMode: 'model' })).toThrow('格式');
    expect(() => validateSession({ ...original, history: [{ ...original.history[0], controlLaneMode: 'model' }] })).toThrow('格式');
  });
});
const layout = (rows: ProteinRow[] = []): Pick<ReviewSession, 'lanes' | 'rows'> => ({
  lanes: [{ id: 'right', label: 'Ctrl' }, { id: 'left', label: 'KOA' }, { id: 'middle', label: 'Treatment' }],
  rows,
});

describe('leftmost control lane default', () => {
  it('uses pixel positions instead of lane array order or Ctrl labels', () => {
    const session = layout([row([['right', 100], ['middle', 50], ['left', 0]])]);
    const original = structuredClone(session);
    expect(leftmostLaneId(session)).toBe('left');
    expect(session).toEqual(original);
  });

  it('uses median band centers over uneven rows without being pulled by one displaced band', () => {
    const session = layout([
      row([['left', 10], ['middle', 30], ['right', 100]]),
      row([['left', 12], ['middle', 32]]),
      row([['left', 200], ['right', 105]]),
    ]);
    expect(leftmostLaneId(session)).toBe('left');
  });

  it('uses centers including width and averages the central pair for an even number of rows', () => {
    expect(leftmostLaneId(layout([
      row([['left', 0, 100], ['middle', 30, 10]]),
      row([['left', 2, 100], ['middle', 32, 10]]),
    ]))).toBe('middle');
  });

  it('ignores wholly missing lanes when another lane has an observed band', () => {
    expect(leftmostLaneId(layout([row([['middle', 30]])]))).toBe('middle');
  });

  it('uses original lane order for equal positions', () => {
    expect(leftmostLaneId(layout([row([['left', 10], ['right', 10]])]))).toBe('right');
  });

  it('falls back to the first lane only when no known lane has a band', () => {
    expect(leftmostLaneId(layout())).toBe('right');
    expect(leftmostLaneId(layout([row([['unknown', 0]])]))).toBe('right');
    expect(leftmostLaneId({ lanes: [], rows: [] })).toBeNull();
  });
});
