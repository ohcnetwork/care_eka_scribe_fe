import type { ActivityDefinitionRead } from "./care-api";

/**
 * Build search variants from investigation names like
 * "CBC (Complete Blood Count)" → CBC, Complete Blood Count, full string.
 */
export function buildActivityDefinitionSearchQueries(
  names: string[],
): string[] {
  const queries = new Set<string>();

  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;

    queries.add(name);

    const hyphenless = name.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    if (hyphenless !== name) queries.add(hyphenless);

    const compact = name.replace(/[\s-]+/g, "");
    if (compact !== name && compact.length >= 3) queries.add(compact);

    const parenMatch = name.match(/\(([^)]+)\)/);
    const withoutParen = name.replace(/\([^)]*\)/g, "").trim();
    if (withoutParen) queries.add(withoutParen);
    if (parenMatch?.[1]?.trim()) queries.add(parenMatch[1].trim());

    const words = name
      .replace(/[()]/g, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2);
    for (const word of words) {
      if (word.length <= 6) queries.add(word);
    }
  }

  return [...queries].filter((query) => query.length >= 2);
}

function normalizeActivityText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSearchTokens(text: string): string[] {
  const tokens = new Set<string>();
  const normalized = normalizeActivityText(text);
  if (!normalized) return [];

  for (const word of normalized.split(" ")) {
    if (word.length >= 2) tokens.add(word);
  }

  const acronyms = text.match(/\b[A-Z]{2,8}\b/g) ?? [];
  for (const acronym of acronyms) {
    tokens.add(acronym.toLowerCase());
  }

  const parenthetical = text.match(/\(([^)]+)\)/g) ?? [];
  for (const group of parenthetical) {
    for (const word of normalizeActivityText(group).split(" ")) {
      if (word.length >= 2) tokens.add(word);
    }
  }

  return [...tokens];
}

function definitionSearchTexts(definition: ActivityDefinitionRead): string[] {
  return [
    definition.title,
    definition.code?.display ?? "",
    ...(definition.diagnostic_report_codes?.map((code) => code.display) ?? []),
  ].filter(Boolean);
}

export function scoreActivityDefinition(
  definition: ActivityDefinitionRead,
  queries: string[],
): number {
  const names = definitionSearchTexts(definition);
  const defTokens = new Set(names.flatMap(extractSearchTokens));
  const defNormalized = names.map(normalizeActivityText);
  let best = 0;

  for (const query of queries) {
    const normalized = normalizeActivityText(query);
    if (!normalized) continue;

    for (const name of defNormalized) {
      if (name === normalized) best = Math.max(best, 100);
      else if (name.startsWith(normalized) || normalized.startsWith(name)) {
        best = Math.max(best, 90);
      } else if (name.includes(normalized) || normalized.includes(name)) {
        best = Math.max(best, 80);
      }
    }

    const queryTokens = extractSearchTokens(query);
    if (!queryTokens.length) continue;

    const matched = queryTokens.filter((token) => defTokens.has(token)).length;
    const overlapScore = Math.round((matched / queryTokens.length) * 95);
    if (matched === queryTokens.length) {
      best = Math.max(best, Math.max(overlapScore, 88));
    } else if (matched > 0) {
      best = Math.max(best, overlapScore);
    }
  }

  return best;
}

export function pickBestActivityDefinition(
  results: ActivityDefinitionRead[],
  queries: string[],
): ActivityDefinitionRead | null {
  if (!results.length) return null;

  const ranked = results
    .map((definition) => ({
      definition,
      score: scoreActivityDefinition(definition, queries),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  if (best.score >= 35) return best.definition;

  if (results.length === 1 && best.score > 0) {
    return best.definition;
  }

  return null;
}
