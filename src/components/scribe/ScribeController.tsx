import {
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  Mic,
  Pause,
  Play,
  Sparkles,
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

const PROCESSING_STEPS = [
  "transcribing_audio",
  "extracting_details",
  "filling_form",
] as const;

export function ScribeController(props: ScribeControllerProps) {
  // Tailwind utilities in this plugin are scoped under
  // `.care-eka-scribe-fe-container` (see index.css). The rendered output must
  // live inside that container for classes (fixed positioning, gradients, etc.)
  // and theme tokens to apply.
  return (
    <div className="care-eka-scribe-fe-container">
      <ScribeControllerInner {...props} />
    </div>
  );
}

function ScribeControllerInner({
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

  // Open the results view automatically once transcription/processing finishes
  useEffect(() => {
    if (scribe.status === "completed") {
      setExpanded(true);
    }
  }, [scribe.status]);

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

  // Idle state — floating pill FAB (bottom-right)
  if (scribe.status === "idle") {
    return (
      <div className="ekascribe-pop-in fixed right-4 bottom-4 z-9999 sm:right-6 sm:bottom-6">
        <button
          onClick={handleStart}
          disabled={scribe.isStarting}
          className={cn(
            "group relative flex items-center gap-2 overflow-hidden rounded-full bg-linear-to-br from-primary-600 via-primary-700 to-primary-800 py-3 pr-5 pl-4 text-white shadow-lg shadow-primary-700/30 transition-all",
            scribe.isStarting
              ? "opacity-90"
              : "hover:shadow-xl hover:shadow-primary-700/40 hover:brightness-110 active:scale-95",
          )}
          title={scribe.isStarting ? t("starting") : t("start_ai_scribe")}
        >
          {/* soft rotating glow */}
          <span className="ekascribe-spin-slow pointer-events-none absolute -inset-16 scale-150 rounded-full bg-[conic-gradient(from_0deg,transparent,rgba(255,255,255,0.35),transparent)] opacity-60" />
          <span className="relative flex h-6 w-6 items-center justify-center">
            {scribe.isStarting ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </span>
          <span className="relative text-sm font-semibold">
            {scribe.isStarting ? t("starting") : t("ai_scribe")}
          </span>
          <Sparkles className="relative h-4 w-4 opacity-80" />
        </button>
      </div>
    );
  }

  const transcript = liveTranscript || scribe.result?.transcript || "";
  const showTranscript =
    transcript &&
    (scribe.status === "processing" || scribe.status === "completed");

  // Real processing progress, derived from actual API signals (not a timer):
  //  0 = transcribing audio  (recording ended, no transcript yet)
  //  1 = extracting details  (transcript received, structuring templates)
  //  2 = filling the form    (structured result received / completed)
  const processingStep = scribe.status === "completed" ? 2 : transcript ? 1 : 0;

  // Compact / status views (recording, processing, completed, failed)
  if (!expanded) {
    return (
      <div className="ekascribe-pop-in fixed right-4 bottom-4 z-9999 flex flex-col items-end gap-3 sm:right-6 sm:bottom-6">
        {/* Live transcript — collapsible, shown while processing/completed */}
        {showTranscript && !transcriptMinimized && (
          <div className="w-72 overflow-hidden rounded-2xl border border-gray-100 bg-white/95 shadow-xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-gray-500 uppercase">
                <FileText className="h-3 w-3" />
                {t("transcript")}
              </span>
              <div className="flex items-center gap-1">
                {scribe.status === "completed" && (
                  <span className="text-[10px] font-semibold text-primary-700">
                    {t("filled_count", { n: filledCount })}
                  </span>
                )}
                <button
                  onClick={() => setTranscriptMinimized(true)}
                  className="rounded-md p-0.5 text-gray-400 hover:bg-gray-100"
                  title={t("minimize_transcript")}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p className="max-h-28 overflow-y-auto px-3 py-2.5 text-xs leading-relaxed text-gray-600">
              {transcript}
            </p>
          </div>
        )}

        {/* PROCESSING — text above orb, no card */}
        {scribe.status === "processing" && (
          <div className="flex flex-col items-center gap-2">
            <p className="ekascribe-shimmer-text text-xs font-medium">
              {t(PROCESSING_STEPS[processingStep])}
            </p>
            <AiPulse />
            {showTranscript && transcriptMinimized && (
              <button
                onClick={() => setTranscriptMinimized(false)}
                className="flex items-center gap-1 text-[10px] font-medium text-primary-600 hover:text-primary-800"
              >
                <FileText className="h-2.5 w-2.5" />
                {t("show_transcript")}
              </button>
            )}
          </div>
        )}

        {/* RECORDING / PAUSED — live pill */}
        {(scribe.status === "recording" || scribe.status === "paused") && (
          <div
            className={cn(
              "flex items-center gap-3 rounded-full border bg-white py-2 pr-2 pl-4 shadow-xl",
              scribe.status === "recording"
                ? "border-red-100"
                : "border-amber-100",
            )}
          >
            <div
              className={cn(
                "flex items-center gap-2",
                scribe.status === "recording"
                  ? "text-red-500"
                  : "text-amber-500",
              )}
            >
              {scribe.status === "recording" ? (
                <VoiceBars />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              <span className="font-mono text-sm font-semibold text-gray-800">
                {timeStr}
              </span>
            </div>

            {scribe.status === "recording" && (
              <>
                <button
                  onClick={scribe.pauseRecording}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100"
                  title={t("pause")}
                >
                  <Pause className="h-4 w-4" />
                </button>
                <button
                  onClick={handleStop}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
                  title={t("stop_and_process")}
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              </>
            )}

            {scribe.status === "paused" && (
              <>
                <button
                  onClick={scribe.resumeRecording}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-700 text-white transition-colors hover:bg-primary-800"
                  title={t("resume")}
                >
                  <Play className="h-4 w-4" />
                </button>
                <button
                  onClick={handleStop}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
                  title={t("stop_and_process")}
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        )}

        {/* COMPLETED — success pill */}
        {scribe.status === "completed" && (
          <div className="flex items-center gap-2 rounded-full border border-primary-100 bg-white py-2 pr-2 pl-3 shadow-xl">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-600 text-white">
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-primary-800">
              {t("filled_count", { n: filledCount })}
            </span>
            <button
              onClick={() => setExpanded(true)}
              className="rounded-full px-3 py-1 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100"
            >
              {t("view")}
            </button>
            <button
              onClick={handleDismiss}
              className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100"
              title={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* FAILED — error pill */}
        {scribe.status === "failed" && (
          <div className="flex items-center gap-2 rounded-full border border-red-100 bg-white py-2 pr-2 pl-3 shadow-xl">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
            <span className="text-sm font-medium text-red-600">
              {t("failed")}
            </span>
            <button
              onClick={() => setExpanded(true)}
              className="rounded-full px-3 py-1 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100"
            >
              {t("view")}
            </button>
            <button
              onClick={handleDismiss}
              className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100"
              title={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    );
  }

  // Expanded view — show transcript & results
  return (
    <div className="ekascribe-pop-in fixed right-4 bottom-4 z-9999 w-80 sm:right-6 sm:bottom-6">
      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 bg-linear-to-r from-primary-100 to-transparent px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-600 text-white">
              <CheckCircle2 className="h-3.5 w-3.5" />
            </span>
            <span className="text-xs font-semibold text-gray-700">
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

// --- AI animation sub-components ---

/** Live equalizer voice bars (inherits color via `currentColor`). */
function VoiceBars({ className }: { className?: string }) {
  return (
    <span className={cn("flex h-4 items-end gap-0.5", className)}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="ekascribe-bar w-0.5 rounded-full bg-current"
          style={{ height: "100%", animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

/** Premium AI processing indicator — two counter-rotating gradient arc
 *  "comets" around a glowing core. No dependencies, care green palette. */
function AiPulse() {
  return (
    <div className="relative flex h-20 w-20 items-center justify-center">
      {/* ambient glow */}
      <span className="ekascribe-glow absolute h-14 w-14 rounded-full bg-primary-400/30 blur-xl" />

      {/* outer arc — slow clockwise comet */}
      <svg
        className="ekascribe-spin-slow absolute inset-0 h-full w-full"
        viewBox="0 0 80 80"
        fill="none"
      >
        <defs>
          <linearGradient
            id="ekascribe-arc-outer"
            gradientUnits="userSpaceOnUse"
            x1="4"
            y1="40"
            x2="76"
            y2="40"
          >
            <stop offset="0%" stopColor="#31c48d" stopOpacity="0" />
            <stop offset="100%" stopColor="#0d9f6e" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <circle
          cx="40"
          cy="40"
          r="36"
          stroke="url(#ekascribe-arc-outer)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray="158 68"
        />
      </svg>

      {/* inner arc — faster counter-clockwise comet */}
      <svg
        className="absolute inset-2 h-[calc(100%-1rem)] w-[calc(100%-1rem)]"
        style={{ animation: "ekascribe-spin 2.6s linear infinite reverse" }}
        viewBox="0 0 64 64"
        fill="none"
      >
        <defs>
          <linearGradient
            id="ekascribe-arc-inner"
            gradientUnits="userSpaceOnUse"
            x1="4"
            y1="32"
            x2="60"
            y2="32"
          >
            <stop offset="0%" stopColor="#84e1bc" stopOpacity="0" />
            <stop offset="100%" stopColor="#84e1bc" stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <circle
          cx="32"
          cy="32"
          r="28"
          stroke="url(#ekascribe-arc-inner)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="110 66"
        />
      </svg>

      {/* blinking blurry star core */}
      <div className="relative z-10 flex h-8 w-8 items-center justify-center">
        {/* soft glow behind the star */}
        <span className="ekascribe-orb absolute h-8 w-8 rounded-full bg-primary-400/50 blur-md" />
        <Sparkles className="ekascribe-star-blink relative h-5 w-5 text-white drop-shadow-[0_0_6px_#31c48d]" />
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
