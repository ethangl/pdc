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

export interface CachedPunchRecipe {
  slug: string;
  sourceUrl: string;
  dataLayer: PunchdrinkDataLayer;
}

/** Every cached punchdrink recipe, read in sorted slug order. */
export async function* cachedRecipes(cacheDir = RAW_CACHE_DIR): AsyncGenerator<CachedPunchRecipe> {
  const entries = await fs.readdir(cacheDir);
  const filenames = entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".")).sort();

  for (const filename of filenames) {
    const content = await fs.readFile(path.join(cacheDir, filename), "utf8");
    const dataLayer = JSON.parse(content) as PunchdrinkDataLayer;
    const slug = path.basename(filename, ".json");

    yield {
      slug,
      sourceUrl: `https://punchdrink.com/recipes/${slug}/`,
      dataLayer,
    };
  }
}

/** One recipe's ingredient lines: the ingredient field (HTML-stripped,
 * trimmed) paired with its raw description. Lines with an empty ingredient
 * field are skipped. Empty when the recipe has no meta payload. */
export function ingredientLines(cached: CachedPunchRecipe): { raw: string; description: string }[] {
  const meta = cached.dataLayer.pagePostTerms?.meta;
  if (!meta) return [];

  const lines: { raw: string; description: string }[] = [];
  const ingredientCount = Number(meta.ingredients || 0);
  for (let i = 0; i < ingredientCount; i++) {
    // The ingredient field can contain HTML (e.g. brand links: <a href>…</a>);
    // strip it so the item name is clean for normalization and categorization.
    const raw = stripHtml(String(meta[`ingredients_${i}_ingredient`] ?? "")).trim();
    if (!raw) continue;
    const description = String(meta[`ingredients_${i}_description`] ?? "").trim();
    lines.push({ raw, description });
  }
  return lines;
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
