import { recordEdit, validateSession } from './core';
import type { ReviewSession } from './core/types';

/** Editable state only: the original image and append-only audit are never stacked. */
export type UndoSnapshot = Pick<ReviewSession,
  'chartStyle' | 'rows' | 'lanes' | 'panel' | 'controlLaneId' | 'controlLaneMode' | 'measurementPolicy' | 'reviewed' | 'warnings' | 'recognition'
>;

function copyEditableState(state: UndoSnapshot): UndoSnapshot {
  return structuredClone({
    chartStyle: state.chartStyle,
    rows: state.rows,
    lanes: state.lanes,
    panel: state.panel,
    controlLaneId: state.controlLaneId,
    controlLaneMode: state.controlLaneMode,
    measurementPolicy: state.measurementPolicy,
    reviewed: state.reviewed,
    warnings: state.warnings,
    recognition: state.recognition,
  });
}

export function captureUndoSnapshot(session: ReviewSession): UndoSnapshot {
  return copyEditableState(session);
}

/** Restoring is itself an auditable edit; it must not discard intervening edits. */
export function restoreUndoSnapshot(current: ReviewSession, snapshot: UndoSnapshot, action: string): ReviewSession {
  const restored = recordEdit({ ...current, ...copyEditableState(snapshot) }, action);
  restored.reviewed = snapshot.reviewed;
  return validateSession(restored);
}
