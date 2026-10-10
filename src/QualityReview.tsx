import type { BandMeasurement, ReviewSession } from "./core/types";
import type { Selection } from "./ImageStage";

type Issue = { message: string; items: BandMeasurement[] };
function groupIssues(
  measurements: BandMeasurement[],
  kind: "reason" | "warnings",
): Issue[] {
  const groups = new Map<string, BandMeasurement[]>();
  for (const m of measurements) {
    const messages =
      kind === "reason" ? (m.reason ? [m.reason] : []) : m.warnings;
    for (const message of new Set(messages)) {
      if (message === "待指定对照泳道") continue;
      const values = groups.get(message) ?? [];
      values.push(m);
      groups.set(message, values);
    }
  }
  return Array.from(groups, ([message, items]) => ({ message, items }));
}
function issueTitle(message: string) {
  return message.split(/[：；]/)[0];
}
export function QualityReview({
  session,
  measurements,
  onSelect,
  onFitPanel,
  onSuggestBackgrounds,
}: {
  session: ReviewSession;
  measurements: BandMeasurement[];
  onSelect: (items: Selection[]) => void;
  onFitPanel: () => void;
  onSuggestBackgrounds: () => void;
}) {
  const blockers = groupIssues(measurements, "reason");
  const advisories = groupIssues(measurements, "warnings");
  const unavailable = measurements.filter(
    (m) =>
      session.rows.find((r) => r.id === m.rowId)?.role === "target" &&
      m.relative === null,
  ).length;
  const hasPanelIssue = advisories.some((g) => g.message.includes("WB 区域"));
  const missingBackgrounds = session.rows.flatMap(row => row.bands).filter(band => !band.backgrounds.length).length;
  const darkBands = measurements.filter(m => (m.nearBlackFraction ?? 0) >= 0.01);
  const list = (groups: Issue[]) => (
    <ul>
      {groups.map(({ message, items }) => (
        <li key={message}>
          <div>
            <strong>{issueTitle(message)}</strong>
            <span className="issue-count">{items.length} 项</span>
          </div>
          {issueTitle(message) !== message && <p>{message}</p>}
          <div className="issue-targets">
            {items.map((m) => (
              <button
                key={`${m.rowId}:${m.laneId}`}
                onClick={() =>
                  onSelect([
                    { rowId: m.rowId, laneId: m.laneId, backgroundIndex: null },
                  ])
                }
              >
                {session.rows.find((r) => r.id === m.rowId)?.label} /{" "}
                {session.lanes.find((l) => l.id === m.laneId)?.label}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="quality-review" aria-label="当前检查提示">
      {!session.controlLaneId && (
        <div className="control-required" role="status">
          <strong>先指定对照泳道</strong>
          <p>
            请在上方「对照」中选择基准组。手工改框不会替你确定对照；选择后立即重新计算。
          </p>
        </div>
      )}
      {blockers.length > 0 && (
        <div className="calculation-blockers">
          <strong>需要处理 · {unavailable} 个目标值暂不可计算</strong>
          {session.measurementPolicy?.backgroundMode !== "none" && missingBackgrounds > 0 && (
            <div className="background-repair">
              <p>有 {missingBackgrounds} 条带缺少背景。内参缺背景也会影响同泳道的目标；对照不可用会影响整行相对值。</p>
              <button className="secondary" onClick={onSuggestBackgrounds}>补齐缺失背景</button>
              <p>只建议缺失的背景框，保留已有框；没有合适区域时仍需手动指定。</p>
            </div>
          )}
          {list(blockers)}
        </div>
      )}
      {advisories.length > 0 && (
        <details className="quality-advisories">
          <summary>图像与取样提醒 · {advisories.length} 类（展开查看）</summary>
          <p>
            以下提醒本身不阻止计算。修改取样后会重新检查；「已人工核对」不会清除仍存在的像素或背景问题。
          </p>
          {list(advisories)}
          {hasPanelIssue && (
            <div className="panel-repair">
              <p>
                若模型估计的 WB
                区域偏小，确认当前条带和背景框位置正确后可扩展区域；不会移动取样框。
              </p>
              <button className="secondary" onClick={onFitPanel}>
                按当前取样框更新 WB 区域
              </button>
            </div>
          )}
        </details>
      )}
      {session.controlLaneId && !blockers.length && !advisories.length && (
        <p className="checks-clear">当前取样可计算</p>
      )}
      {darkBands.length > 0 && (
        <details className="pixel-information">
          <summary>深黑像素信息 · {darkBands.length} 条带（可选查看）</summary>
          <p>黑色可以是条带的正常外观，单凭截图不能判断原始曝光是否饱和。以下仅记录灰度 ≤1 的像素比例，不作为异常或阻止计算。</p>
          <div className="issue-targets">
            {darkBands.map(m => (
              <button key={`${m.rowId}:${m.laneId}`}
                onClick={() => onSelect([{ rowId: m.rowId, laneId: m.laneId, backgroundIndex: null }])}>
                {session.rows.find(row => row.id === m.rowId)?.label} / {session.lanes.find(lane => lane.id === m.laneId)?.label}
                {" · "}{((m.nearBlackFraction ?? 0) * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function MeasurementChecks({
  measurement: m,
}: {
  measurement: BandMeasurement;
}) {
  return (
    <>
      {m.reason && (
        <span className="calculation-reason">
          {m.reason === "待指定对照泳道" ? "待选对照（见上方）" : m.reason}
        </span>
      )}
      {m.warnings.length > 0 && (
        <details className="measurement-details">
          <summary>{m.warnings.length} 条提醒</summary>
          {m.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </details>
      )}
      {!m.reason && !m.warnings.length && "—"}
    </>
  );
}
