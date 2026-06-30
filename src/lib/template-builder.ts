import { getEkaScribeInstance } from "@eka-care/ekascribe-ts-sdk";

import {
  getStructuredFieldDescription,
  getStructuredFieldExample,
} from "@/lib/structured/fill";
import {
  type SupportedStructuredType,
  isSupportedStructuredType,
} from "@/lib/structured/types";

interface FormQuestion {
  id: string;
  text: string;
  type: string;
  structured_type?: string;
  questions?: FormQuestion[];
  answer_option?: Array<{ value: string; display?: string }>;
  max_length?: number;
}

interface FormField {
  id: string;
  label: string;
  type: string;
  structuredType?: SupportedStructuredType;
  options?: string[];
}

/**
 * Extract all fillable fields from a CARE questionnaire,
 * flattening nested groups.
 */
export function extractFormFields(formState: unknown): FormField[] {
  if (!Array.isArray(formState)) return [];

  const fields: FormField[] = [];

  for (const group of formState) {
    const questionnaire = (group as Record<string, unknown>)?.questionnaire as
      | Record<string, unknown>
      | undefined;
    const questions = questionnaire?.questions;
    if (!Array.isArray(questions)) continue;

    collectFields(questions as FormQuestion[], fields);
  }

  return fields;
}

function collectFields(questions: FormQuestion[], out: FormField[]) {
  for (const q of questions) {
    // Skip groups — recurse into their children
    if (q.type === "group") {
      if (q.questions) collectFields(q.questions, out);
      continue;
    }

    if (
      q.type === "structured" &&
      isSupportedStructuredType(q.structured_type)
    ) {
      out.push({
        id: q.id,
        label: q.text,
        type: q.type,
        structuredType: q.structured_type,
      });
      continue;
    }

    if ((q as Record<string, unknown>).structured_type) {
      continue;
    }

    // Skip date fields — EkaScribe doesn't reliably produce valid dates
    if (q.type === "date" || q.type === "dateTime") {
      continue;
    }

    const field: FormField = {
      id: q.id,
      label: q.text,
      type: q.type,
    };

    if (q.answer_option?.length) {
      field.options = q.answer_option.map((o) => o.display || String(o.value));
    }

    out.push(field);
  }
}

/**
 * Build a template description that instructs EkaScribe to return JSON
 * with keys matching our form fields.
 */
export function buildTemplateDescription(fields: FormField[]): {
  title: string;
  desc: string;
  example: string;
} {
  const fieldDescriptions = fields.map((f) => {
    if (f.structuredType) {
      return getStructuredFieldDescription(f.structuredType, f.label);
    }

    let desc = `"${f.label}"`;
    if (f.type === "decimal" || f.type === "integer") {
      desc += " (numeric value only, no units)";
    } else if (f.type === "boolean") {
      desc += " (true or false)";
    } else if (f.type === "choice" && f.options?.length) {
      desc += ` (one of: ${f.options.join(", ")})`;
    } else if (f.type === "text" || f.type === "string") {
      desc += " (text)";
    }
    return `${desc}; optional "${f.label}_note" for any commentary about this field`;
  });

  const exampleObj: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.structuredType) {
      exampleObj[f.label] = getStructuredFieldExample(f.structuredType);
      continue;
    }

    if (f.type === "decimal") exampleObj[f.label] = 90;
    else if (f.type === "integer") exampleObj[f.label] = 5;
    else if (f.type === "boolean") exampleObj[f.label] = true;
    else if (f.type === "choice" && f.options?.length)
      exampleObj[f.label] = f.options[0];
    else exampleObj[f.label] = "relevant text from consultation";
    exampleObj[`${f.label}_note`] =
      "commentary if mentioned (e.g. normal, elevated)";
  }

  return {
    title: "CARE Form Auto-Fill",
    desc: [
      "Extract medical data from the consultation as a JSON object.",
      "Only include fields explicitly mentioned in the conversation.",
      "NEVER fabricate or assume values not stated.",
      "Use exact key names as shown below.",
      "",
      "For each field, if the clinician adds commentary (e.g. 'heart rate is 99 which is normal'),",
      "put the measurement in the field key and the commentary in a separate key with '_note' suffix",
      '(e.g. "Heart Rate": 99, "Heart Rate_note": "normal").',
      "Only include _note keys when commentary was explicitly stated.",
      "",
      "For structured clinical fields (symptoms, diagnosis, allergies, medications, prescriptions),",
      "return a JSON array under the field label with SNOMED codes in snomed_info/medication/medicine objects.",
      "Use medication_request only for NEW prescriptions being ordered, not current medications.",
      "Only include entries explicitly mentioned in the conversation.",
      "",
      "Fields:",
      ...fieldDescriptions,
      "",
      "Output ONLY valid JSON, no markdown, no extra text.",
    ].join("\n"),
    example: JSON.stringify(exampleObj),
  };
}

const TEMPLATE_CACHE_KEY = "ekascribe_template_cache";
const TEMPLATE_CACHE_VERSION = 10;

interface CachedTemplate {
  slug: string;
  templateId: string;
  sectionId: string;
  fieldCount: number;
  createdAt: number;
  version: number;
}

function getCachedTemplate(slug: string): CachedTemplate | null {
  try {
    const cache = JSON.parse(localStorage.getItem(TEMPLATE_CACHE_KEY) || "{}");
    const entry = cache[slug] as CachedTemplate | undefined;
    if (!entry) return null;
    if (entry.version !== TEMPLATE_CACHE_VERSION) return null;
    // Cache for 7 days
    if (Date.now() - entry.createdAt > 7 * 24 * 60 * 60 * 1000) return null;
    return entry;
  } catch {
    return null;
  }
}

function setCachedTemplate(slug: string, entry: CachedTemplate) {
  try {
    const cache = JSON.parse(localStorage.getItem(TEMPLATE_CACHE_KEY) || "{}");
    cache[slug] = entry;
    localStorage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Get or create an EkaScribe template matching the current form.
 * Caches template IDs by questionnaire slug to avoid re-creating.
 */
export async function getOrCreateTemplate(
  formState: unknown,
  ekascribe: ReturnType<typeof getEkaScribeInstance>,
): Promise<string> {
  // Extract questionnaire slug for caching
  const slug = getQuestionnaireSlug(formState);
  const fields = extractFormFields(formState);

  if (!fields.length) {
    // Fallback to clinical notes template
    return "clinical_notes_template";
  }

  // Check cache
  const cached = getCachedTemplate(slug);
  if (cached && cached.fieldCount === fields.length) {
    console.log(
      `[EkaScribe] Using cached template for "${slug}": ${cached.templateId}`,
    );
    return cached.templateId;
  }

  // Build and create template
  console.log(
    `[EkaScribe] Creating template for "${slug}" with ${fields.length} fields`,
  );
  const { title, desc, example } = buildTemplateDescription(fields);

  try {
    // Create section
    const sectionResult = await ekascribe.documents.createTemplateSection({
      title: `CARE: ${slug}`,
      desc,
      format: "P",
      example,
    });

    if (!sectionResult.section_id) {
      console.warn("[EkaScribe] Failed to create section, using fallback");
      return "clinical_notes_template";
    }

    // Create template
    const templateResult = await ekascribe.documents.createTemplate({
      title: `${title} - ${slug}`,
      desc,
      section_ids: [sectionResult.section_id],
    });

    if (!templateResult.template_id) {
      console.warn("[EkaScribe] Failed to create template, using fallback");
      return "clinical_notes_template";
    }

    // Cache it
    setCachedTemplate(slug, {
      slug,
      templateId: templateResult.template_id,
      sectionId: sectionResult.section_id,
      fieldCount: fields.length,
      createdAt: Date.now(),
      version: TEMPLATE_CACHE_VERSION,
    });

    console.log(`[EkaScribe] Created template: ${templateResult.template_id}`);
    return templateResult.template_id;
  } catch (err) {
    console.warn("[EkaScribe] Template creation failed, using fallback:", err);
    return "clinical_notes_template";
  }
}

function getQuestionnaireSlug(formState: unknown): string {
  if (!Array.isArray(formState)) return "unknown";
  const first = formState[0] as Record<string, unknown> | undefined;
  const q = first?.questionnaire as Record<string, unknown> | undefined;
  return (q?.slug as string) || (q?.title as string) || "unknown";
}
