import {
  AlertCircle,
  Loader2,
  Mic,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";

import type { ScribeStatus } from "@/lib/types/scribe";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

interface RecordingPanelProps {
  status: ScribeStatus;
  duration: number;
  error: string | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function RecordingPanel({
  status,
  duration,
  error,
  onPause,
  onResume,
  onStop,
  onCancel,
  onDismiss,
}: RecordingPanelProps) {
  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "h-2 w-2 rounded-full",
              status === "recording" && "animate-pulse bg-red-500",
              status === "paused" && "bg-amber-500",
              status === "processing" && "animate-pulse bg-blue-500",
              status === "failed" && "bg-red-500",
            )}
          />
          <span className="text-sm font-medium text-gray-700">
            {status === "recording" && "Recording"}
            {status === "paused" && "Paused"}
            {status === "processing" && "Processing..."}
            {status === "failed" && "Failed"}
          </span>
        </div>
        <button
          onClick={status === "processing" ? undefined : onDismiss}
          className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          disabled={status === "processing"}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-col items-center gap-4 px-6 py-8">
        {(status === "recording" || status === "paused") && (
          <>
            <div
              className={cn(
                "flex h-20 w-20 items-center justify-center rounded-full",
                status === "recording"
                  ? "bg-red-50 ring-4 ring-red-100"
                  : "bg-amber-50 ring-4 ring-amber-100",
              )}
            >
              <Mic
                className={cn(
                  "h-8 w-8",
                  status === "recording" ? "text-red-500" : "text-amber-500",
                )}
              />
            </div>
            <span className="font-mono text-2xl font-semibold text-gray-900">
              {formatDuration(duration)}
            </span>
            <p className="text-center text-sm text-gray-500">
              {status === "recording"
                ? "Listening to consultation..."
                : "Recording paused"}
            </p>
          </>
        )}

        {status === "processing" && (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-blue-50 ring-4 ring-blue-100">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
            <span className="text-sm font-medium text-gray-700">
              Generating medical notes...
            </span>
          </>
        )}

        {status === "failed" && error && (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-50 ring-4 ring-red-100">
              <AlertCircle className="h-8 w-8 text-red-500" />
            </div>
            <p className="text-center text-sm text-red-600">{error}</p>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-3 border-t border-gray-100 px-4 py-3">
        {status === "recording" && (
          <>
            <Button variant="outline" size="sm" onClick={onPause}>
              <Pause className="mr-1 h-3.5 w-3.5" />
              Pause
            </Button>
            <Button variant="destructive" size="sm" onClick={onStop}>
              <Square className="mr-1 h-3.5 w-3.5" />
              Stop & Process
            </Button>
          </>
        )}

        {status === "paused" && (
          <>
            <Button variant="primary" size="sm" onClick={onResume}>
              <Play className="mr-1 h-3.5 w-3.5" />
              Resume
            </Button>
            <Button variant="destructive" size="sm" onClick={onStop}>
              <Square className="mr-1 h-3.5 w-3.5" />
              Stop & Process
            </Button>
          </>
        )}

        {status === "processing" && (
          <Button variant="outline" size="sm" onClick={onCancel} disabled>
            Processing...
          </Button>
        )}

        {status === "failed" && (
          <Button variant="outline" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
