export const APP_VERSION = "0.2.0";
export const ALGORITHM_VERSION = "screenshot-density-1";
export interface MeasurementPolicy {
  maxBandOverlapFraction: 0 | 0.1;
  /** Omitted in existing files means background subtraction. */
  backgroundMode?: "subtract" | "none";
}
export const DEFAULT_MEASUREMENT_POLICY: Readonly<MeasurementPolicy> = { maxBandOverlapFraction: 0.1, backgroundMode: "subtract" };
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SourceImage {
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  sha256: string;
}
export interface Lane {
  id: string;
  label: string;
}
export interface Band {
  laneId: string;
  rect: Rect;
  backgrounds: Rect[];
  warnings: string[];
}
export interface ProteinRow {
  id: string;
  label: string;
  role: "target" | "reference";
  referenceRowId: string | null;
  bands: Band[];
}
export interface Detection {
  panel: Rect;
  lanes: Lane[];
  rows: {
    id: string;
    label: string;
    role: "target" | "reference";
    referenceRowId: string | null;
    bands: { laneId: string; rect: Rect }[];
  }[];
  controlLaneId: string | null;
  warnings: string[];
}
export interface RecognitionRecord {
  providerBaseUrl: string;
  model: string;
  promptVersion: string;
  rawResponse: string;
  createdAt: string;
  /** Optional source-pixel crop sent to the model; rawResponse coordinates refer to this crop. */
  inputRegion?: Rect;
}
export interface RecognitionResult extends RecognitionRecord {
  detection: Detection;
}
export interface ChartStyle {
  palette: "classic" | "vivid" | "distinct" | "gray";
  colors?: Record<string, string>;
}
export interface EditRecord {
  at: string;
  action: string;
  rows: ProteinRow[];
  lanes: Lane[];
  controlLaneId: string | null;
  controlLaneMode?: "leftmost" | "manual";
  measurementPolicy?: MeasurementPolicy;
  chartStyle?: ChartStyle;
}
export interface ReviewSession {
  format: "wb-review";
  schemaVersion: 1;
  appVersion: string;
  algorithmVersion: string;
  source: SourceImage;
  panel: Rect;
  lanes: Lane[];
  rows: ProteinRow[];
  controlLaneId: string | null;
  /** Missing in legacy files is treated as a preserved manual choice. */
  controlLaneMode?: "leftmost" | "manual";
  /** Absent in older files means strict, zero-overlap measurement. */
  measurementPolicy?: MeasurementPolicy;
  chartStyle?: ChartStyle;
  reviewed: boolean;
  warnings: string[];
  recognition: RecognitionRecord | null;
  history: EditRecord[];
  createdAt: string;
}
export interface BandMeasurement {
  rowId: string;
  laneId: string;
  area: number;
  bandSum: number;
  /** Neutral fraction of sampled pixels whose grayscale is <=1; not an exposure/saturation diagnosis. */
  nearBlackFraction: number | null;
  backgroundMean: number | null;
  /** Signal used for normalization: background-corrected by default, raw in backgroundMode=none. */
  net: number | null;
  referenceNet: number | null;
  ratio: number | null;
  relative: number | null;
  warnings: string[];
  reason: string | null;
}
