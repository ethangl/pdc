import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RAW_CACHE_DIR } from "./paths.js";

export interface PunchdrinkDataLayer {
  pageTitle?: string;
  recipeName?: string | null;
  pagePostTerms?: {
    meta?: Record<string, string | number | undefined>;
  };
}

export interface CachedPunchRecipe {
  slug: string;
  sourceUrl: string;
  dataLayer: PunchdrinkDataLayer;
}

/** Sorted slugs of every cached recipe (filenames ending in `.json`, not
 * starting with `.`). Empty when the cache directory does not exist;
 * rethrows any other error reading the directory. */
export function cachedSlugs(cacheDir = RAW_CACHE_DIR): string[] {
  let entries: string[];
  try {
    entries = fsSync.readdirSync(cacheDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // Sort filenames (with their .json extension), not the stripped slugs: a
  // slug that is a prefix of another (e.g. "alfonso" vs "alfonso-xiii")
  // sorts differently once the extension is removed ("." sorts after "-").
  return entries
    .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
    .sort()
    .map((entry) => path.basename(entry, ".json"));
}

/** Writes one recipe's data layer to the cache, creating the directory if
 * needed. Writes to a `.tmp` file first and renames it onto the final name,
 * so a reader never sees a partial write. The `.tmp` suffix already fails
 * `cachedSlugs`'s `.json` filter, so a leftover temp file is invisible to
 * readers rather than merely partial. */
export function writeCachedRecipe(slug: string, record: PunchdrinkDataLayer, cacheDir = RAW_CACHE_DIR): void {
  fsSync.mkdirSync(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, `${slug}.json`);
  const tmpPath = `${finalPath}.tmp`;
  fsSync.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  fsSync.renameSync(tmpPath, finalPath);
}

/** Every cached punchdrink recipe, read in sorted slug order. Throws when
 * the cache is empty or missing: an empty cache is never a valid input for
 * extract or mapping. */
export async function* cachedRecipes(cacheDir = RAW_CACHE_DIR): AsyncGenerator<CachedPunchRecipe> {
  const slugs = cachedSlugs(cacheDir);
  if (slugs.length === 0) {
    throw new Error(`Raw cache at ${cacheDir} is empty or missing. Run pnpm crawl first.`);
  }

  for (const slug of slugs) {
    const content = await fs.readFile(path.join(cacheDir, `${slug}.json`), "utf8");
    const dataLayer = JSON.parse(content) as PunchdrinkDataLayer;

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
