import type { Detection } from '../src/core/types';

export function fixture(): Detection {
  return {
    panel: { x: 0, y: 0, width: 1, height: 1 },
    lanes: [{ id: 'ctrl', label: 'Ctrl' }, { id: 'treated', label: '处理' }],
    rows: [
      { id: 'target', label: 'COMP', role: 'target', referenceRowId: 'actin', bands: [{ laneId: 'ctrl', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }, { laneId: 'treated', rect: { x: 0.6, y: 0.1, width: 0.2, height: 0.1 } }] },
      { id: 'actin', label: 'β-actin', role: 'reference', referenceRowId: null, bands: [{ laneId: 'ctrl', rect: { x: 0.1, y: 0.6, width: 0.2, height: 0.1 } }, { laneId: 'treated', rect: { x: 0.6, y: 0.6, width: 0.2, height: 0.1 } }] },
    ], controlLaneId: 'ctrl', warnings: [],
  };
}
