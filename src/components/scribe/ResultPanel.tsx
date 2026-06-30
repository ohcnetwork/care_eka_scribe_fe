import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  X,
} from "lucide-react";
import { useState } from "react";

import type { ScribeResult } from "@/lib/types/scribe";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

import { useTranslation } from "@/hooks/useTranslation";

interface ResultPanelProps {
  result: ScribeResult;
  formFields?: Array<{
    id: string;
    label: string;
    type: string;
  }>;
  onApplyField?: (fieldId: string, value: string) => void;
  onApplyAll?: (data: Record<string, string>) => void;
  onDismiss: () => void;
}

export function ResultPanel({
  result,
  formFields,
  onApplyField,
  onApplyAll,
  onDismiss,
}: ResultPanelProps) {
  const { t } = useTranslation();
  const hasTranscript = !!result.transcript;
  const hasNotes =
    !!result.structuredData && Object.keys(result.structuredData).length > 0;

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(hasNotes ? ["notes", "transcript"] : ["transcript"]),
  );
  const [appliedFields, setAppliedFields] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const handleApplyField = (fieldId: string, value: string) => {
    onApplyField?.(fieldId, value);
    setAppliedFields((prev) => new Set(prev).add(fieldId));
  };

  const handleApplyAll = () => {
    if (!result.structuredData) return;
    onApplyAll?.(result.structuredData);
  };

  const handleCopyTranscript = async () => {
    if (result.transcript) {
      await navigator.clipboard.writeText(result.transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Use structuredData for display
  const notesContent = result.structuredData as
    | Record<string, unknown>
    | undefined;

  return (
    <div className="flex max-h-[70vh] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span className="text-sm font-medium text-gray-700">
            {hasTranscript || hasNotes
              ? t("notes_ready")
              : t("processing_complete")}
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Structured Notes */}
        {notesContent && Object.keys(notesContent).length > 0 && (
          <div className="border-b border-gray-100">
            <button
              onClick={() => toggleSection("notes")}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
            >
              <span className="text-sm font-medium text-gray-900">
                {t("clinical_notes")}
              </span>
              {expandedSections.has("notes") ? (
                <ChevronUp className="h-4 w-4 text-gray-400" />
              ) : (
                <ChevronDown className="h-4 w-4 text-gray-400" />
              )}
            </button>
            {expandedSections.has("notes") && (
              <div className="space-y-3 px-4 pb-4">
                {Object.entries(notesContent).map(([key, value]) => {
                  const strValue =
                    typeof value === "string"
                      ? value
                      : JSON.stringify(value, null, 2);
                  if (!strValue) return null;
                  const isApplied = appliedFields.has(key);
                  return (
                    <div
                      key={key}
                      className={cn(
                        "rounded-lg border p-3",
                        isApplied
                          ? "border-green-200 bg-green-50"
                          : "border-gray-100 bg-gray-50",
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-500 uppercase">
                          {key.replace(/_/g, " ")}
                        </span>
                        {onApplyField && (
                          <button
                            onClick={() => handleApplyField(key, strValue)}
                            className={cn(
                              "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                              isApplied
                                ? "bg-green-100 text-green-700"
                                : "bg-primary-50 text-primary-700 hover:bg-primary-100",
                            )}
                          >
                            {isApplied ? (
                              <span className="flex items-center gap-1">
                                <Check className="h-3 w-3" /> {t("applied")}
                              </span>
                            ) : (
                              t("apply")
                            )}
                          </button>
                        )}
                      </div>
                      <p className="text-sm whitespace-pre-wrap text-gray-700">
                        {strValue}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Transcript */}
        {result.transcript && (
          <div className="border-b border-gray-100">
            <button
              onClick={() => toggleSection("transcript")}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
            >
              <span className="text-sm font-medium text-gray-900">
                {t("transcript")}
              </span>
              {expandedSections.has("transcript") ? (
                <ChevronUp className="h-4 w-4 text-gray-400" />
              ) : (
                <ChevronDown className="h-4 w-4 text-gray-400" />
              )}
            </button>
            {expandedSections.has("transcript") && (
              <div className="px-4 pb-4">
                <div className="relative rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <button
                    onClick={handleCopyTranscript}
                    className="absolute top-2 right-2 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                    title={t("copy_transcript")}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <p className="pr-8 text-sm whitespace-pre-wrap text-gray-700">
                    {result.transcript}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Form Field Mapping */}
        {formFields && formFields.length > 0 && result.structuredData && (
          <div>
            <button
              onClick={() => toggleSection("fields")}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
            >
              <span className="text-sm font-medium text-gray-900">
                {t("form_fields")}
              </span>
              {expandedSections.has("fields") ? (
                <ChevronUp className="h-4 w-4 text-gray-400" />
              ) : (
                <ChevronDown className="h-4 w-4 text-gray-400" />
              )}
            </button>
            {expandedSections.has("fields") && (
              <div className="space-y-2 px-4 pb-4">
                {formFields.map((field) => {
                  const value = result.structuredData?.[field.id];
                  if (!value) return null;
                  const isApplied = appliedFields.has(field.id);
                  return (
                    <div
                      key={field.id}
                      className={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2",
                        isApplied
                          ? "border-green-200 bg-green-50"
                          : "border-gray-100",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium text-gray-500">
                          {field.label}
                        </span>
                        <p className="truncate text-sm text-gray-900">
                          {value}
                        </p>
                      </div>
                      <button
                        onClick={() => handleApplyField(field.id, value)}
                        className={cn(
                          "ml-2 shrink-0 rounded px-2 py-1 text-xs font-medium",
                          isApplied
                            ? "bg-green-100 text-green-700"
                            : "bg-primary-50 text-primary-700 hover:bg-primary-100",
                        )}
                      >
                        {isApplied ? "✓" : t("apply")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t("dismiss")}
        </Button>
        {onApplyAll && result.structuredData && (
          <Button variant="primary" size="sm" onClick={handleApplyAll}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" />
            {t("apply_all")}
          </Button>
        )}
      </div>
    </div>
  );
}
