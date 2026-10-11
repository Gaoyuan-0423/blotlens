import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type { Rect, ReviewSession } from "./core/types";
import { drawRect, isRoiDrag } from "./drawing";
import {
  sameSelection,
  selectedRects,
  translateSelection,
  type SelectedRect,
  type Selection,
} from "./selection";
export type { Selection } from "./selection";
interface Props {
  session: ReviewSession;
  selections: Selection[];
  onSelect: (value: Selection | null, additive?: boolean) => void;
  onRects: (updates: SelectedRect[]) => void;
  onDelete: () => void;
  showRois: boolean;
  contrast: number;
  drawPanel: boolean;
  onPanel: (rect: Rect) => void;
  drawRoi?: { kind: "band" | "background"; width?: number; height?: number };
  onDrawRoi?: (rect: Rect) => void;
  onCancelDraw?: () => void;
}
interface Drag {
  pointerId: number;
  start: { x: number; y: number };
  screenStart: { x: number; y: number };
  items: SelectedRect[];
  resize: boolean;
}
export function ImageStage({
  session,
  selections,
  onSelect,
  onRects,
  onDelete,
  showRois,
  contrast,
  drawPanel,
  onPanel,
  drawRoi,
  onDrawRoi,
  onCancelDraw,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointerFocusing = useRef(false);
  const [draft, setDraft] = useState<SelectedRect[]>([]);
  const [panelDraft, setPanelDraft] = useState<Rect | null>(null);
  const drawing = drawPanel || !!drawRoi;
  useEffect(() => {
    drag.current = null;
    setDraft([]);
    setPanelDraft(null);
  }, [drawPanel, drawRoi, session]);
  const point = (e: React.PointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    return matrix
      ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
      : { x: 0, y: 0 };
  };
  const bounded = (rect: Rect) => {
    const width = Math.round(
        Math.max(1, Math.min(session.source.width, rect.width)),
      ),
      height = Math.round(
        Math.max(1, Math.min(session.source.height, rect.height)),
      );
    return {
      x: Math.round(
        Math.max(0, Math.min(session.source.width - width, rect.x)),
      ),
      y: Math.round(
        Math.max(0, Math.min(session.source.height - height, rect.y)),
      ),
      width,
      height,
    };
  };
  const dragged = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return null;
    const p = point(e),
      dx = p.x - d.start.x,
      dy = p.y - d.start.y;
    if (!d.items.length)
      return {
        panel: drawRect(
          d.start,
          p,
          session.source.width,
          session.source.height,
          drawRoi,
        ),
        items: [],
      };
    const item = d.items[0];
    return {
      panel: null,
      items: d.resize
        ? [
            {
              selection: item.selection,
              rect: bounded({
                ...item.rect,
                width: item.rect.width + dx,
                height: item.rect.height + dy,
              }),
            },
          ]
        : translateSelection(
            d.items,
            dx,
            dy,
            session.source.width,
            session.source.height,
          ),
    };
  };
  const start = (
    e: React.PointerEvent<SVGRectElement>,
    s: Selection,
    rect: Rect,
    resize = false,
  ) => {
    if (drawing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const selected = selections.some((candidate) =>
      sameSelection(candidate, s),
    );
    const additive = !resize && (e.shiftKey || e.ctrlKey || e.metaKey);
    // Explicit focus avoids native pointer focus collapsing the selected group.
    pointerFocusing.current = true;
    e.currentTarget.focus({ preventScroll: true });
    pointerFocusing.current = false;
    if (additive) {
      onSelect(s, true);
      if (selected) return;
    } else if (!selected) {
      onSelect(s);
    }
    const nextSelections = additive
      ? [...selections, s]
      : selected
        ? selections
        : [s];
    const items = resize
      ? [{ selection: s, rect }]
      : selectedRects(session, nextSelections);
    drag.current = {
      pointerId: e.pointerId,
      start: point(e),
      screenStart: { x: e.clientX, y: e.clientY },
      items,
      resize,
    };
    setDraft(items);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const clearDrag = () => {
    drag.current = null;
    setDraft([]);
    setPanelDraft(null);
  };
  const scale = Math.max(1, session.source.width / 700);
  return (
    <svg
      ref={svg}
      id="source-stage"
      className={drawing ? "source-stage drawing" : "source-stage"}
      viewBox={`0 0 ${session.source.width} ${session.source.height}`}
      role="img"
      tabIndex={0}
      aria-label={t("原截图与可编辑取样框")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          clearDrag();
          if (drawing) onCancelDraw?.();
          onSelect(null);
          svg.current?.focus({ preventScroll: true });
          return;
        }
        if (drawing) {
          if (
            [
              "Backspace",
              "Delete",
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
            ].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        if (!showRois || !selections.length) return;
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          e.stopPropagation();
          clearDrag();
          svg.current?.focus({ preventScroll: true });
          onDelete();
          return;
        }
        const offsets: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const delta = offsets[e.key];
        if (!delta) return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 10 : 1;
        const items = selectedRects(session, selections);
        onRects(
          translateSelection(
            items,
            delta[0] * step,
            delta[1] * step,
            session.source.width,
            session.source.height,
          ),
        );
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (drawing) {
          e.preventDefault();
          svg.current?.focus({ preventScroll: true });
          const p = point(e);
          drag.current = {
            pointerId: e.pointerId,
            start: p,
            screenStart: { x: e.clientX, y: e.clientY },
            items: [],
            resize: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        } else if (!(e.shiftKey || e.ctrlKey || e.metaKey)) {
          onSelect(null);
          svg.current?.focus({ preventScroll: true });
        }
      }}
      onPointerMove={(e) => {
        const result = dragged(e);
        if (result) {
          setDraft(result.items);
          setPanelDraft(result.panel);
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current,
          result = dragged(e);
        if (!result || !d) return;
        clearDrag();
        if (result.panel) {
          if (
            drawRoi &&
            isRoiDrag(d.start, point(e), d.screenStart, {
              x: e.clientX,
              y: e.clientY,
            })
          )
            onDrawRoi?.(result.panel);
          else if (
            drawPanel &&
            result.panel.width > 4 &&
            result.panel.height > 4
          )
            onPanel(result.panel);
        } else if (
          result.items.some(({ rect }, i) => {
            const original = d.items[i].rect;
            return (
              rect.x !== original.x ||
              rect.y !== original.y ||
              rect.width !== original.width ||
              rect.height !== original.height
            );
          })
        ) {
          onRects(result.items);
        }
      }}
      onPointerCancel={clearDrag}
    >
      <rect
        width={session.source.width}
        height={session.source.height}
        fill="#fff"
      />
      <image
        href={session.source.dataUrl}
        width={session.source.width}
        height={session.source.height}
        style={{ filter: `contrast(${contrast}%)` }}
      />
      {showRois && !drawPanel && (
        <rect
          {...session.panel}
          fill="none"
          stroke="#8ea69d"
          strokeWidth={scale}
          strokeDasharray={`${6 * scale} ${5 * scale}`}
          pointerEvents="none"
          aria-label={t("WB 识别区域")}
        />
      )}
      {showRois &&
        session.rows.flatMap((row) =>
          row.bands.flatMap((band) =>
            [
              { rect: band.rect, index: null },
              ...band.backgrounds.map((rect, index) => ({ rect, index })),
            ].map(({ rect, index }) => {
              const s: Selection = {
                rowId: row.id,
                laneId: band.laneId,
                backgroundIndex: index,
              };
              const selected = selections.some((candidate) =>
                sameSelection(candidate, s),
              );
              const r =
                draft.find((item) => sameSelection(item.selection, s))?.rect ??
                rect;
              const color =
                index !== null
                  ? "#6387aa"
                  : row.role === "reference"
                    ? "#b77725"
                    : "#147f70";
              return (
                <g key={`${row.id}:${band.laneId}:${index}`}>
                  <rect
                    {...r}
                    fill={selected ? "#36ab8822" : "transparent"}
                    stroke={color}
                    strokeWidth={(selected ? 2 : 1) * scale}
                    strokeDasharray={
                      index === null ? undefined : `${4 * scale} ${3 * scale}`
                    }
                    tabIndex={drawing ? -1 : 0}
                    style={drawing ? { cursor: "crosshair" } : undefined}
                    role="button"
                    aria-pressed={selected}
                    aria-label={`${row.label} ${session.lanes.find((l) => l.id === band.laneId)?.label} ${index === null ? t("条带") : "背景 " + (index + 1)}`}
                    onFocus={() => {
                      if (!drawing && !pointerFocusing.current && !selected)
                        onSelect(s);
                    }}
                    onPointerDown={(e) => start(e, s, r)}
                    onContextMenu={(e) => {
                      if (e.ctrlKey) e.preventDefault();
                    }}
                    onKeyDown={(e) => {
                      if (drawing) return;
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelect(s, e.shiftKey || e.ctrlKey || e.metaKey);
                      }
                    }}
                  />
                  {selected && !drawing && (
                    <rect
                      x={r.x + r.width - 3 * scale}
                      y={r.y + r.height - 3 * scale}
                      width={6 * scale}
                      height={6 * scale}
                      fill={color}
                      stroke="#fff"
                      strokeWidth={scale}
                      style={{ cursor: "nwse-resize" }}
                      onPointerDown={(e) => start(e, s, r, true)}
                    />
                  )}
                </g>
              );
            }),
          ),
        )}
      {drawPanel && (
        <rect
          {...(panelDraft || session.panel)}
          fill="#20746918"
          stroke="#18786b"
          strokeWidth={2 * scale}
          strokeDasharray={`${5 * scale} ${4 * scale}`}
          pointerEvents="none"
        />
      )}
      {drawRoi && panelDraft && (
        <rect
          {...panelDraft}
          fill={drawRoi.kind === "background" ? "#6387aa18" : "#20746918"}
          stroke={drawRoi.kind === "background" ? "#6387aa" : "#18786b"}
          strokeWidth={2 * scale}
          strokeDasharray={
            drawRoi.kind === "background"
              ? `${5 * scale} ${4 * scale}`
              : undefined
          }
          pointerEvents="none"
        />
      )}
    </svg>
  );
}
