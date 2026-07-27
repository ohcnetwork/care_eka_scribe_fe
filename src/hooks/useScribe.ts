import {
  type EkaScribeConfig,
  type GetSessionStatusResponse,
  createWorkerBlobUrl,
  getEkaScribeInstance,
} from "@eka-care/ekascribe-ts-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildTemplateDescription,
  extractFormFields,
  getOrCreateTemplate,
} from "@/lib/template-builder";
import type { ScribeResult, ScribeStatus } from "@/lib/types/scribe";

const EKA_ENV = (import.meta.env.REACT_EKA_ENV || "DEV") as "PROD" | "DEV";
const EKA_ACCESS_TOKEN = import.meta.env.REACT_EKA_ACCESS_TOKEN || "";

// Spoken language hint, comma-separated ISO codes (e.g. "ta" or "ta,en").
// Forcing the language avoids per-chunk auto-detection flip-flopping on
// code-switched speech (e.g. Tamil consultation with English drug names).
const SCRIBE_LANGUAGES: string[] = (
  import.meta.env.REACT_SCRIBE_LANGUAGES || "auto_detect"
)
  .split(",")
  .map((code: string) => code.trim())
  .filter(Boolean);

// Scribe backend resolution (in priority order):
// 1. REACT_SCRIBE_BE_URL env — explicit override (standalone FastAPI server)
// 2. window.CARE_API_URL + /api/care_scribe_be — CARE backend plugin, same
//    origin/auth as the rest of the CARE API (care_scribe_fe convention)
// 3. Eka Care cloud — fallback when neither is available
const SCRIBE_BE_OVERRIDE = (import.meta.env.REACT_SCRIBE_BE_URL || "").replace(
  /\/$/,
  "",
);

function resolveScribeBackend(): { baseUrl: string; custom: boolean } {
  if (SCRIBE_BE_OVERRIDE) {
    return { baseUrl: `${SCRIBE_BE_OVERRIDE}/v1`, custom: true };
  }
  const careApiUrl =
    typeof window !== "undefined" ? window.CARE_API_URL : undefined;
  if (careApiUrl) {
    const base = careApiUrl.replace(/\/$/, "");
    return { baseUrl: `${base}/api/care_scribe_be/v1`, custom: true };
  }
  return {
    baseUrl:
      EKA_ENV === "DEV"
        ? "https://api.dev.eka.care/voice/v1"
        : "https://api.eka.care/voice/v1",
    custom: false,
  };
}

const { baseUrl: EKA_BASE_URL, custom: USING_CUSTOM_BACKEND } =
  resolveScribeBackend();

/** CARE user JWT — same convention as care_scribe_fe. */
function getCareAccessToken(): string {
  try {
    return localStorage.getItem("care_access_token") || "";
  } catch {
    return "";
  }
}

const SESSION_POLL_INTERVAL_MS = 750;
const SESSION_POLL_MAX_ATTEMPTS = 160;

// Template result statuses that mean processing is finished for that template.
const TERMINAL_TEMPLATE_STATUSES = new Set([
  "success",
  "partial_success",
  "failure",
]);

/**
 * True once every requested template has finished processing. The overall
 * session status can stay "processing" (FHIR docs, audio post-processing)
 * well after our template data is ready — no reason to keep waiting.
 */
function templatesReady(sessionData: GetSessionStatusResponse): boolean {
  const templates = sessionData.templates;
  if (!templates?.length) return false;
  return templates.every((entry) =>
    Object.values(entry).every(
      (templateData) =>
        templateData && TERMINAL_TEMPLATE_STATUSES.has(templateData.status),
    ),
  );
}

function warnIfTokenEnvMismatch(env: "PROD" | "DEV", token: string) {
  if (!token || env !== "DEV") return;
  try {
    const payload = token.split(".")[1];
    if (!payload) return;
    const data = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { iss?: string };
    // Prod-console tokens use emr.eka.care; they are rejected by api.dev.eka.care
    // with 403 and no CORS headers — the browser surfaces that as a CORS error.
    if (data.iss === "emr.eka.care") {
      console.warn(
        "[EkaScribe] PROD token detected with REACT_EKA_ENV=DEV. " +
          "The dev API will return Forbidden (often shown as CORS). " +
          "Use a token from console.dev.eka.care, or set REACT_EKA_ENV=PROD and rebuild.",
      );
    }
  } catch {
    // Ignore malformed tokens
  }
}

interface UseScribeOptions {
  accessToken?: string;
  formState?: unknown;
  onTokenRefresh?: () => Promise<string> | string;
  onStatusChange?: (status: ScribeStatus) => void;
  onTranscript?: (transcript: string) => void;
  onResult?: (result: ScribeResult) => void;
  onError?: (error: Error) => void;
}

interface UseScribeReturn {
  status: ScribeStatus;
  isStarting: boolean;
  isRecording: boolean;
  isPaused: boolean;
  duration: number;
  result: ScribeResult | null;
  error: string | null;
  startRecording: (options?: {
    encounterId?: string;
    templateIds?: string[];
    language?: string[];
  }) => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  reset: () => Promise<void>;
  updateAccessToken: (token: string) => void;
}

export function useScribe({
  accessToken,
  formState: formStateProp,
  onTokenRefresh,
  onStatusChange,
  onTranscript,
  onResult,
  onError,
}: UseScribeOptions = {}): UseScribeReturn {
  const [status, setStatus] = useState<ScribeStatus>("idle");
  const [isStarting, setIsStarting] = useState(false);
  const [duration, setDuration] = useState(0);
  const [result, setResult] = useState<ScribeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const instanceRef = useRef<ReturnType<typeof getEkaScribeInstance> | null>(
    null,
  );
  const sessionIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const accumulatedRef = useRef<number>(0); // ms accumulated before the current segment
  const workerUrlRef = useRef<string | null>(null);
  const initPromiseRef = useRef<Promise<
    ReturnType<typeof getEkaScribeInstance>
  > | null>(null);
  const callbacksRegisteredRef = useRef(false);

  // Custom backend (CARE plugin): authenticate with the CARE user's JWT —
  // same convention as care_scribe_fe. Eka cloud: use the Eka token.
  const defaultToken = USING_CUSTOM_BACKEND
    ? getCareAccessToken() || EKA_ACCESS_TOKEN
    : EKA_ACCESS_TOKEN;
  const tokenRef = useRef(accessToken || defaultToken);
  tokenRef.current = accessToken || defaultToken;

  const onTokenRefreshRef = useRef(onTokenRefresh);
  onTokenRefreshRef.current = onTokenRefresh;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const updateStatus = useCallback(
    (newStatus: ScribeStatus) => {
      setStatus(newStatus);
      onStatusChange?.(newStatus);
    },
    [onStatusChange],
  );

  const registerSdkCallbacks = useCallback(
    (ekascribe: ReturnType<typeof getEkaScribeInstance>) => {
      if (callbacksRegisteredRef.current) return;

      ekascribe.registerCallback("onTokenRequired", async () => {
        const refreshed = await onTokenRefreshRef.current?.();
        if (refreshed) {
          tokenRef.current = refreshed;
          return refreshed;
        }
        return tokenRef.current;
      });

      ekascribe.registerCallback("onError", (event) => {
        const message = event.error.message || "EkaScribe error";
        setError(message);
        onErrorRef.current?.(new Error(message));
      });

      ekascribe.registerCallback("onUploadEvent", (event) => {
        if (EKA_ENV === "DEV" && event.type === "progress") {
          console.log(
            `[EkaScribe] Upload ${event.data.successCount}/${event.data.totalCount}`,
          );
        }
      });

      ekascribe.registerCallback("onRecordingStateChange", (event) => {
        if (EKA_ENV === "DEV") {
          console.log("[EkaScribe] Recording state:", event.type);
        }
      });

      callbacksRegisteredRef.current = true;
    },
    [],
  );

  const ensureInstance = useCallback(async () => {
    if (instanceRef.current) {
      registerSdkCallbacks(instanceRef.current);
      return instanceRef.current;
    }

    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }

    initPromiseRef.current = (async () => {
      const sharedWorkerUrl = await createWorkerBlobUrl();
      workerUrlRef.current = sharedWorkerUrl;

      const config: EkaScribeConfig = {
        access_token: tokenRef.current,
        env: EKA_ENV,
        sharedWorkerUrl,
        allianceConfig: {
          baseUrl: EKA_BASE_URL,
          useWorker: "auto",
          debug: EKA_ENV === "DEV",
        },
      };

      const ekascribe = getEkaScribeInstance(config);
      registerSdkCallbacks(ekascribe);
      instanceRef.current = ekascribe;

      if (EKA_ENV === "DEV") {
        warnIfTokenEnvMismatch(EKA_ENV, tokenRef.current);
        console.info(
          "[EkaScribe] Plugin loaded in care_fe — API CORS uses the host page origin, not the plugin remote URL.",
          {
            pageOrigin: window.location.origin,
            apiBaseUrl: EKA_BASE_URL,
            hasToken: Boolean(tokenRef.current),
          },
        );
      }

      return ekascribe;
    })();

    try {
      return await initPromiseRef.current;
    } finally {
      initPromiseRef.current = null;
    }
  }, [registerSdkCallbacks]);

  useEffect(() => {
    if (instanceRef.current && tokenRef.current) {
      instanceRef.current.updateAuthTokens({ access_token: tokenRef.current });
    }
  }, [accessToken]);

  // Pre-warm the SDK (worker + discovery) and — when using Eka — the
  // questionnaire template while the form is idle, so startRecording
  // doesn't pay init/template creation latency on first click.
  const prewarmedRef = useRef(false);
  useEffect(() => {
    if (prewarmedRef.current || !formStateProp || !tokenRef.current) return;
    if (extractFormFields(formStateProp).length === 0) return;
    prewarmedRef.current = true;
    void (async () => {
      try {
        const ekascribe = await ensureInstance();
        // Custom backend needs no pre-created template — the form schema is
        // sent with each session instead.
        if (!USING_CUSTOM_BACKEND) {
          await getOrCreateTemplate(formStateProp, ekascribe);
        }
      } catch {
        // Non-fatal — startRecording will retry.
        prewarmedRef.current = false;
      }
    })();
  }, [formStateProp, ensureInstance]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      void instanceRef.current?.resetInstance();
      if (workerUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(workerUrlRef.current);
        workerUrlRef.current = null;
      }
    };
  }, []);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setDuration(
        Math.floor(
          (accumulatedRef.current + Date.now() - startTimeRef.current) / 1000,
        ),
      );
    }, 1000);
  }, []);

  const stopTimer = useCallback((save = false) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (save) {
      // Preserve elapsed time so resume continues from here
      accumulatedRef.current += Date.now() - startTimeRef.current;
    }
  }, []);

  const startRecording = useCallback(
    async (options?: {
      encounterId?: string;
      templateIds?: string[];
      language?: string[];
    }) => {
      setIsStarting(true);
      try {
        setError(null);
        setResult(null);

        const ekascribe = await ensureInstance();

        let templateIds: string[];
        let additionalData: Record<string, unknown> | undefined =
          options?.encounterId
            ? { encounter_id: options.encounterId }
            : undefined;

        if (USING_CUSTOM_BACKEND) {
          // Send the form schema with the session — our backend runs the
          // extraction directly, no pre-registered template needed.
          templateIds = options?.templateIds || ["care_form"];
          const fields = formStateProp ? extractFormFields(formStateProp) : [];
          if (fields.length > 0) {
            const { desc, example } = buildTemplateDescription(fields);
            additionalData = {
              ...additionalData,
              care_template: { desc, example },
            };
          }
        } else {
          const templateId = formStateProp
            ? await getOrCreateTemplate(formStateProp, ekascribe)
            : "clinical_notes_template";
          templateIds = options?.templateIds || [templateId];
        }

        const language = options?.language || SCRIBE_LANGUAGES;

        const recordResult = await ekascribe.startRecordingV2({
          templates: templateIds,
          uploadType: "chunked",
          sessionMode: "consultation",
          languageHint: language,
          model: "pro",
          additionalData,
        });

        if (recordResult.error_code) {
          throw new Error(recordResult.message || "Failed to start recording");
        }

        sessionIdRef.current = recordResult.txn_id || null;
        updateStatus("recording");
        startTimer();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to start recording";
        setError(message);
        updateStatus("failed");
        onError?.(err instanceof Error ? err : new Error(message));
      } finally {
        setIsStarting(false);
      }
    },
    [ensureInstance, formStateProp, updateStatus, startTimer, onError],
  );

  const pauseRecording = useCallback(() => {
    const ekascribe = instanceRef.current;
    if (ekascribe) {
      ekascribe.pauseRecording();
      stopTimer(true); // save accumulated time before pausing
      updateStatus("paused");
    }
  }, [stopTimer, updateStatus]);

  const resumeRecording = useCallback(() => {
    const ekascribe = instanceRef.current;
    if (ekascribe) {
      ekascribe.resumeRecording();
      startTimer();
      updateStatus("recording");
    }
  }, [startTimer, updateStatus]);

  const stopRecording = useCallback(async () => {
    try {
      const ekascribe = instanceRef.current;
      if (!ekascribe) return;

      stopTimer();
      updateStatus("processing");

      const tStop = performance.now();

      let endResult = await ekascribe.endRecording();
      if (endResult.error_code === "audio_upload_failed") {
        const retryResult = await ekascribe.retryUploadRecording();
        if (retryResult.error_code) {
          throw new Error(
            retryResult.message || "Failed to upload recording audio",
          );
        }
        endResult = retryResult;
      } else if (endResult.error_code) {
        throw new Error(endResult.message || "Failed to end recording");
      }

      const tUploaded = performance.now();

      const sessionId = sessionIdRef.current;
      if (!sessionId) throw new Error("No session ID");

      let transcriptEmitted = false;
      let tTranscript = 0;

      // Stop polling as soon as our template data is terminal, instead of
      // waiting for the whole session to flip to "completed".
      const pollAbort = new AbortController();
      let earlySessionData: GetSessionStatusResponse | null = null;

      const statusResult = await ekascribe.getSessionStatus(sessionId, {
        poll: {
          maxAttempts: SESSION_POLL_MAX_ATTEMPTS,
          intervalMs: SESSION_POLL_INTERVAL_MS,
          signal: pollAbort.signal,
          onProgress: (sessionData) => {
            if (!transcriptEmitted && sessionData.transcript) {
              transcriptEmitted = true;
              tTranscript = performance.now();
              setResult({ transcript: sessionData.transcript });
              onTranscript?.(sessionData.transcript);
            }
            if (
              !earlySessionData &&
              sessionData.transcript &&
              templatesReady(sessionData)
            ) {
              earlySessionData = sessionData;
              pollAbort.abort();
            }
          },
        },
      });

      const sessionData =
        (earlySessionData as GetSessionStatusResponse | null) ??
        (statusResult.success ? statusResult.data : null);
      if (!sessionData) {
        throw new Error(statusResult.error?.message || "Failed to get results");
      }

      const transcript = sessionData.transcript || "";
      const templates = sessionData.templates || [];
      const structuredData = extractStructuredData(templates);

      const tDone = performance.now();
      const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      console.info(
        `[EkaScribe] timing — upload flush: ${secs(tUploaded - tStop)}, ` +
          `transcript: +${tTranscript ? secs(tTranscript - tUploaded) : "n/a"}, ` +
          `templates: +${secs(tDone - (tTranscript || tUploaded))}, ` +
          `total: ${secs(tDone - tStop)}` +
          (earlySessionData ? " (early-exit before session completed)" : ""),
      );

      if (EKA_ENV === "DEV") {
        console.log("[EkaScribe] Result:", {
          transcript,
          templates,
          structuredData,
        });
      }

      if (transcript && !transcriptEmitted) {
        setResult({ transcript });
        onTranscript?.(transcript);
      }

      const scribeResult: ScribeResult = {
        transcript: transcript || undefined,
        templates: templates.length > 0 ? templates : undefined,
        structuredData:
          Object.keys(structuredData).length > 0 ? structuredData : undefined,
      };

      setResult(scribeResult);
      updateStatus("completed");
      onResult?.(scribeResult);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to process recording";
      setError(message);
      updateStatus("failed");
      onError?.(err instanceof Error ? err : new Error(message));
    }
  }, [stopTimer, updateStatus, onTranscript, onResult, onError]);

  const cancelRecording = useCallback(async () => {
    try {
      const ekascribe = instanceRef.current;
      if (ekascribe) await ekascribe.cancelSession();
      stopTimer();
      accumulatedRef.current = 0;
      setDuration(0);
      updateStatus("idle");
    } catch {
      stopTimer();
      accumulatedRef.current = 0;
      updateStatus("idle");
    }
  }, [stopTimer, updateStatus]);

  const reset = useCallback(async () => {
    try {
      const ekascribe = instanceRef.current;
      if (ekascribe) await ekascribe.resetInstance();
      instanceRef.current = null;
      sessionIdRef.current = null;
      callbacksRegisteredRef.current = false;
      if (workerUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(workerUrlRef.current);
        workerUrlRef.current = null;
      }
      stopTimer();
      accumulatedRef.current = 0;
      setDuration(0);
      setResult(null);
      setError(null);
      updateStatus("idle");
    } catch {
      updateStatus("idle");
    }
  }, [stopTimer, updateStatus]);

  const updateAccessToken = useCallback((newToken: string) => {
    tokenRef.current = newToken;
    const ekascribe = instanceRef.current;
    if (ekascribe) {
      ekascribe.updateAuthTokens({ access_token: newToken });
    }
  }, []);

  return {
    status,
    isStarting,
    isRecording: status === "recording",
    isPaused: status === "paused",
    duration,
    result,
    error,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
    reset,
    updateAccessToken,
  };
}

/**
 * Extract structured data from EkaScribe template results.
 * Our dynamic templates return JSON with keys matching form field labels.
 */
function extractStructuredData(templates: unknown[]): Record<string, unknown> {
  const structuredData: Record<string, unknown> = {};

  for (const tmpl of templates) {
    const entry = tmpl as Record<string, Record<string, unknown>>;

    for (const [_templateId, templateData] of Object.entries(entry)) {
      if (!templateData || typeof templateData !== "object") continue;
      if (templateData.status !== "success") continue;

      let data = templateData.data;

      if (typeof data === "string") {
        try {
          const jsonMatch = data.match(/\{[\s\S]*\}/);
          if (jsonMatch) data = JSON.parse(jsonMatch[0]);
          else {
            structuredData["clinical_notes"] = data;
            continue;
          }
        } catch {
          structuredData["clinical_notes"] = String(data);
          continue;
        }
      }

      if (typeof data === "object" && data !== null) {
        const obj = data as Record<string, unknown>;

        if (obj.prescription) {
          extractEmrVitals(obj, structuredData);
        }

        for (const [key, value] of Object.entries(obj)) {
          if (key === "prescription") continue;
          mergeExtractedField(structuredData, key, value);
        }
      }
    }
  }

  return structuredData;
}

function mergeExtractedField(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null || value === "") return;

  if (typeof value === "object" && !Array.isArray(value) && "value" in value) {
    const wrapped = value as { value: unknown; note?: unknown };
    mergeExtractedField(out, key, wrapped.value);
    if (wrapped.note != null && wrapped.note !== "") {
      out[`${key}_note`] = String(wrapped.note);
    }
    return;
  }

  out[key] = value;
}

function extractEmrVitals(
  emrData: Record<string, unknown>,
  out: Record<string, unknown>,
) {
  const prescription = emrData?.prescription as
    | Record<string, unknown>
    | undefined;
  const medHistory = prescription?.medicalHistory as
    | Record<string, unknown>
    | undefined;
  const vitalsList = (medHistory?.vitals || []) as Array<{
    name: string;
    dis_name?: string;
    value: { qt: string; unit: string };
  }>;

  for (const vital of vitalsList) {
    const key = vital.dis_name || vital.name;
    out[key] = vital.value.qt;
  }
}
