import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RAW_CACHE_DIR } from "./paths.js";

export interface PunchdrinkDataLayer {
  pageTitle?: string;
  recipeName?: string;
  pagePostTerms?: {
    meta?: Record<string, string | number | undefined>;
  };
}

export interface RawPunchIngredient {
  amount: string | number;
  unit?: string;
  item: string;
  notes?: string;
  preferred?: string;
}

export interface RawPunchRecipe {
  sourceExternalId: string;
  name: string;
  sourceUrl: string;
  ingredients: RawPunchIngredient[];
  steps: string[];
  garnish?: string;
  notes?: string;
  crawledAt: string;
}

export interface CachedPunchRecipe {
  slug: string;
  filepath: string;
  sourceUrl: string;
  dataLayer: PunchdrinkDataLayer;
}

export const DEFAULT_PUNCH_CACHE_DIR = RAW_CACHE_DIR;

export async function listCachedPunchFiles(cacheDir = DEFAULT_PUNCH_CACHE_DIR): Promise<string[]> {
  const entries = await fs.readdir(cacheDir);
  return entries
    .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
    .sort()
    .map((entry) => path.join(cacheDir, entry));
}

export async function readCachedPunchRecipe(filepath: string): Promise<CachedPunchRecipe> {
  const content = await fs.readFile(filepath, "utf8");
  const dataLayer = JSON.parse(content) as PunchdrinkDataLayer;
  const slug = path.basename(filepath, ".json");

  return {
    slug,
    filepath,
    sourceUrl: `https://punchdrink.com/recipes/${slug}/`,
    dataLayer,
  };
}

export function extractRecipeName(dataLayer: PunchdrinkDataLayer): string | undefined {
  if (dataLayer.recipeName) return dataLayer.recipeName;
  if (!dataLayer.pageTitle) return undefined;

  const name = dataLayer.pageTitle
    .replace(/\s*\|\s*PUNCH$/i, "")
    .replace(/\s*Cocktail Recipe$/i, "")
    .trim();

  return name || undefined;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function parseCachedPunchRecipe(recipe: CachedPunchRecipe): RawPunchRecipe {
  const meta = recipe.dataLayer.pagePostTerms?.meta;
  if (!meta) {
    throw new Error("No Punchdrink meta payload found");
  }

  const name = extractRecipeName(recipe.dataLayer);
  if (!name) {
    throw new Error("Could not determine recipe name");
  }

  const ingredients: RawPunchIngredient[] = [];
  const ingredientCount = Number(meta.ingredients || 0);
  for (let i = 0; i < ingredientCount; i++) {
    const parsed = parseIngredientFields(
      meta[`ingredients_${i}_amount`],
      meta[`ingredients_${i}_ingredient`],
      meta[`ingredients_${i}_description`]
    );
    if (parsed) {
      ingredients.push(parsed);
    }
  }

  const steps: string[] = [];
  const directionCount = Number(meta.directions || 0);
  for (let i = 0; i < directionCount; i++) {
    const step = meta[`directions_${i}_step`];
    if (typeof step === "string" && step.trim()) {
      steps.push(stripHtml(step));
    }
  }

  return {
    sourceExternalId: recipe.slug,
    name,
    sourceUrl: recipe.sourceUrl,
    ingredients,
    steps: steps.length > 0 ? steps : ["See source for preparation instructions."],
    garnish:
      typeof meta.garnish === "string" && meta.garnish.trim()
        ? stripHtml(meta.garnish)
        : undefined,
    notes:
      typeof meta.editors_note === "string" && meta.editors_note.trim()
        ? stripHtml(meta.editors_note)
        : undefined,
    crawledAt: new Date().toISOString(),
  };
}

function parseIngredientFields(
  amountValue: string | number | undefined,
  ingredientValue: string | number | undefined,
  descriptionValue: string | number | undefined
): RawPunchIngredient | null {
  // The ingredient field can contain HTML (e.g. brand links: <a href>…</a>);
  // strip it so the item name is clean for normalization and categorization.
  const item = stripHtml(String(ingredientValue ?? "")).trim();
  if (!item) return null;

  const rawAmount = String(amountValue ?? "").trim();
  const description = String(descriptionValue ?? "").trim();
  const { amount, unit } = splitAmountAndUnit(rawAmount);
  const { preferred, notes } = extractPreferred(description);

  return {
    amount,
    unit,
    item,
    notes,
    preferred,
  };
}

// Punchdrink ingredient descriptions carry brand recommendations as a trailing
// clause ("..., preferably Rye & Sons", "(such as Lustau Puerto Fino Sherry)").
// Pull them back out instead of leaving them in notes.
const PREFERRED_RE = /\b(?:preferably|such as|ideally)\b\s+(.+)$/i;

export function extractPreferred(rawDescription: string): {
  preferred?: string;
  notes?: string;
} {
  const cleaned = stripHtml(rawDescription)
    .replace(/^\(|\)$/g, "")
    .replace(/^[\s,;]+/, "")
    .trim();
  if (!cleaned) return {};

  const match = cleaned.match(PREFERRED_RE);
  if (!match) return { notes: cleaned };

  const preferred = match[1].replace(/[\s).,;]+$/, "").trim();
  const before = cleaned
    .slice(0, match.index)
    .replace(/[\s(,;]+$/, "")
    .replace(/^[\s),;]+/, "")
    .trim();

  return {
    preferred: preferred || undefined,
    notes: before || undefined,
  };
}

function splitAmountAndUnit(value: string): { amount: string | number; unit?: string } {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return { amount: "" };
  }

  if (typeof Number(cleaned) === "number" && !Number.isNaN(Number(cleaned))) {
    return { amount: Number(cleaned) };
  }

  const numeric = cleaned.match(/^([\d./¼½¾⅓⅔⅛⅜⅝⅞]+(?:\s+[\d/¼½¾⅓⅔⅛⅜⅝⅞]+)?)(?:\s+(.+?))?\s*$/);
  if (numeric) {
    return {
      amount: numeric[1],
      unit: numeric[2]?.trim(),
    };
  }

  const textAmount = cleaned.match(/^(half|quarter|third|one|two|three|four|five|six)(?:\s+(.+?))?\s*$/i);
  if (textAmount) {
    return {
      amount: textAmount[1],
      unit: textAmount[2]?.trim(),
    };
  }

  return { amount: cleaned };
}
