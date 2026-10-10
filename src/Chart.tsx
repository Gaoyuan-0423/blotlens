import type { BandMeasurement, ReviewSession } from "./core/types";
import { laneColor } from "./chart-colors";
export function Chart({
  session,
  measurements,
}: {
  session: ReviewSession;
  measurements: BandMeasurement[];
}) {
  const rows = session.rows.filter((r) => r.role === "target");
  const backgroundMode = session.measurementPolicy?.backgroundMode ?? "subtract";
  const modeLabel = backgroundMode === "none"
    ? "快速趋势 · 未扣背景"
    : "背景扣除 · 已扣背景";
  const maxValue = Math.max(1.2, ...measurements.map((m) => m.relative ?? 0));
  const step = niceStep(maxValue / 4),
    ceiling = Math.ceil(maxValue / step) * step;
  const w = Math.max(
    660,
    rows.length * Math.max(130, session.lanes.length * 25),
  );
  const h = 390 + Math.ceil(session.lanes.length / 3) * 24,
    left = 62,
    right = 24,
    top = 108 + Math.ceil(session.lanes.length / 3) * 24,
    bottom = h - 64;
  const groupWidth = (w - left - right) / Math.max(rows.length, 1);
  const laneWidth = Math.min(
    32,
    (groupWidth - 24) / Math.max(session.lanes.length, 1),
  );
  return (
    <svg
      id="result-chart"
      data-background-mode={backgroundMode}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="截图灰度估计的相对强度柱状图"
      style={{
        width: "100%",
        fontFamily: "Arial, sans-serif",
        background: "#fff",
      }}
    >
      <rect width={w} height={h} fill="#fff" />
      <text x={24} y={27} fontSize={16} fontWeight={600} fill="#233b3a">
        截图灰度估计的相对强度
      </text>
      <text
        x={24}
        y={48}
        fontSize={12}
        fontWeight={600}
        fill={backgroundMode === "none" ? "#956326" : "#24776f"}
      >
        {modeLabel}
      </text>
      <text x={24} y={68} fontSize={11} fill="#62716f">
        单张展示图 · 无误差线 / 无统计检验 ·{" "}
        {session.reviewed ? "已人工核对" : "待人工核对"}
      </text>
      {session.lanes.map((lane, i) => (
        <g
          key={lane.id}
          transform={`translate(${24 + (i % 3) * ((w - 48) / 3)},${89 + Math.floor(i / 3) * 24})`}
        >
          <rect
            width={10}
            height={10}
            rx={2}
            fill={laneColor(session, i)}
          />
          <text x={16} y={9} fontSize={11} fill="#53615f">
            {lane.label.length > 26
              ? lane.label.slice(0, 25) + "…"
              : lane.label}
          </text>
        </g>
      ))}
      {Array.from(
        { length: Math.round(ceiling / step) + 1 },
        (_, i) => i * step,
      ).map((value) => {
        const y = bottom - (value / ceiling) * (bottom - top);
        return (
          <g key={value}>
            <line x1={left} x2={w - right} y1={y} y2={y} stroke="#e7ecea" />
            <text
              x={left - 10}
              y={y + 4}
              textAnchor="end"
              fill="#647370"
              fontSize={11}
            >
              {value.toFixed(step < 1 ? 1 : 0)}
            </text>
          </g>
        );
      })}
      <text
        transform={`translate(17 ${(top + bottom) / 2}) rotate(-90)`}
        textAnchor="middle"
        fontSize={11}
        fill="#647370"
      >
        相对对照泳道
      </text>
      {rows.map((row, r) => (
        <g key={row.id}>
          {session.lanes.map((lane, l) => {
            const m = measurements.find(
              (v) => v.rowId === row.id && v.laneId === lane.id,
            );
            const x =
              left +
              r * groupWidth +
              groupWidth / 2 +
              (l - session.lanes.length / 2) * (laneWidth + 3);
            const value = m?.relative;
            const barHeight =
              value == null ? 0 : (value / ceiling) * (bottom - top);
            return (
              <g key={lane.id}>
                <title>
                  {row.label} / {lane.label}:{" "}
                  {value == null ? m?.reason || "缺少条带" : value.toFixed(4)}
                </title>
                {value == null ? (
                  <text
                    x={x + laneWidth / 2}
                    y={bottom - 9}
                    textAnchor="middle"
                    fontSize={14}
                    fill="#a5aaa6"
                  >
                    ×
                  </text>
                ) : (
                  <>
                    <rect
                      x={x}
                      y={bottom - barHeight}
                      width={laneWidth}
                      height={barHeight}
                      rx={2}
                      fill={laneColor(session, l)}
                    />
                    <text
                      x={x + laneWidth / 2}
                      y={bottom - barHeight - 7}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#415451"
                    >
                      {value > 0 && value < 0.01
                        ? value.toExponential(2)
                        : value.toFixed(2)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
          <text
            x={left + (r + 0.5) * groupWidth}
            y={bottom + 22}
            textAnchor="middle"
            fontSize={12}
            fill="#263e3b"
          >
            {row.label}
          </text>
        </g>
      ))}
      <text x={24} y={h - 14} fontSize={10} fill="#7b8885">
        BlotLens ·{" "}
        {session.source.name.startsWith("synthetic") ? "合成示例 · " : ""}×
        表示不可计算；请查看测量明细与取样区域
      </text>
    </svg>
  );
}
function niceStep(x: number) {
  const power = 10 ** Math.floor(Math.log10(x));
  const scaled = x / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}
