import {
  CheckCircle,
  ChevronDown,
  FileText,
  Loader2,
  Mic,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { applyFieldToState, collectFieldsToFill } from "@/lib/structured/fill";
import type { ScribeResult } from "@/lib/types/scribe";
import { cn } from "@/lib/utils";

import { useScribe } from "@/hooks/useScribe";
import { useTranslation } from "@/hooks/useTranslation";

interface ScribeControllerProps {
  formState?: unknown;
  setFormState?: (fn: (state: unknown) => unknown) => void;
}

const FIELD_FILL_DELAY_MS = 500;

export function ScribeController({
  formState,
  setFormState,
}: ScribeControllerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [transcriptMinimized, setTranscriptMinimized] = useState(false);
  const appliedRef = useRef(false);
  const fillTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [filledCount, setFilledCount] = useState(0);

  const clearFillTimeouts = useCallback(() => {
    fillTimeoutsRef.current.forEach(clearTimeout);
    fillTimeoutsRef.current = [];
  }, []);

  const applyResults = useCallback(
    async (result: ScribeResult) => {
      if (!setFormState || !formState) return;
      if (!result.structuredData) {
        console.warn("[EkaScribe] No structured data to fill");
        return;
      }
      if (appliedRef.current) return;
      appliedRef.current = true;

      try {
        const fieldsToFill = await collectFieldsToFill(
          formState,
          result.structuredData,
        );

        if (import.meta.env.DEV) {
          console.log("[EkaScribe] Fields to fill:", fieldsToFill);
        }

        if (!fieldsToFill.length) {
          console.warn(
            "[EkaScribe] No matching fields found for extracted data",
            result.structuredData,
          );
        }

        setFilledCount(0);

        fieldsToFill.forEach((field, index) => {
          const timeoutId = setTimeout(() => {
            setFormState((currentState: unknown) =>
              applyFieldToState(currentState, field),
            );
            highlightField(field.qId);
            setFilledCount(index + 1);
          }, index * FIELD_FILL_DELAY_MS);

          fillTimeoutsRef.current.push(timeoutId);
        });
      } catch (err) {
        appliedRef.current = false;
        console.error("[EkaScribe] Failed to apply results:", err);
      }
    },
    [formState, setFormState],
  );

  const [liveTranscript, setLiveTranscript] = useState<string>("");

  const scribe = useScribe({
    formState,
    onTranscript: (transcript) => {
      setLiveTranscript(transcript);
    },
    onResult: (result) => {
      console.log("[EkaScribe] Result:", result);
      void applyResults(result);
    },
    onError: (error) => {
      console.error("[EkaScribe] Error:", error);
    },
  });

  const handleStart = async () => {
    clearFillTimeouts();
    appliedRef.current = false;
    setFilledCount(0);
    setTranscriptMinimized(false);
    await scribe.startRecording();
  };

  const handleStop = async () => {
    await scribe.stopRecording();
  };

  const handleDismiss = async () => {
    clearFillTimeouts();
    await scribe.reset();
    setExpanded(false);
    setTranscriptMinimized(false);
  };

  useEffect(() => clearFillTimeouts, [clearFillTimeouts]);

  const duration = scribe.duration;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const timeStr = `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;

  // Idle state — show FAB
  if (scribe.status === "idle") {
    return (
      <button
        onClick={handleStart}
        disabled={scribe.isStarting}
        className={cn(
          "fixed right-6 bottom-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary-700 text-white shadow-lg transition-transform",
          scribe.isStarting ? "cursor-wait opacity-90" : "hover:scale-105",
        )}
        title={scribe.isStarting ? t("starting") : t("start_ai_scribe")}
      >
        {scribe.isStarting ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Mic className="h-5 w-5" />
        )}
      </button>
    );
  }

  // Compact pill (default view while recording/processing/completed)
  if (!expanded) {
    const transcript = liveTranscript || scribe.result?.transcript || "";
    const showTranscript =
      transcript &&
      (scribe.status === "processing" || scribe.status === "completed");

    return (
      <div className="fixed right-6 bottom-6 z-50 flex flex-col items-end gap-2">
        {/* Transcript box — can be minimized without dismissing */}
        {showTranscript && !transcriptMinimized && (
          <div className="w-72 rounded-lg border border-gray-200 bg-white p-2.5 shadow-md">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-gray-400 uppercase">
                {t("transcript")}
              </span>
              <div className="flex items-center gap-1">
                {scribe.status === "completed" && (
                  <span className="text-[10px] font-medium text-green-600">
                    {t("filled_count", { n: filledCount })}
                  </span>
                )}
                <button
                  onClick={() => setTranscriptMinimized(true)}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-100"
                  title={t("minimize_transcript")}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-gray-600">
              {transcript}
            </p>
          </div>
        )}

        {/* Pill */}
        <div className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1.5 shadow-lg">
          {/* Status dot */}
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              scribe.status === "recording" && "animate-pulse bg-red-500",
              scribe.status === "paused" && "bg-amber-500",
              scribe.status === "processing" && "animate-pulse bg-blue-500",
              scribe.status === "completed" && "bg-green-500",
              scribe.status === "failed" && "bg-red-500",
            )}
          />

          {/* Timer */}
          {(scribe.status === "recording" || scribe.status === "paused") && (
            <span className="font-mono text-xs font-medium text-gray-700">
              {timeStr}
            </span>
          )}

          {scribe.status === "processing" && (
            <span className="text-xs text-gray-500">{t("processing")}</span>
          )}

          {scribe.status === "completed" && (
            <span className="text-xs font-medium text-green-700">
              {t("done")}
            </span>
          )}

          {scribe.status === "failed" && (
            <span className="text-xs text-red-500">{t("failed")}</span>
          )}

          {/* Inline controls */}
          {scribe.status === "recording" && (
            <>
              <button
                onClick={scribe.pauseRecording}
                className="rounded-full p-1 text-gray-500 hover:bg-gray-100"
                title={t("pause")}
              >
                <Pause className="h-3 w-3" />
              </button>
              <button
                onClick={handleStop}
                className="rounded-full p-1 text-red-500 hover:bg-red-50"
                title={t("stop_and_process")}
              >
                <Square className="h-3 w-3" />
              </button>
            </>
          )}

          {scribe.status === "paused" && (
            <>
              <button
                onClick={scribe.resumeRecording}
                className="rounded-full p-1 text-primary-600 hover:bg-primary-50"
                title={t("resume")}
              >
                <Play className="h-3 w-3" />
              </button>
              <button
                onClick={handleStop}
                className="rounded-full p-1 text-red-500 hover:bg-red-50"
                title={t("stop_and_process")}
              >
                <Square className="h-3 w-3" />
              </button>
            </>
          )}

          {scribe.status === "processing" && (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
              {showTranscript && transcriptMinimized && (
                <button
                  onClick={() => setTranscriptMinimized(false)}
                  className="rounded-full p-1 text-gray-500 hover:bg-gray-100"
                  title={t("show_transcript")}
                >
                  <FileText className="h-3 w-3" />
                </button>
              )}
            </>
          )}

          {scribe.status === "completed" && (
            <>
              {showTranscript && transcriptMinimized && (
                <button
                  onClick={() => setTranscriptMinimized(false)}
                  className="rounded-full p-1 text-gray-500 hover:bg-gray-100"
                  title={t("show_transcript")}
                >
                  <FileText className="h-3 w-3" />
                </button>
              )}
              <button
                onClick={handleDismiss}
                className="rounded-full p-1 text-gray-400 hover:bg-gray-100"
                title={t("dismiss")}
              >
                <X className="h-3 w-3" />
              </button>
            </>
          )}

          {/* Expand button */}
          {(scribe.status === "completed" || scribe.status === "failed") && (
            <button
              onClick={() => setExpanded(true)}
              className="ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary-700 hover:bg-primary-50"
            >
              {t("view")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Expanded view — show transcript & results
  return (
    <div className="fixed right-6 bottom-6 z-50 w-80">
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span className="text-xs font-medium text-gray-700">
              {t("fields_filled", { n: filledCount })}
            </span>
          </div>
          <button
            onClick={() => {
              setExpanded(false);
              setTranscriptMinimized(true);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100"
            title={t("minimize")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Transcript */}
        <div className="max-h-60 overflow-y-auto p-3">
          {scribe.result?.transcript && (
            <div className="mb-3">
              <span className="text-[10px] font-medium text-gray-400 uppercase">
                {t("transcript")}
              </span>
              <p className="mt-1 text-xs leading-relaxed text-gray-600">
                {scribe.result.transcript}
              </p>
            </div>
          )}

          {scribe.result?.structuredData && (
            <div>
              <span className="text-[10px] font-medium text-gray-400 uppercase">
                {t("extracted_values")}
              </span>
              <div className="mt-1 space-y-1">
                {Object.entries(scribe.result.structuredData).map(
                  ([key, val]) =>
                    key !== "clinical_notes" &&
                    !key.endsWith("_note") && (
                      <div
                        key={key}
                        className="flex items-center justify-between rounded bg-gray-50 px-2 py-1"
                      >
                        <span className="text-xs text-gray-500">{key}</span>
                        <span className="text-xs font-medium text-gray-900">
                          {Array.isArray(val)
                            ? `${val.length} item${val.length === 1 ? "" : "s"}`
                            : typeof val === "object"
                              ? JSON.stringify(val)
                              : String(val)}
                          {scribe.result?.structuredData?.[`${key}_note`] !=
                            null && (
                            <span className="ml-1 font-normal text-gray-500">
                              (
                              {String(
                                scribe.result.structuredData[`${key}_note`],
                              )}
                              )
                            </span>
                          )}
                        </span>
                      </div>
                    ),
                )}
              </div>
            </div>
          )}

          {scribe.error && (
            <p className="text-xs text-red-500">{scribe.error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-3 py-2">
          <button
            onClick={handleDismiss}
            className="w-full rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200"
          >
            {t("done")}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Form fill utilities ---

function highlightField(qId: string): void {
  const HIGHLIGHT_CLASS = "ekascribe-highlight";
  const el = document.getElementById(`question-${qId}`);
  if (!el) return;

  el.classList.remove(HIGHLIGHT_CLASS);
  void el.offsetWidth;
  el.classList.add(HIGHLIGHT_CLASS);
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 3000);
}

export default ScribeController;
