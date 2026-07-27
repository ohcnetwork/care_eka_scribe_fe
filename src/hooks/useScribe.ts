import {
  type GetSessionStatusResponse,
  ScribeClient,
  type ScribeSDKConfig,
} from "med-scribe-alliance-ts-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createShimmedWorkerBlobUrl,
  installFetchCredentialsShim,
} from "@/lib/scribe-fetch-shim";
import {
  buildTemplateDescription,
  extractFormFields,
} from "@/lib/template-builder";
import type { ScribeResult, ScribeStatus } from "@/lib/types/scribe";

const DEBUG = import.meta.env.DEV;

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
const SCRIBE_BE_OVERRIDE = (import.meta.env.REACT_SCRIBE_BE_URL || "").replace(
  /\/$/,
  "",
);

function resolveScribeBackend(): string | null {
  if (SCRIBE_BE_OVERRIDE) {
    return `${SCRIBE_BE_OVERRIDE}/v1`;
  }
  const careApiUrl =
    typeof window !== "undefined" ? window.CARE_API_URL : undefined;
  if (careApiUrl) {
    const base = careApiUrl.replace(/\/$/, "");
    return `${base}/api/care_scribe_be/v1`;
  }
  return null;
}

const SCRIBE_BASE_URL = resolveScribeBackend();

// The SDK sends `credentials: "include"` on every request, but the CARE API
// does not respond with `Access-Control-Allow-Credentials: true` — browsers
// then block the request entirely ("Failed to fetch discovery document" in
// production). Auth is a Bearer JWT, so credentials are never needed.
// The worker gets its own shim via createShimmedWorkerBlobUrl.
if (SCRIBE_BASE_URL) {
  try {
    installFetchCredentialsShim(new URL(SCRIBE_BASE_URL).origin);
  } catch {
    // Relative/invalid base URL — same-origin anyway, no shim needed.
  }
}

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

  const instanceRef = useRef<ScribeClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const accumulatedRef = useRef<number>(0); // ms accumulated before the current segment
  const workerUrlRef = useRef<string | null>(null);
  const initPromiseRef = useRef<Promise<ScribeClient> | null>(null);
  const callbacksRegisteredRef = useRef(false);

  // Authenticate with the CARE user's JWT — same convention as care_scribe_fe.
  const defaultToken = getCareAccessToken();
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

  const registerSdkCallbacks = useCallback((client: ScribeClient) => {
    if (callbacksRegisteredRef.current) return;

    client.registerCallback("onTokenRequired", (event) => {
      void (async () => {
        const refreshed = await onTokenRefreshRef.current?.();
        if (refreshed) {
          tokenRef.current = refreshed;
        }
        event.resolve(tokenRef.current);
      })();
    });

    client.registerCallback("onError", (event) => {
      const message = event.error.message || "Scribe error";
      setError(message);
      onErrorRef.current?.(new Error(message));
    });

    client.registerCallback("onUploadEvent", (event) => {
      if (DEBUG && event.type === "progress") {
        console.log(
          `[Scribe] Upload ${event.data.successCount}/${event.data.totalCount}`,
        );
      }
    });

    client.registerCallback("onRecordingStateChange", (event) => {
      if (DEBUG) {
        console.log("[Scribe] Recording state:", event.type);
      }
    });

    callbacksRegisteredRef.current = true;
  }, []);

  const ensureInstance = useCallback(async () => {
    if (instanceRef.current) {
      registerSdkCallbacks(instanceRef.current);
      return instanceRef.current;
    }

    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }

    initPromiseRef.current = (async () => {
      if (!SCRIBE_BASE_URL) {
        throw new Error(
          "No scribe backend configured — set REACT_SCRIBE_BE_URL or run inside CARE (window.CARE_API_URL).",
        );
      }

      // Shim the worker's fetch so chunk uploads don't send credentials
      // (same CORS failure mode as discovery).
      const workerScriptUrl = await createShimmedWorkerBlobUrl();
      workerUrlRef.current = workerScriptUrl;

      const config: ScribeSDKConfig = {
        baseUrl: SCRIBE_BASE_URL,
        accessToken: tokenRef.current,
        workerScriptUrl,
        useWorker: "auto",
        debug: DEBUG,
      };

      const client = new ScribeClient(config);
      registerSdkCallbacks(client);
      instanceRef.current = client;

      if (DEBUG) {
        console.info(
          "[Scribe] Plugin loaded in care_fe — API CORS uses the host page origin, not the plugin remote URL.",
          {
            pageOrigin: window.location.origin,
            apiBaseUrl: SCRIBE_BASE_URL,
            hasToken: Boolean(tokenRef.current),
          },
        );
      }

      return client;
    })();

    try {
      return await initPromiseRef.current;
    } finally {
      initPromiseRef.current = null;
    }
  }, [registerSdkCallbacks]);

  useEffect(() => {
    if (instanceRef.current && tokenRef.current) {
      instanceRef.current.setAccessToken(tokenRef.current);
    }
  }, [accessToken]);

  // Pre-warm the SDK (worker + discovery) while the form is idle, so
  // startRecording doesn't pay init latency on first click.
  const prewarmedRef = useRef(false);
  useEffect(() => {
    if (prewarmedRef.current || !formStateProp || !tokenRef.current) return;
    if (extractFormFields(formStateProp).length === 0) return;
    prewarmedRef.current = true;
    void (async () => {
      try {
        await ensureInstance();
      } catch {
        // Non-fatal — startRecording will retry.
        prewarmedRef.current = false;
      }
    })();
  }, [formStateProp, ensureInstance]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      void instanceRef.current?.reset();
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

        const client = await ensureInstance();

        // Send the form schema with the session — the backend runs the
        // extraction directly, no pre-registered template needed.
        const templateIds = options?.templateIds || ["care_form"];
        let additionalData: Record<string, unknown> | undefined =
          options?.encounterId
            ? { encounter_id: options.encounterId }
            : undefined;
        const fields = formStateProp ? extractFormFields(formStateProp) : [];
        if (fields.length > 0) {
          const { desc, example } = buildTemplateDescription(fields);
          additionalData = {
            ...additionalData,
            care_template: { desc, example },
          };
        }

        const language = options?.language || SCRIBE_LANGUAGES;

        const recordResult = await client.startRecording({
          templates: templateIds,
          uploadType: "chunked",
          sessionMode: "consultation",
          languageHint: language,
          model: "pro",
          additionalData,
        });

        if (!recordResult.success) {
          throw new Error(
            recordResult.error.message || "Failed to start recording",
          );
        }

        sessionIdRef.current = recordResult.data.session_id || null;
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
    const client = instanceRef.current;
    if (client) {
      client.pauseRecording();
      stopTimer(true); // save accumulated time before pausing
      updateStatus("paused");
    }
  }, [stopTimer, updateStatus]);

  const resumeRecording = useCallback(() => {
    const client = instanceRef.current;
    if (client) {
      client.resumeRecording();
      startTimer();
      updateStatus("recording");
    }
  }, [startTimer, updateStatus]);

  const stopRecording = useCallback(async () => {
    try {
      const client = instanceRef.current;
      if (!client) return;

      stopTimer();
      updateStatus("processing");

      const tStop = performance.now();

      const endResult = await client.endRecording();
      if (!endResult.success) {
        throw new Error(endResult.error.message || "Failed to end recording");
      }
      if (!endResult.data.sessionEnded) {
        // Some chunks failed to upload — retry once, then finalize.
        const retryResult = await client.retryFailedUploads();
        if (!retryResult.success || retryResult.data.stillFailed.length > 0) {
          throw new Error("Failed to upload recording audio");
        }
        const total = endResult.data.totalFiles;
        const endSessionResult = await client.endSession({
          audio_files_sent: total,
          audio_files_uploaded: total,
        });
        if (!endSessionResult.success) {
          throw new Error(
            endSessionResult.error.message || "Failed to end recording",
          );
        }
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

      const statusResult = await client.getSessionStatus(sessionId, {
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
        throw new Error(
          (!statusResult.success && statusResult.error.message) ||
            "Failed to get results",
        );
      }

      const transcript = sessionData.transcript || "";
      const templates = sessionData.templates || [];
      const structuredData = extractStructuredData(templates);

      const tDone = performance.now();
      const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      console.info(
        `[Scribe] timing — upload flush: ${secs(tUploaded - tStop)}, ` +
          `transcript: +${tTranscript ? secs(tTranscript - tUploaded) : "n/a"}, ` +
          `templates: +${secs(tDone - (tTranscript || tUploaded))}, ` +
          `total: ${secs(tDone - tStop)}` +
          (earlySessionData ? " (early-exit before session completed)" : ""),
      );

      if (DEBUG) {
        console.log("[Scribe] Result:", {
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
      const client = instanceRef.current;
      if (client) await client.cancelSession();
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
      const client = instanceRef.current;
      if (client) await client.reset();
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
    const client = instanceRef.current;
    if (client) {
      client.setAccessToken(newToken);
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
 * Extract structured data from scribe template results.
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
