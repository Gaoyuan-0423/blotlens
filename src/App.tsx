import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  FlaskConical,
  Focus,
  ImagePlus,
  LoaderCircle,
  Plus,
  ScanLine,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  createManualSession,
  measureSession,
  measurementsCsv,
  parseSession,
  recordEdit,
  refreshManualBandWarnings,
  serializeSession,
  sessionFromDetection,
  updateBandRect,
  validateSession,
} from "./core";
import {
  ALGORITHM_VERSION,
  APP_VERSION,
  DEFAULT_MEASUREMENT_POLICY,
  type Rect,
  type RecognitionResult,
  type ReviewSession,
  type SourceImage,
} from "./core/types";
import { parseHostImport } from "./embedding";
import { decodeSource, loadScreenshot } from "./image-io";
import { createExample } from "./example";
import { ImageStage, type Selection } from "./ImageStage";
import { Chart } from "./Chart";
import { PALETTES, laneColor } from "./chart-colors";
import type { ChartStyle } from "./core/types";
import { AddRoiDialog, type NewRoiTarget } from "./AddRoiDialog";
import { addManualBand, addManualBackground } from "./manual-roi";
import { leftmostLaneId, applyControlPreference } from "./control-lane";
import { repairMissingBackgrounds } from "./background-repair";
import { prepareRecognitionImage, mapRegionDetection } from "./recognition-region";
import {
  captureUndoSnapshot,
  restoreUndoSnapshot,
  type UndoSnapshot,
} from "./undo";
import { QualityReview, MeasurementChecks } from "./QualityReview";
import { downloadText, exportOverlay, exportSvg } from "./exports";

interface Config {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
}
const defaultConfig: Config = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  keyConfigured: false,
};
async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message || "请求失败。");
  return value;
}
function blankSession(source: SourceImage): ReviewSession {
  return {
    format: "wb-review",
    schemaVersion: 1,
    appVersion: APP_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    source,
    panel: { x: 0, y: 0, width: source.width, height: source.height },
    lanes: [],
    rows: [],
    controlLaneId: null,
    controlLaneMode: "leftmost",
    measurementPolicy: { ...DEFAULT_MEASUREMENT_POLICY },
    reviewed: false,
    warnings: [],
    recognition: null,
    history: [],
    createdAt: new Date().toISOString(),
  };
}
const pretty = (n: number | null | undefined, digits = 2) =>
  n == null
    ? "—"
    : n !== 0 && Math.abs(n) < Math.pow(10, -digits)
      ? n.toExponential(2)
      : n.toLocaleString("en-US", { maximumFractionDigits: digits });

export default function App() {
  const [session, setSession] = useState<ReviewSession | null>(null),
    [gray, setGray] = useState<Uint8Array | null>(null);
  useEffect(() => {
    if (window.parent !== window)
      window.parent.postMessage({ type: "blotlens:state", version: 1, hasAnalysis: session !== null }, window.location.origin);
  }, [session]);
  const [config, setConfig] = useState<Config>(defaultConfig),
    [settings, setSettings] = useState(false),
    [serviceAvailable, setServiceAvailable] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [selections, setSelections] = useState<Selection[]>([]);
  const selection = selections.at(-1) ?? null;
  const setSelection = useCallback(
    (value: Selection | null, additive = false) => {
      setSelections((current) => {
        if (!value) return [];
        if (!additive) return [value];
        const matches = (s: Selection) =>
          s.rowId === value.rowId &&
          s.laneId === value.laneId &&
          s.backgroundIndex === value.backgroundIndex;
        return current.some(matches)
          ? current.filter((s) => !matches(s))
          : [...current, value];
      });
    },
    [],
  );
  const [showRois, setShowRois] = useState(true),
    [contrast, setContrast] = useState(100),
    [zoom, setZoom] = useState(1),
    [drawPanel, setDrawPanel] = useState(false);
  const [manual, setManual] = useState(false),
    [rowsCount, setRowsCount] = useState(5),
    [lanesCount, setLanesCount] = useState(3),
    [exportsOpen, setExportsOpen] = useState(false);
  const [tab, setTab] = useState<"results" | "settings">("results");
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]),
    [redoStack, setRedoStack] = useState<UndoSnapshot[]>([]);
  const [addDialog, setAddDialog] = useState(false);
  const [pendingRoi, setPendingRoi] = useState<NewRoiTarget | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    epoch = useRef(0),
    abort = useRef<AbortController | null>(null);
  useEffect(() => {
    api<Config>("/api/config")
      .then(value => { setConfig(value); setServiceAvailable(true); })
      .catch(() => setNotice("本机服务尚未就绪；仍可查看合成示例或手动分析。"));
    return () => abort.current?.abort();
  }, []);
  const replace = useCallback((value: ReviewSession, pixels: Uint8Array) => {
    setSession(value);
    setUndoStack([]);
    setRedoStack([]);
    setPendingRoi(null);
    setAddDialog(false);
    setManual(false);
    setGray(pixels);
    setSelection(null);
    setContrast(100);
    setZoom(1);
    setDrawPanel(false);
    setShowRois(true);
    setNotice("");
    setTab("results");
    window.scrollTo({ top: 0 });
  }, []);
  const stop = useCallback(() => {
    epoch.current++;
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setLoading(false);
  }, []);
  const loadFile = useCallback(
    async (file: File) => {
      stop();
      const id = epoch.current;
      setLoading(true);
      setError("");
      try {
        const value = await loadScreenshot(file);
        if (id === epoch.current) {
          replace(blankSession(value.source), value.gray);
          return true;
        }
      } catch (e) {
        if (id === epoch.current) setError(String((e as Error).message));
      } finally {
        if (id === epoch.current) setLoading(false);
      }
      return false;
    },
    [stop, replace],
  );
  useEffect(() => {
    if (window.parent === window) return;
    const receive = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const request = parseHostImport(event.data);
      if (!request) return;
      const ok = await loadFile(new File([request.bytes], request.name, { type: request.mimeType }));
      window.parent.postMessage({ type: "blotlens:import-result", version: 1, requestId: request.requestId, ok }, window.location.origin);
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "blotlens:ready", version: 1 }, window.location.origin);
    return () => window.removeEventListener("message", receive);
  }, [loadFile]);
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest(
          'input,textarea,[contenteditable="true"]',
        )
      )
        return;
      const file = Array.from(e.clipboardData?.items || [])
        .find((i) => i.type === "image/png" || i.type === "image/jpeg")
        ?.getAsFile();
      if (file) {
        e.preventDefault();
        void loadFile(file);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [loadFile]);
  const measurements = useMemo(
    () => (session && gray ? measureSession(session, gray) : []),
    [session, gray],
  );
  const backgroundMode = session?.measurementPolicy?.backgroundMode ?? "subtract";
  const selectedRow = session?.rows.find((r) => r.id === selection?.rowId),
    selectedBand = selectedRow?.bands.find(
      (b) => b.laneId === selection?.laneId,
    );
  const selectedRect =
    selection?.backgroundIndex != null
      ? selectedBand?.backgrounds[selection.backgroundIndex]
      : selectedBand?.rect;
  const commitSession = (next: ReviewSession) => {
    const valid = validateSession(next);
    if (session)
      setUndoStack((previous) =>
        [...previous, captureUndoSnapshot(session)].slice(-50),
      );
    setRedoStack([]);
    setSession(valid);
  };
  const changeChartStyle = (style: ChartStyle) => {
    if (!session) return;
    stop();
    try {
      commitSession({ ...recordEdit({ ...session, chartStyle: style }, "修改柱状图配色"), reviewed: session.reviewed });
      setError("");
    } catch (e) { setError((e as Error).message); }
  };
  const travel = (direction: "undo" | "redo") => {
    if (!session) return;
    const from = direction === "undo" ? undoStack : redoStack;
    const snapshot = from.at(-1);
    if (!snapshot) return;
    stop();
    try {
      const restored = restoreUndoSnapshot(
        session,
        snapshot,
        direction === "undo" ? "撤销上一步操作" : "重做上一步操作",
      );
      if (direction === "undo") {
        setUndoStack(from.slice(0, -1));
        setRedoStack((previous) =>
          [...previous, captureUndoSnapshot(session)].slice(-50),
        );
      } else {
        setRedoStack(from.slice(0, -1));
        setUndoStack((previous) =>
          [...previous, captureUndoSnapshot(session)].slice(-50),
        );
      }
      setSession(restored);
      setSelection(null);
      setPendingRoi(null);
      setDrawPanel(false);
      setError("");
      setNotice(
        direction === "undo"
          ? "已撤销上一步，可点击重做恢复。"
          : "已重做上一步。",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        settings ||
        manual ||
        addDialog ||
        loading
      )
        return;
      if (
        (event.target as Element)?.closest?.(
          'input,textarea,select,[contenteditable="true"],[role="dialog"]',
        )
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "z" || (key === "y" && event.ctrlKey)) {
        event.preventDefault();
        travel(key === "y" || event.shiftKey ? "redo" : "undo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, undoStack, redoStack, settings, manual, addDialog, loading]);
  const change = (
    action: string,
    fn: (next: ReviewSession) => ReviewSession | void,
  ) => {
    if (!session) return false;
    stop();
    try {
      const next = structuredClone(session),
        result = fn(next) || next;
      result.reviewed = false;
      commitSession(
        result.history.length > session.history.length
          ? result
          : recordEdit(result, action),
      );
      setError("");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const onRect = (s: Selection, rect: Rect) => {
    change(
      s.backgroundIndex === null
        ? "调整条带取样框（同行尺寸同步）"
        : "调整背景取样框",
      (next) => {
        if (s.backgroundIndex === null)
          return updateBandRect(next, s.rowId, s.laneId, rect);
        const band = next.rows
          .find((r) => r.id === s.rowId)
          ?.bands.find((b) => b.laneId === s.laneId);
        if (band) {
          band.backgrounds[s.backgroundIndex] = bound(rect, next.source);
          refreshManualBandWarnings(band, "background");
        }
      },
    );
  };
  const onRects = (updates: { selection: Selection; rect: Rect }[]) => {
    if (
      !session ||
      updates.every(({ selection: s, rect }) => {
        const band = session.rows
          .find((r) => r.id === s.rowId)
          ?.bands.find((b) => b.laneId === s.laneId);
        const current =
          s.backgroundIndex === null
            ? band?.rect
            : band?.backgrounds[s.backgroundIndex];
        return (
          current &&
          current.x === rect.x &&
          current.y === rect.y &&
          current.width === rect.width &&
          current.height === rect.height
        );
      })
    )
      return;
    if (updates.length === 1)
      return onRect(updates[0].selection, updates[0].rect);
    if (!updates.length) return;
    change(`整体移动 ${updates.length} 个取样框`, (next) => {
      for (const { selection: s, rect } of updates) {
        const band = next.rows
          .find((r) => r.id === s.rowId)
          ?.bands.find((b) => b.laneId === s.laneId);
        if (!band) continue;
        if (s.backgroundIndex === null) band.rect = bound(rect, next.source);
        else band.backgrounds[s.backgroundIndex] = bound(rect, next.source);
        refreshManualBandWarnings(
          band,
          s.backgroundIndex === null ? "band" : "background",
        );
      }
    });
  };
  const deleteSelected = () => {
    if (!selections.length) return;
    change(`删除 ${selections.length} 个取样框`, (next) => {
      for (const row of next.rows) {
        row.bands = row.bands.filter(
          (band) =>
            !selections.some(
              (s) =>
                s.rowId === row.id &&
                s.laneId === band.laneId &&
                s.backgroundIndex === null,
            ),
        );
        for (const band of row.bands) {
          const indices = new Set(
            selections
              .filter((s) => s.rowId === row.id && s.laneId === band.laneId)
              .map((s) => s.backgroundIndex),
          );
          band.backgrounds = band.backgrounds.filter((_, i) => !indices.has(i));
          if (indices.size) refreshManualBandWarnings(band, "background");
        }
      }
    });
    setSelection(null);
  };
  const fitPanelToRois = () =>
    change("按当前取样框扩展 WB 区域", (next) => {
      const rects = [
        next.panel,
        ...next.rows.flatMap((r) =>
          r.bands.flatMap((b) => [b.rect, ...b.backgrounds]),
        ),
      ];
      const x = Math.min(...rects.map((r) => r.x)),
        y = Math.min(...rects.map((r) => r.y));
      next.panel = {
        x,
        y,
        width: Math.max(...rects.map((r) => r.x + r.width)) - x,
        height: Math.max(...rects.map((r) => r.y + r.height)) - y,
      };
    });
  const repairBackgrounds = (pairs?: { rowId: string; laneId: string }[]) => {
    if (!session || !gray) return;
    stop();
    try {
      const next = repairMissingBackgrounds(session, gray, pairs);
      const missing = (value: ReviewSession) => value.rows.flatMap(row => row.bands).filter(band => !band.backgrounds.length).length;
      const added = missing(session) - missing(next);
      if (added) commitSession(next);
      setError("");
      setNotice(added
        ? `已为 ${added} 条带建议背景；还剩 ${missing(next)} 条带缺少背景。请检查虚线框，可撤销本次补齐。`
        : "未找到足够干净的邻近背景。可选中条带后点击「画背景框」，或切换到快速趋势模式。");
    } catch (e) { setError((e as Error).message); }
  };
  const beginDrawing = (target: NewRoiTarget) => {
    stop();
    setError("");
    setPendingRoi(target);
    setDrawPanel(false);
    setAddDialog(false);
    setManual(false);
    setShowRois(true);
    setSelection(null);
    setTab("results");
    requestAnimationFrame(() => {
      document.getElementById("source-stage")?.focus({ preventScroll: true });
      document
        .getElementById("source-stage")
        ?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  };
  const addDrawnRoi = (rect: Rect) => {
    if (!session || !gray || !pendingRoi) return;
    const target = pendingRoi;
    let backgroundIndex: number | null = null;
    const accepted = change("手工新增取样框", (next) => {
      if (target.newLaneLabel)
        next.lanes.push({ id: target.laneId, label: target.newLaneLabel });
      if (target.newRowLabel)
        next.rows.push({
          id: target.rowId,
          label: target.newRowLabel,
          role: target.newRowRole ?? "target",
          referenceRowId: null,
          bands: [],
        });
      if (target.kind === "background") {
        backgroundIndex =
          next.rows
            .find((r) => r.id === target.rowId)
            ?.bands.find((b) => b.laneId === target.laneId)?.backgrounds
            .length ?? 0;
        return addManualBackground(next, target.rowId, target.laneId, rect);
      }
      const added = addManualBand(next, target.rowId, target.laneId, rect, gray);
      if (added.controlLaneMode === "leftmost") {
        added.controlLaneId = leftmostLaneId(added);
        added.history.at(-1)!.controlLaneId = added.controlLaneId;
      }
      return added;
    });
    if (accepted) {
      setPendingRoi(null);
      setSelection({
        rowId: target.rowId,
        laneId: target.laneId,
        backgroundIndex,
      });
      setNotice(
        target.kind === "band"
          ? "已补上条带。请检查背景取样；可选中该条带后点击「画背景框」。"
          : "已添加背景框并重新计算。位置不合适可撤销后重画。",
      );
    }
  };
  const missingPairs =
    session?.rows.flatMap((row) =>
      session.lanes
        .filter((lane) => !row.bands.some((band) => band.laneId === lane.id))
        .map((lane) => ({ row, lane })),
    ) ?? [];
  const drawingRow = session?.rows.find((r) => r.id === pendingRoi?.rowId);
  const drawingSize =
    pendingRoi?.kind === "band" ? drawingRow?.bands[0]?.rect : undefined;
  const drawingTool = useMemo(
    () =>
      pendingRoi
        ? {
            kind: pendingRoi.kind,
            width: drawingSize?.width,
            height: drawingSize?.height,
          }
        : undefined,
    [pendingRoi, drawingSize?.width, drawingSize?.height],
  );
  const example = async () => {
    stop();
    const id = epoch.current;
    setLoading(true);
    setError("");
    try {
      const { source, detection } = await createExample();
      const pixels = await decodeSource(source);
      if (id !== epoch.current) return;
      const next = sessionFromDetection(source, pixels, {
        detection,
        providerBaseUrl: "https://synthetic.invalid",
        model: "synthetic-layout",
        promptVersion: "not-applicable",
        rawResponse: JSON.stringify(detection),
        createdAt: new Date().toISOString(),
      });
      next.recognition = null;
      replace(next, pixels);
      setNotice(
        "这是已知布局的合成示例，未调用视觉模型。可直接调整取样框，观察计算结果。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (id === epoch.current) setLoading(false);
    }
  };
  const recognize = async (useRegion = false) => {
    if (!session || !gray) return;
    if (!serviceAvailable) {
      setNotice("当前为静态或离线页面，可手工取样。使用 AI 识别请启动 BlotLens 或 WB 工作台的本机服务。");
      return;
    }
    if (!config.model) {
      setSettings(true);
      setNotice("请先配置支持图片输入的模型和 API Key。");
      return;
    }
    stop();
    const id = epoch.current;
    setPendingRoi(null);
    setDrawPanel(false);
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const input = await prepareRecognitionImage(session.source, useRegion ? session.panel : undefined);
      if (id !== epoch.current) return;
      const result = await api<RecognitionResult>("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: input.image,
        }),
        signal: controller.signal,
      });
      if (id === epoch.current) {
        const mapped = input.inputRegion ? {
          ...result,
          inputRegion: input.inputRegion,
          detection: mapRegionDetection(result.detection, input.inputRegion, session.source),
        } : result;
        const detected = sessionFromDetection(session.source, gray, mapped);
        // Keep the user's selected extent, including labels, for repeat recognition.
        if (input.inputRegion) detected.panel = { ...input.inputRegion };
        const next = repairMissingBackgrounds(detected, gray);
        applyControlPreference(next, session);
        if (session.measurementPolicy) next.measurementPolicy = { ...session.measurementPolicy };
        if (session.chartStyle) next.chartStyle = { palette: session.chartStyle.palette };
        next.history = session.history;
        commitSession(recordEdit(next, useRegion ? "识别框选 WB 区域并更新取样框" : "自动识别并更新取样框"));
        setPendingRoi(null);
        setSelection(null);
        setNotice(
          `${useRegion ? "框选区域" : "整图"}识别完成。请检查取样框、内参与对照；柱高由原图像素计算。`,
        );
      }
    } catch (e) {
      if (id === epoch.current && (e as Error).name !== "AbortError")
        setError((e as Error).message);
    } finally {
      if (id === epoch.current) setBusy(false);
    }
  };
  const importProject = async (file: File) => {
    stop();
    const id = epoch.current;
    setLoading(true);
    setError("");
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error("分析文件超过 30 MB。");
      const next = parseSession(await file.text());
      const pixels = await decodeSource(next.source);
      if (id === epoch.current) {
        replace(next, pixels);
        setNotice("分析文件已恢复，使用保存的取样框在本地复算；未调用模型。");
      }
    } catch (e) {
      if (id === epoch.current) setError((e as Error).message);
    } finally {
      if (id === epoch.current) setLoading(false);
    }
  };
  const makeGrid = () => {
    if (!session) return;
    stop();
    try {
      const next = createManualSession(session.source, lanesCount, rowsCount);
      const panel = session.panel;
      const sx = panel.width / session.source.width,
        sy = panel.height / session.source.height;
      const map = (r: Rect) =>
        bound(
          {
            x: panel.x + r.x * sx,
            y: panel.y + r.y * sy,
            width: r.width * sx,
            height: r.height * sy,
          },
          session.source,
        );
      next.rows.forEach((r) =>
        r.bands.forEach((b) => {
          b.rect = map(b.rect);
          b.backgrounds = b.backgrounds.map(map);
        }),
      );
      next.panel = panel;
      if (session.measurementPolicy) next.measurementPolicy = { ...session.measurementPolicy };
        if (session.chartStyle) next.chartStyle = { palette: session.chartStyle.palette };
      next.history = session.history;
      commitSession(recordEdit(next, "手动生成取样网格"));
      setPendingRoi(null);
      setSelection(null);
      setManual(false);
      setNotice("已生成可编辑网格，对照默认为最左侧泳道。请对准实际条带并指定内参。");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const exportFile = async (kind: string) => {
    if (!session) return;
    setExportsOpen(false);
    try {
      if (kind === "json")
        downloadText(serializeSession(session), "blotlens-analysis.json");
      else if (kind === "csv")
        downloadText(
          measurementsCsv(session, measurements),
          "blotlens-measurements.csv",
          "text/csv;charset=utf-8",
        );
      else if (kind === "overlay") await exportOverlay(session);
      else {
        const svg = document.getElementById(
          "result-chart",
        ) as unknown as SVGSVGElement;
        if (svg) await exportSvg(svg, "blotlens-chart", kind === "png");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const targetCount =
    session?.rows.filter((r) => r.role === "target").length || 0;
  return (
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) void loadFile(f);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg"
        className="visually-hidden"
        aria-label="导入截图"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void loadFile(f);
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        aria-label="载入分析文件"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importProject(f);
        }}
      />
      <header className="topbar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          <strong>BlotLens</strong>
          <span className="brand-caption">WB 趋势核对</span>
        </a>
        <div className="header-actions">
          <span className="local-badge">
            <span />
            本机工作区
          </span>
          <button
            className="text-button"
            onClick={() => projectInput.current?.click()}
          >
            <ArrowDownToLine size={15} />
            载入分析
          </button>
          <button
            className="icon-button"
            aria-label="API 设置"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <main>
        {error && (
          <div role="alert" className="message error">
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="message info">
            <span>{notice}</span>
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {!session ? (
          <section className="welcome">
            <div className="welcome-copy">
              <span className="eyebrow">A CLEARER LOOK AT YOUR BLOTS</span>
              <h1>
                让条带的趋势，
                <br />
                <span>更容易核对。</span>
              </h1>
              <p>
                从论文截图中提取条带灰度，生成可复查的相对强度图。
                <br className="desktop-only" />
                把直觉中的变化，放到同一张图里查看。
              </p>
              <div className="welcome-tags">
                <span>
                  <ScanLine size={15} />
                  自动定位
                </span>
                <span>
                  <SlidersHorizontal size={15} />
                  取样可调整
                </span>
                <span>
                  <ShieldCheck size={15} />
                  本地像素计算
                </span>
              </div>
            </div>
            <div className="welcome-grid">
              <div className="upload-card">
                <div className="upload-icon">
                  <ImagePlus size={32} strokeWidth={1.4} />
                </div>
                <h2>{loading ? "正在读取截图…" : "把 WB 截图放到这里"}</h2>
                <p>
                  拖入图片，或直接按 <kbd>⌘ / Ctrl</kbd> + <kbd>V</kbd> 粘贴
                </p>
                <button
                  className="primary"
                  disabled={loading}
                  onClick={() => fileInput.current?.click()}
                >
                  {loading ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <Plus size={17} />
                  )}
                  选择截图
                </button>
                <span className="file-note">
                  PNG / JPEG · 单个 WB 面板及配图 · 最大 15 MB
                </span>
                <button
                  className="example-link"
                  onClick={() => void example()}
                  disabled={loading}
                >
                  <FlaskConical size={15} />
                  先试试合成示例
                  <ArrowRight size={14} />
                </button>
              </div>
              <aside className="workflow-card">
                <div className="mini-caption">从条带到趋势</div>
                <div className="mini-visual">
                  <div className="mini-blot">
                    {[0.3, 0.7, 0.45, 0.8, 0.4, 0.65, 0.6, 0.6, 0.6].map(
                      (a, i) => (
                        <i key={i} style={{ opacity: a }} />
                      ),
                    )}
                  </div>
                  <ArrowRight size={22} />
                  <div className="mini-bars">
                    {[42, 74, 52, 62, 34, 54].map((v, i) => (
                      <i
                        key={i}
                        style={{
                          height: v,
                          background:
                            i % 3 === 0
                              ? "#277a70"
                              : i % 3 === 1
                                ? "#e5a45e"
                                : "#84a4bb",
                        }}
                      />
                    ))}
                  </div>
                </div>
                <ol>
                  <li>
                    <b>01</b>
                    <span>
                      <strong>导入并识别</strong>
                      <small>视觉模型定位蛋白、组别和条带</small>
                    </span>
                  </li>
                  <li>
                    <b>02</b>
                    <span>
                      <strong>检查取样区域</strong>
                      <small>查看背景、内参与对照泳道</small>
                    </span>
                  </li>
                  <li>
                    <b>03</b>
                    <span>
                      <strong>并排查看与导出</strong>
                      <small>保留取样记录，方便复查</small>
                    </span>
                  </li>
                </ol>
                <p className="workflow-foot">
                  结果反映截图灰度趋势，不包含统计检验。
                </p>
              </aside>
            </div>
          </section>
        ) : (
          <>
            <section className="workspace-heading">
              <div>
                <span className="eyebrow">SCREENSHOT WORKSPACE</span>
                <h1>{session.source.name}</h1>
                <p>
                  {session.source.width} × {session.source.height} px{" "}
                  <span>·</span> {targetCount} 个目标蛋白 <span>·</span>{" "}
                  {session.lanes.length} 个泳道 <span>·</span>{" "}
                  {session.source.name.startsWith("synthetic")
                    ? "合成示例"
                    : "单张展示图"}
                </p>
              </div>
              <div className="workspace-actions">
                <button
                  className="secondary"
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlus size={16} />
                  更换截图
                </button>
                <div className="export-menu">
                  <button
                    className="secondary"
                    disabled={!session.rows.length}
                    onClick={() => setExportsOpen(!exportsOpen)}
                  >
                    <ArrowDownToLine size={16} />
                    导出
                    <ChevronDown size={14} />
                  </button>
                  {exportsOpen && (
                    <div className="dropdown">
                      {[
                        ["png", "柱状图 PNG"],
                        ["svg", "柱状图 SVG"],
                        ["overlay", "取样框叠图 PNG"],
                        ["csv", "测量明细 CSV"],
                        ["json", "可复算分析文件 JSON"],
                      ].map(([k, label]) => (
                        <button key={k} onClick={() => void exportFile(k)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
            <div className="analysis-toolbar">
              <div className="analysis-toolbar-left">
                {busy ? (
                  <button className="primary" onClick={stop}>
                    <X size={16} />
                    取消识别
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={() => void recognize()}
                    disabled={loading}
                  >
                    <ScanLine size={17} />
                    {session.recognition ? "重新识别" : "自动识别"}
                  </button>
                )}
                {!busy && (
                  <button className="secondary" disabled={loading}
                    title="仅发送当前 WB 区域；请将蛋白名和组别标签一起框入"
                    onClick={() => void recognize(true)}>
                    <ScanLine size={16} />识别框选区域
                  </button>
                )}
                <span className="destination">
                  {busy ? (
                    <>
                      <LoaderCircle className="spin" size={13} />
                      正在识别布局与标签…
                    </>
                  ) : (
                    <>
                      云端识别 ·{" "}
                      <button onClick={() => setSettings(true)}>
                        {config.model || "配置视觉 API"}
                      </button>
                    </>
                  )}
                  <small>{safeHost(config.baseUrl)}</small>
                </span>
              </div>
              <div className="manual-tools">
                <button
                  className="text-button"
                  aria-label="撤销"
                  title="撤销（Ctrl / ⌘ Z）"
                  disabled={!undoStack.length || loading}
                  onClick={() => travel("undo")}
                >
                  <Undo2 size={16} />
                  撤销
                </button>
                <button
                  className="text-button"
                  aria-label="重做"
                  title="重做（Ctrl / ⌘ Shift Z）"
                  disabled={!redoStack.length || loading}
                  onClick={() => travel("redo")}
                >
                  <Redo2 size={16} />
                  重做
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    stop();
                    setPendingRoi(null);
                    setAddDialog(true);
                  }}
                >
                  <Plus size={16} />
                  新增取样框
                </button>
                <button
                  className={drawPanel ? "text-button active" : "text-button"}
                  onClick={() => {
                    stop();
                    setPendingRoi(null);
                    setDrawPanel(!drawPanel);
                  }}
                >
                  <Focus size={16} />
                  {drawPanel ? "拖动框选 WB 区域" : "框选 WB 区域"}
                </button>
                <button
                  className="text-button"
                  title="批量生成网格（会替换当前取样设置，可撤销）"
                  onClick={() => {
                    stop();
                    setPendingRoi(null);
                    setManual(true);
                  }}
                >
                  <Plus size={16} />
                  手动取样
                </button>
              </div>
            </div>
            {pendingRoi && (
              <div className="draw-tool-banner" role="status">
                <div>
                  <strong>
                    正在画{pendingRoi.kind === "band" ? "条带" : "背景"}框：
                    {pendingRoi.newRowLabel ?? drawingRow?.label} /{" "}
                    {pendingRoi.newLaneLabel ??
                      session.lanes.find((l) => l.id === pendingRoi.laneId)
                        ?.label}
                  </strong>
                  <p>
                    {drawingSize
                      ? `拖画确定中心，尺寸沿用同行 ${drawingSize.width} × ${drawingSize.height} px。`
                      : "在原图中按住鼠标拖出矩形。"}
                    Esc 取消，完成后可撤销。
                  </p>
                  {error && <p className="inline-warning">{error}</p>}
                </div>
                <button
                  className="secondary"
                  onClick={() => setPendingRoi(null)}
                >
                  取消画框
                </button>
              </div>
            )}
            {!pendingRoi && missingPairs.length > 0 && (
              <div className="missing-bands-strip">
                <strong>待补 {missingPairs.length} 个条带</strong>
                <span>点击后在图上拖画：</span>
                {missingPairs.slice(0, 12).map(({ row, lane }) => (
                  <button
                    key={`${row.id}:${lane.id}`}
                    className="secondary"
                    onClick={() =>
                      beginDrawing({
                        kind: "band",
                        rowId: row.id,
                        laneId: lane.id,
                      })
                    }
                  >
                    补框：{row.label} / {lane.label}
                  </button>
                ))}
                {missingPairs.length > 12 && (
                  <button
                    className="text-button"
                    onClick={() => setAddDialog(true)}
                  >
                    查看其他缺失项
                  </button>
                )}
              </div>
            )}
            <div className="work-grid">
              <section className="card image-card">
                <div className="card-header">
                  <h2>
                    <span className="section-number">01</span>原图与取样
                  </h2>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showRois}
                      onChange={(e) => setShowRois(e.target.checked)}
                    />
                    显示取样框
                  </label>
                </div>
                <div className="image-tools">
                  <div className="roi-key">
                    <span>
                      <i />
                      条带
                    </span>
                    <span>
                      <i className="ref" />
                      内参
                    </span>
                    <span>
                      <i className="bg" />
                      背景
                    </span>
                  </div>
                  <div className="zoom-controls">
                    <button
                      aria-label="缩小"
                      disabled={zoom <= 0.25}
                      onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
                    >
                      <ZoomOut size={16} />
                    </button>
                    <button
                      aria-label="重置视图"
                      title="重置到 100%"
                      onClick={() => setZoom(1)}
                    >
                      {Math.round(zoom * 100)}%
                    </button>
                    <button
                      aria-label="放大"
                      disabled={zoom >= 3}
                      onClick={() => setZoom(Math.min(3, zoom + 0.25))}
                    >
                      <ZoomIn size={16} />
                    </button>
                  </div>
                </div>
                <div className="image-viewport">
                  <div
                    className="image-scale"
                    style={{
                      width: `${zoom * 100}%`,
                      marginInline: zoom <= 1 ? "auto" : 0,
                    }}
                  >
                    <ImageStage
                      session={session}
                      selections={selections}
                      onSelect={setSelection}
                      onRects={onRects}
                      onDelete={deleteSelected}
                      showRois={showRois}
                      contrast={contrast}
                      drawPanel={drawPanel}
                      drawRoi={drawingTool}
                      onDrawRoi={addDrawnRoi}
                      onCancelDraw={() => {
                        setPendingRoi(null);
                        setDrawPanel(false);
                      }}
                      onPanel={(rect) => {
                        change("选择 WB 面板", (next) => {
                          next.panel = rect;
                        });
                        setDrawPanel(false);
                        setNotice("WB 区域已更新。点击「识别框选区域」进行 AI 识别，或点击「手动取样」生成网格；识别标签时请将蛋白名和组别也框入。");
                      }}
                    />
                  </div>
                </div>
                <div className="image-footer">
                  <label>
                    预览对比度{" "}
                    <input
                      type="range"
                      aria-label="预览对比度"
                      min="50"
                      max="200"
                      value={contrast}
                      onChange={(e) => setContrast(Number(e.target.value))}
                    />
                    <span>{contrast}%</span>
                  </label>
                  <span>仅改变显示</span>
                </div>
                <p className="selection-help">
                  Shift / Ctrl / ⌘ 点击多选 · 方向键移动 1 px（Shift 为 10 px）·
                  Backspace / Delete 删除 · Esc 取消
                </p>
                <label className="overlap-control">
                  <input type="checkbox" aria-label="允许轻微条带重叠"
                    checked={(session.measurementPolicy?.maxBandOverlapFraction ?? 0) > 0}
                    onChange={(e) => change("修改条带框重叠容许范围", next => {
                      next.measurementPolicy = {
                        maxBandOverlapFraction: e.target.checked ? 0.1 : 0,
                        backgroundMode,
                      };
                    })} />
                  允许同行条带框轻微重叠（每框 ≤10%）
                </label>
                {selections.length > 1 && (
                  <div className="roi-inspector multi-inspector">
                    <strong role="status">
                      已选 {selections.length} 个取样框
                    </strong>
                    <span>拖动或方向键整体移动；单选后可修改尺寸。</span>
                    <button className="danger-text" onClick={deleteSelected}>
                      <Trash2 size={13} />
                      删除所选框
                    </button>
                    <button
                      className="icon-button"
                      aria-label="取消选择"
                      onClick={() => setSelection(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {selections.length === 1 &&
                  selection &&
                  selectedBand &&
                  selectedRect && (
                    <div className="roi-inspector">
                      <div className="inspector-heading">
                        <strong>
                          {selectedRow?.label} ·{" "}
                          {
                            session.lanes.find((l) => l.id === selection.laneId)
                              ?.label
                          }
                        </strong>
                        <button
                          className="icon-button"
                          aria-label="取消选择"
                          onClick={() => setSelection(null)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="inspector-tabs">
                        <button
                          className={
                            selection.backgroundIndex === null ? "selected" : ""
                          }
                          onClick={() =>
                            setSelection({
                              ...selection,
                              backgroundIndex: null,
                            })
                          }
                        >
                          条带
                        </button>
                        {selectedBand.backgrounds.map((_, i) => (
                          <button
                            key={i}
                            className={
                              selection.backgroundIndex === i ? "selected" : ""
                            }
                            onClick={() =>
                              setSelection({ ...selection, backgroundIndex: i })
                            }
                          >
                            背景 {i + 1}
                          </button>
                        ))}
                        <button
                          disabled={selectedBand.backgrounds.length >= 20}
                          onClick={() =>
                            beginDrawing({
                              kind: "background",
                              rowId: selection.rowId,
                              laneId: selection.laneId,
                            })
                          }
                        >
                          画背景框
                        </button>
                        {!selectedBand.backgrounds.length && (
                          <button onClick={() => repairBackgrounds([{ rowId: selection.rowId, laneId: selection.laneId }])}>
                            建议背景
                          </button>
                        )}
                        <button
                          disabled={selectedBand.backgrounds.length >= 20}
                          title="每条条带最多 20 个背景区域"
                          onClick={() => {
                            const index = selectedBand.backgrounds.length;
                            change("添加背景区域", (next) => {
                              const b = next.rows
                                .find((r) => r.id === selection.rowId)!
                                .bands.find(
                                  (b) => b.laneId === selection.laneId,
                                )!;
                              b.backgrounds.push(
                                bound(
                                  {
                                    ...b.rect,
                                    y: b.rect.y + b.rect.height + 3,
                                    height: Math.max(
                                      2,
                                      Math.round(b.rect.height / 2),
                                    ),
                                  },
                                  next.source,
                                ),
                              );
                              refreshManualBandWarnings(b, "background");
                            });
                            setSelection({
                              ...selection,
                              backgroundIndex: index,
                            });
                          }}
                        >
                          ＋ 背景
                        </button>
                      </div>
                      <div className="rect-fields">
                        {(["x", "y", "width", "height"] as const).map((k) => (
                          <label key={k}>
                            {{ x: "X", y: "Y", width: "宽", height: "高" }[k]}
                            <NumberField
                              label={`ROI ${k}`}
                              value={selectedRect[k]}
                              min={k === "width" || k === "height" ? 1 : 0}
                              onChange={(value) =>
                                onRect(selection, {
                                  ...selectedRect,
                                  [k]: value,
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <div className="inspector-bottom">
                        <small>
                          {selection.backgroundIndex === null
                            ? "修改宽高会同步该蛋白行的条带框。"
                            : "背景需避开条带、黑框和文字。"}
                        </small>
                        <button
                          className="danger-text"
                          onClick={deleteSelected}
                        >
                          <Trash2 size={13} />
                          删除
                        </button>
                      </div>
                    </div>
                  )}
              </section>
              <section className="card result-card">
                <div className="card-header">
                  <h2>
                    <span className="section-number">02</span>趋势核对
                  </h2>
                  <span
                    className={
                      session.reviewed ? "status-badge checked" : "status-badge"
                    }
                  >
                    {session.reviewed ? <Check size={12} /> : null}
                    {session.reviewed ? "已人工核对" : "待人工核对"}
                  </span>
                </div>
                <div className="result-tabs">
                  <button
                    className={tab === "results" ? "selected" : ""}
                    onClick={() => setTab("results")}
                  >
                    相对强度
                  </button>
                  <button
                    className={tab === "settings" ? "selected" : ""}
                    onClick={() => setTab("settings")}
                  >
                    蛋白与分组
                    {session.rows.length > 0 && !session.controlLaneId && <i />}
                  </button>
                </div>
                {tab === "results" ? (
                  <>
                    {session.rows.length ? (
                      <>
                        <div className="chart-scroll">
                          <Chart
                            session={session}
                            measurements={measurements}
                          />
                        </div>
                        <div className="normalization-summary">
                          <span>归一化</span>
                          <strong>目标蛋白 / 同泳道内参</strong>
                          <span>对照</span>
                          <select
                            aria-label="对照泳道"
                            value={session.controlLaneId || ""}
                            onChange={(e) =>
                              change("修改对照泳道", (next) => {
                                next.controlLaneId = e.target.value || null;
                                next.controlLaneMode = "manual";
                              })
                            }
                          >
                            <option value="">请指定对照</option>
                            {session.lanes.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.label}
                              </option>
                            ))}
                          </select>
                          <button className="text-button" title="按条带位置选择最左侧泳道"
                            aria-label="使用最左侧泳道"
                            onClick={() => change("使用最左侧泳道作为对照", next => {
                              next.controlLaneId = leftmostLaneId(next);
                              next.controlLaneMode = "leftmost";
                            })}>最左侧</button>
                        </div>
                        <details className="chart-style-controls">
                          <summary>作图配色</summary>
                          <label>预设配色
                            <select aria-label="预设配色" value={session.chartStyle?.palette ?? "classic"}
                              onChange={e => changeChartStyle({ palette: e.target.value as ChartStyle["palette"] })}>
                              {Object.entries(PALETTES).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
                            </select>
                          </label>
                          <div className="lane-color-controls">
                            {session.lanes.map((lane, index) => <label key={lane.id}>
                              <input type="color" aria-label={`${lane.label} 柱状图颜色`} value={laneColor(session, index)}
                                onChange={e => changeChartStyle({ palette: session.chartStyle?.palette ?? "classic", colors: {
                                  ...Object.fromEntries(session.lanes.filter(l => session.chartStyle?.colors?.[l.id]).map(l => [l.id, session.chartStyle!.colors![l.id]])),
                                  [lane.id]: e.target.value,
                                } })} />
                              <span>{lane.label}</span>
                            </label>)}
                          </div>
                          <button className="text-button" onClick={() => changeChartStyle({ palette: session.chartStyle?.palette ?? "classic" })}>恢复预设颜色</button>
                          <p>仅改变图表外观；PNG / SVG 和分析文件保留配色，不改变测量值。多于 8 组时预设颜色循环，可逐组自定义。</p>
                        </details>
                        <div className="measurement-mode">
                          <label>背景处理
                            <select aria-label="背景处理方式" value={backgroundMode}
                              onChange={(e) => change("切换背景处理方式", next => {
                                next.measurementPolicy = {
                                  maxBandOverlapFraction: next.measurementPolicy?.maxBandOverlapFraction ?? 0,
                                  backgroundMode: e.target.value as "subtract" | "none",
                                };
                              })}>
                              <option value="subtract">扣除背景（默认）</option>
                              <option value="none">快速趋势（不扣背景）</option>
                            </select>
                          </label>
                          <p>{backgroundMode === "none"
                            ? "直接用条带灰度总和做内参和对照归一化；背景也计入信号，弱条带更易受影响。已有背景框保留，当前不参与计算。"
                            : "先扣除邻近背景，再做内参和对照归一化。缺少背景时可一键尝试补齐。"}</p>
                        </div>
                        <p className="chart-note">
                          柱高为单张截图的灰度估计。论文图可能汇总多次实验，请结合取样区域查看变化方向。
                        </p>
                        <QualityReview
                          session={session}
                          measurements={measurements}
                          onSelect={(items) => {
                            setSelections(items);
                            document.getElementById("source-stage")?.focus();
                            document
                              .getElementById("source-stage")
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              });
                          }}
                          onFitPanel={fitPanelToRois}
                          onSuggestBackgrounds={() => repairBackgrounds()}
                        />
                        <div className="review-action">
                          <label>
                            <input
                              type="checkbox"
                              checked={session.reviewed}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                stop();
                                try {
                                  commitSession({
                                    ...recordEdit(
                                      session,
                                      checked
                                        ? "标记已人工核对"
                                        : "撤销人工核对",
                                    ),
                                    reviewed: checked,
                                  });
                                } catch (e) {
                                  setError((e as Error).message);
                                }
                              }}
                            />
                            我已检查取样框、内参和对照对应关系
                          </label>
                        </div>
                      </>
                    ) : (
                      <div className="empty-result">
                        <div>
                          <ScanLine size={30} strokeWidth={1.3} />
                        </div>
                        <h3>从识别条带开始</h3>
                        <p>
                          配置视觉 API 后点击「自动识别」。
                          <br />
                          也可框选 WB 区域，手动生成取样框。
                        </p>
                        <button
                          className="secondary"
                          onClick={() => setSettings(true)}
                        >
                          配置 API <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mapping-panel">
                    <div className="mapping-title">
                      <strong>泳道与组别</strong>
                      <button
                        className="text-button"
                        disabled={session.lanes.length >= 100}
                        onClick={() =>
                          change("添加泳道", (next) => {
                            next.lanes.push({
                              id: crypto.randomUUID(),
                              label: `泳道 ${next.lanes.length + 1}`,
                            });
                          })
                        }
                      >
                        <Plus size={13} />
                        添加
                      </button>
                    </div>
                    <div className="lane-inputs">
                      {session.lanes.map((l, i) => (
                        <label key={l.id}>
                          <span>{String(i + 1).padStart(2, "0")}</span>
                          <TextField
                            label={`泳道 ${i + 1} 名称`}
                            value={l.label}
                            onChange={(value) =>
                              change("修改泳道标签", (next) => {
                                next.lanes.find(
                                  (lane) => lane.id === l.id,
                                )!.label = value;
                              })
                            }
                          />
                          <button
                            aria-label={`删除泳道 ${i + 1}`}
                            className="icon-button"
                            onClick={() => {
                              change("删除泳道", (next) => {
                                next.lanes = next.lanes.filter(
                                  (lane) => lane.id !== l.id,
                                );
                                next.rows.forEach(
                                  (r) =>
                                    (r.bands = r.bands.filter(
                                      (b) => b.laneId !== l.id,
                                    )),
                                );
                                if (next.controlLaneId === l.id)
                                  next.controlLaneId = next.controlLaneMode === "leftmost" ? leftmostLaneId(next) : null;
                                if (!next.lanes.length) next.rows = [];
                              });
                              setSelection(null);
                            }}
                          >
                            <X size={13} />
                          </button>
                        </label>
                      ))}
                    </div>
                    <div className="mapping-title">
                      <strong>蛋白与内参配对</strong>
                      <button
                        className="text-button"
                        disabled={
                          !session.lanes.length || session.rows.length >= 100
                        }
                        onClick={() =>
                          change("添加蛋白行", (next) => {
                            next.rows.push({
                              id: crypto.randomUUID(),
                              label: `蛋白 ${next.rows.length + 1}`,
                              role: "target",
                              referenceRowId: null,
                              bands: [],
                            });
                          })
                        }
                      >
                        <Plus size={13} />
                        添加
                      </button>
                    </div>
                    {session.rows.map((row, i) => (
                      <div className="protein-mapping" key={row.id}>
                        <div className="protein-name">
                          <TextField
                            label={`蛋白 ${i + 1} 名称`}
                            value={row.label}
                            onChange={(value) =>
                              change("修改蛋白标签", (next) => {
                                next.rows.find((r) => r.id === row.id)!.label =
                                  value;
                              })
                            }
                          />
                          <select
                            aria-label={`${row.label} 类型`}
                            value={row.role}
                            onChange={(e) =>
                              change("修改蛋白角色", (next) => {
                                const r = next.rows.find(
                                  (r) => r.id === row.id,
                                )!;
                                r.role = e.target.value as
                                  "target" | "reference";
                                r.referenceRowId = null;
                                next.rows.forEach((other) => {
                                  if (other.referenceRowId === r.id)
                                    other.referenceRowId = null;
                                });
                              })
                            }
                          >
                            <option value="target">目标</option>
                            <option value="reference">内参</option>
                          </select>
                          <button
                            className="icon-button"
                            aria-label={`删除 ${row.label}`}
                            onClick={() => {
                              change("删除蛋白行", (next) => {
                                next.rows = next.rows.filter(
                                  (r) => r.id !== row.id,
                                );
                                next.rows.forEach((r) => {
                                  if (r.referenceRowId === row.id)
                                    r.referenceRowId = null;
                                });
                              });
                              setSelection(null);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {row.role === "target" && (
                          <label className="ref-select">
                            内参
                            <select
                              aria-label={`${row.label} 内参`}
                              value={row.referenceRowId || ""}
                              onChange={(e) =>
                                change("修改内参配对", (next) => {
                                  next.rows.find(
                                    (r) => r.id === row.id,
                                  )!.referenceRowId = e.target.value || null;
                                })
                              }
                            >
                              <option value="">待指定</option>
                              {session.rows
                                .filter((r) => r.role === "reference")
                                .map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.label}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                        <div className="band-links">
                          {session.lanes.map((l) => {
                            const band = row.bands.find(
                              (b) => b.laneId === l.id,
                            );
                            return (
                              <button
                                key={l.id}
                                className={band ? "" : "missing"}
                                onClick={() => {
                                  if (!band) {
                                    beginDrawing({
                                      kind: "band",
                                      rowId: row.id,
                                      laneId: l.id,
                                    });
                                    return;
                                  }
                                  setSelection({
                                    rowId: row.id,
                                    laneId: l.id,
                                    backgroundIndex: null,
                                  });
                                }}
                              >
                                {band ? "" : "＋ "}
                                {l.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
            {session.warnings.length > 0 && (
              <details className="session-warnings">
                <summary>
                  识别 / 建框时的原始备注（{session.warnings.length}{" "}
                  条，仅供追溯）
                </summary>
                <p>
                  以下为当时的记录，不会随手工修改更新。当前状态见「检查提示」。
                </p>
                {session.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </details>
            )}
            {session.rows.length > 0 && (
              <section className="card measurement-card" id="measurements">
                <div className="card-header">
                  <h2>
                    <span className="section-number">03</span>测量明细
                  </h2>
                  <span className="muted">
                    原尺寸像素 · {session.history.length} 次操作记录
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>蛋白 / 泳道</th>
                        <th>面积 px²</th>
                        <th>信号总和</th>
                        <th>{backgroundMode === "none" ? "背景（未使用）" : "背景均值"}</th>
                        <th>{backgroundMode === "none" ? "未扣背景信号" : "净信号"}</th>
                        <th>{backgroundMode === "none" ? "内参原始信号" : "内参净信号"}</th>
                        <th>归一化</th>
                        <th>相对值</th>
                        <th>检查提示</th>
                      </tr>
                    </thead>
                    <tbody>
                      {measurements.map((m) => {
                        const row = session.rows.find((r) => r.id === m.rowId)!;
                        return (
                          <tr
                            key={`${m.rowId}:${m.laneId}`}
                            onClick={(e) => {
                              if ((e.target as HTMLElement).closest("details"))
                                return;
                              setSelection(
                                {
                                  rowId: m.rowId,
                                  laneId: m.laneId,
                                  backgroundIndex: null,
                                },
                                e.shiftKey || e.ctrlKey || e.metaKey,
                              );
                            }}
                          >
                            <td>
                              <strong>{row.label}</strong>
                              <small>
                                {
                                  session.lanes.find((l) => l.id === m.laneId)
                                    ?.label
                                }
                                {row.role === "reference" ? " · 内参" : ""}
                              </small>
                            </td>
                            <td>{pretty(m.area, 0)}</td>
                            <td>{pretty(m.bandSum, 0)}</td>
                            <td>{pretty(m.backgroundMean)}</td>
                            <td>{pretty(m.net)}</td>
                            <td>{pretty(m.referenceNet)}</td>
                            <td>{pretty(m.ratio, 4)}</td>
                            <td className="relative-value">
                              {pretty(m.relative, 4)}
                            </td>
                            <td
                              className={
                                m.reason || m.warnings.length
                                  ? "measurement-warning"
                                  : "muted"
                              }
                            >
                              <MeasurementChecks measurement={m} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
        <footer className="page-footer">
          <span>
            BlotLens <span className="version">v{APP_VERSION}</span>
          </span>
          <span>截图趋势核对 · 保留原图与分析过程</span>
          <button
            className="text-button"
            onClick={() =>
              setNotice(
                "模型只提供布局与标签。默认净信号 = 条带信号总和 − 面积 × 背景平均信号；快速趋势模式直接使用未扣背景的信号总和。两者均按同泳道内参及对照归一化，图表和导出标注当前方式。截图无法验证原始曝光线性范围，也不代表所有实验重复。",
              )
            }
          >
            方法与解释范围
          </button>
        </footer>
      </main>
      {settings && (
        <SettingsModal
          config={config}
          onClose={() => setSettings(false)}
          onSave={(value) => {
            stop();
            setConfig(value);
            setSettings(false);
            setNotice(
              "API 设置已保存在本机服务内存中。点击「自动识别」才会发送截图。",
            );
          }}
        />
      )}
      {addDialog && session && (
        <AddRoiDialog
          session={session}
          onClose={() => setAddDialog(false)}
          onStart={beginDrawing}
        />
      )}
      {manual && (
        <div className="modal-backdrop">
          <section
            className="modal compact"
            role="dialog"
            aria-modal="true"
            aria-label="手动取样设置"
          >
            <div className="modal-heading">
              <h2>生成取样网格</h2>
              <button
                className="icon-button"
                aria-label="关闭手动取样"
                onClick={() => setManual(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>
              在选定 WB
              区域内生成取样框。生成后可拖动、缩放并指定背景；会替换当前取样设置。
            </p>
            <div className="two-fields">
              <label>
                蛋白行数（含内参）
                <NumberField
                  label="蛋白行数"
                  value={rowsCount}
                  min={1}
                  max={30}
                  onChange={setRowsCount}
                />
              </label>
              <label>
                泳道数
                <NumberField
                  label="泳道数"
                  value={lanesCount}
                  min={1}
                  max={30}
                  onChange={setLanesCount}
                />
              </label>
            </div>
            <button className="primary full" onClick={makeGrid}>
              生成取样框
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "未配置服务";
  }
}
function bound(r: Rect, s: SourceImage): Rect {
  const width = Math.max(1, Math.min(s.width, Math.round(r.width))),
    height = Math.max(1, Math.min(s.height, Math.round(r.height)));
  return {
    x: Math.max(0, Math.min(s.width - width, Math.round(r.x))),
    y: Math.max(0, Math.min(s.height - height, Math.round(r.y))),
    width,
    height,
  };
}
function NumberField({
  value,
  onChange,
  label,
  min = 0,
  max = 100000,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() && Number.isFinite(n)) {
      onChange(Math.max(min, Math.min(max, Math.round(n))));
    } else setText(String(value));
  };
  return (
    <input
      aria-label={label}
      type="number"
      value={text}
      min={min}
      max={max}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
function TextField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (s: string) => void;
  label: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      maxLength={120}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = text.trim();
        if (v && v !== value) onChange(v);
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
function SettingsModal({
  config,
  onClose,
  onSave,
}: {
  config: Config;
  onClose: () => void;
  onSave: (c: Config) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl),
    [model, setModel] = useState(config.model),
    [key, setKey] = useState(""),
    [clearKey, setClearKey] = useState(false),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = {
        baseUrl,
        model,
        ...(key ? { apiKey: key } : clearKey ? { apiKey: "" } : {}),
      };
      const result = await api<Config>("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setKey("");
      onSave(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="视觉 API 设置"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">VISION CONNECTION</span>
            <h2>视觉 API 设置</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          使用支持图片输入的 OpenAI 兼容 Chat Completions
          接口。截图发送给你选择的服务；灰度测量在本机完成。
        </p>
        <form onSubmit={save}>
          <label>
            Base URL
            <input
              required
              type="url"
              aria-label="Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label>
            模型名
            <input
              required
              aria-label="模型名"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="填写支持视觉输入的模型 ID"
              autoComplete="off"
            />
          </label>
          <label>
            API Key
            <span className="field-hint">
              {config.keyConfigured
                ? "已配置；同一服务留空保持，跨服务需重填"
                : "仅保存在本机服务内存"}
            </span>
            <input
              aria-label="API Key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                config.keyConfigured
                  ? "••••••••（服务重启后需重填）"
                  : "输入 API 密钥"
              }
              autoComplete="off"
            />
          </label>
          {config.keyConfigured && (
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
              />
              清除当前密钥
            </label>
          )}
          <div className="settings-note">
            <ShieldCheck size={18} />
            <span>
              密钥不会写入分析文件或浏览器存储。保存设置不会发送截图；每次识别由你点击触发。
            </span>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="primary full" disabled={saving}>
            {saving ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            保存设置
          </button>
        </form>
      </section>
    </div>
  );
}
