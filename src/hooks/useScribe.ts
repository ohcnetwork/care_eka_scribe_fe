import {
  type EkaScribeConfig,
  createWorkerBlobUrl,
  getEkaScribeInstance,
} from "@eka-care/ekascribe-ts-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { getOrCreateTemplate } from "@/lib/template-builder";
import type { ScribeResult, ScribeStatus } from "@/lib/types/scribe";

const EKA_ENV = (import.meta.env.REACT_EKA_ENV || "DEV") as "PROD" | "DEV";
const EKA_ACCESS_TOKEN = import.meta.env.REACT_EKA_ACCESS_TOKEN || "";
const EKA_BASE_URL =
  EKA_ENV === "DEV"
    ? "https://api.dev.eka.care/voice/v1"
    : "https://api.eka.care/voice/v1";
const SESSION_POLL_INTERVAL_MS = 2000;
const SESSION_POLL_MAX_ATTEMPTS = 60;

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
  const workerUrlRef = useRef<string | null>(null);
  const initPromiseRef = useRef<Promise<
    ReturnType<typeof getEkaScribeInstance>
  > | null>(null);
  const callbacksRegisteredRef = useRef(false);

  const tokenRef = useRef(accessToken || EKA_ACCESS_TOKEN);
  tokenRef.current = accessToken || EKA_ACCESS_TOKEN;

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
      setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
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

        const templateId = formStateProp
          ? await getOrCreateTemplate(formStateProp, ekascribe)
          : "clinical_notes_template";
        const templateIds = options?.templateIds || [templateId];
        const language = options?.language || ["auto_detect"];

        const recordResult = await ekascribe.startRecordingV2({
          templates: templateIds,
          uploadType: "chunked",
          sessionMode: "consultation",
          languageHint: language,
          model: "pro",
          additionalData: options?.encounterId
            ? { encounter_id: options.encounterId }
            : undefined,
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
      stopTimer();
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

      const sessionId = sessionIdRef.current;
      if (!sessionId) throw new Error("No session ID");

      let transcriptEmitted = false;

      const statusResult = await ekascribe.getSessionStatus(sessionId, {
        poll: {
          maxAttempts: SESSION_POLL_MAX_ATTEMPTS,
          intervalMs: SESSION_POLL_INTERVAL_MS,
          onProgress: (sessionData) => {
            if (!transcriptEmitted && sessionData.transcript) {
              transcriptEmitted = true;
              setResult({ transcript: sessionData.transcript });
              onTranscript?.(sessionData.transcript);
            }
          },
        },
      });

      if (!statusResult.success) {
        throw new Error(statusResult.error?.message || "Failed to get results");
      }

      const sessionData = statusResult.data;
      const transcript = sessionData.transcript || "";
      const templates = sessionData.templates || [];
      const structuredData = extractStructuredData(templates);

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

      await new Promise((r) => setTimeout(r, 1500));

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
      setDuration(0);
      updateStatus("idle");
    } catch {
      stopTimer();
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
