import { useState } from "react";
import { X } from "lucide-react";
import type { ReviewSession } from "./core/types";

export interface NewRoiTarget {
  kind: "band" | "background";
  rowId: string;
  laneId: string;
  newRowLabel?: string;
  newRowRole?: "target" | "reference";
  newLaneLabel?: string;
}
export function AddRoiDialog({
  session,
  initial,
  onClose,
  onStart,
}: {
  session: ReviewSession;
  initial?: { rowId: string; laneId: string; kind?: "band" | "background" };
  onClose: () => void;
  onStart: (target: NewRoiTarget) => void;
}) {
  const missing = session.rows.flatMap((row) =>
    session.lanes
      .filter((lane) => !row.bands.some((band) => band.laneId === lane.id))
      .map((lane) => ({ rowId: row.id, laneId: lane.id })),
  )[0];
  const [kind, setKind] = useState<"band" | "background">(
    initial?.kind ?? "band",
  );
  const [rowId, setRowId] = useState(
    initial?.rowId ?? missing?.rowId ?? session.rows[0]?.id ?? "__new",
  );
  const [laneId, setLaneId] = useState(
    initial?.laneId ?? missing?.laneId ?? session.lanes[0]?.id ?? "__new",
  );
  const [rowLabel, setRowLabel] = useState("");
  const [laneLabel, setLaneLabel] = useState("");
  const [role, setRole] = useState<"target" | "reference">("target");
  const row = session.rows.find((r) => r.id === rowId);
  const band = row?.bands.find((b) => b.laneId === laneId);
  const size = row?.bands[0]?.rect;
  const blocked =
    kind === "band"
      ? !rowId ||
        !laneId ||
        !!band ||
        (rowId === "__new" &&
          (!rowLabel.trim() || session.rows.length >= 100)) ||
        (laneId === "__new" &&
          (!laneLabel.trim() || session.lanes.length >= 100))
      : !band || band.backgrounds.length >= 20;
  const switchKind = (value: "band" | "background") => {
    setKind(value);
    if (value !== "background") {
      if (!session.rows.some((r) => r.id === rowId)) setRowId("__new");
      if (!session.lanes.some((l) => l.id === laneId)) setLaneId("__new");
      return;
    }
    const pairs = session.rows.flatMap((r) =>
      r.bands.map((b) => ({ rowId: r.id, laneId: b.laneId })),
    );
    const pair =
      pairs.find((p) => p.rowId === rowId && p.laneId === laneId) ??
      pairs.find((p) => p.rowId === rowId) ??
      pairs[0];
    setRowId(pair?.rowId ?? session.rows[0]?.id ?? "");
    setLaneId(pair?.laneId ?? session.lanes[0]?.id ?? "");
  };
  const start = () => {
    if (blocked) return;
    onStart({
      kind,
      rowId: rowId === "__new" ? crypto.randomUUID() : rowId,
      laneId: laneId === "__new" ? crypto.randomUUID() : laneId,
      ...(rowId === "__new"
        ? { newRowLabel: rowLabel.trim(), newRowRole: role }
        : {}),
      ...(laneId === "__new" ? { newLaneLabel: laneLabel.trim() } : {}),
    });
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal compact"
        role="dialog"
        aria-modal="true"
        aria-label="新增取样框"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-heading">
          <h2>新增取样框</h2>
          <button
            className="icon-button"
            aria-label="关闭新增取样框"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p>只补当前缺少的框，已有取样保持原位。选好归属后，在原图上拖画。</p>
        <label>
          取样类型
          <select
            aria-label="新增框类型"
            value={kind}
            onChange={(e) => switchKind(e.target.value as typeof kind)}
          >
            <option value="band">条带</option>
            <option value="background">背景</option>
          </select>
        </label>
        <div className="two-fields">
          <label>
            蛋白
            <select
              aria-label="新增框蛋白"
              value={rowId}
              onChange={(e) => {
                const id = e.target.value;
                setRowId(id);
                const next = session.rows.find((r) => r.id === id);
                const lane = session.lanes.find((l) =>
                  kind === "band"
                    ? !next?.bands.some((b) => b.laneId === l.id)
                    : next?.bands.some((b) => b.laneId === l.id),
                );
                if (lane) setLaneId(lane.id);
              }}
            >
              {session.rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
              {kind === "band" && (
                <option value="__new" disabled={session.rows.length >= 100}>
                  ＋ 新建蛋白行
                </option>
              )}
            </select>
          </label>
          <label>
            泳道
            <select
              aria-label="新增框泳道"
              value={laneId}
              onChange={(e) => setLaneId(e.target.value)}
            >
              {session.lanes.map((lane) => {
                const exists = row?.bands.some((b) => b.laneId === lane.id);
                return (
                  <option
                    key={lane.id}
                    value={lane.id}
                    disabled={kind === "background" && !exists}
                  >
                    {lane.label}
                    {kind === "band" && exists ? "（已有条带）" : ""}
                  </option>
                );
              })}
              {kind === "band" && (
                <option value="__new" disabled={session.lanes.length >= 100}>
                  ＋ 新建泳道
                </option>
              )}
            </select>
          </label>
        </div>
        {kind === "band" && rowId === "__new" && (
          <div className="two-fields">
            <label>
              蛋白名称
              <input
                aria-label="新蛋白名称"
                maxLength={2000}
                value={rowLabel}
                onChange={(e) => setRowLabel(e.target.value)}
                placeholder="例如 IL-6"
              />
            </label>
            <label>
              蛋白类型
              <select
                aria-label="新蛋白类型"
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
              >
                <option value="target">目标蛋白</option>
                <option value="reference">内参</option>
              </select>
            </label>
          </div>
        )}
        {kind === "band" && laneId === "__new" && (
          <label>
            泳道名称
            <input
              aria-label="新泳道名称"
              maxLength={2000}
              value={laneLabel}
              onChange={(e) => setLaneLabel(e.target.value)}
              placeholder="例如 Treatment"
            />
          </label>
        )}
        {kind === "band" && band ? (
          <p className="inline-warning">
            该蛋白和泳道已有条带。请直接调整原框，或选择缺失的泳道。
          </p>
        ) : kind === "band" && size ? (
          <p>
            新增条带沿用同行的 {size.width} × {size.height} px
            尺寸，拖画的位置决定中心；已有条带不会移动。
          </p>
        ) : (
          <p>
            {kind === "background"
              ? "在该条带附近画出干净背景，避开条带、边框和文字。"
              : "拖画矩形决定第一个条带的位置和尺寸。"}
          </p>
        )}
        {kind === "background" && !band && (
          <p className="inline-warning">请先选择已有条带的蛋白和泳道。</p>
        )}
        {kind === "background" && band && band.backgrounds.length >= 20 && (
          <p className="inline-warning">
            该条带已有 20 个背景框，请先删除多余背景。
          </p>
        )}
        <button className="primary full" disabled={blocked} onClick={start}>
          开始画框
        </button>
      </section>
    </div>
  );
}
