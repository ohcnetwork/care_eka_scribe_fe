export const SERVICE_REQUEST_STATUSES = [
  "draft",
  "active",
  "on_hold",
  "entered_in_error",
  "ended",
  "completed",
  "revoked",
  "unknown",
] as const;

export const SERVICE_REQUEST_INTENTS = [
  "order",
  "proposal",
  "plan",
  "directive",
] as const;

export const SERVICE_REQUEST_PRIORITIES = [
  "routine",
  "urgent",
  "asap",
  "stat",
] as const;

export const SERVICE_REQUEST_CLASSIFICATIONS = [
  "laboratory",
  "imaging",
  "surgical_procedure",
  "counselling",
  "education",
] as const;

export function validateEnum<T extends readonly string[]>(
  value: string | null | undefined,
  allowed: T,
  fallback?: T[number],
): T[number] | undefined {
  if (!value) return fallback;
  return allowed.includes(value as T[number]) ? (value as T[number]) : fallback;
}
