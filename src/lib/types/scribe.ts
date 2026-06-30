export type ScribeStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "completed"
  | "failed";

export interface ScribeResult {
  transcript?: string;
  templates?: Record<string, unknown>[];
  structuredData?: Record<string, unknown>;
}
