#!/usr/bin/env tsx
// Crawls recipe pages from punchdrink.com into the raw cache that the
// extractor reads (data/source/punchdrink/<slug>.json). No browser: recipe
// pages carry their data inline as `dataLayer_content = {...};`, so a plain
// `fetch` plus parsing is enough. See README.md's "Cache policy" section and
// docs/DESIGN.md: this only adds slugs that are missing; it never refetches
// or overwrites what is already cached.
//
// Two discovery modes:
//   - Algolia (default): incremental, newest-first. Needs ALGOLIA_APP_ID and
//     ALGOLIA_API_KEY (in .env.local).
//   - --sitemap: full crawl from the public recipe sitemaps. No secrets
//     needed.
//
// Flags: --limit N, --sitemap, --dry-run.

import { parseArgs } from "node:util";
import { loadLocalEnv } from "./lib/env.js";
import { parsePositiveInt, stripPnpmSeparator } from "./lib/cli.js";
import { cachedSlugs, ingredientLines, writeCachedRecipe, type PunchdrinkDataLayer } from "./lib/punchdrink-cache.js";
import {
  extractDataLayer,
  recipeNameFromHtml,
  discoverViaAlgolia,
  discoverViaSitemap,
  fetchRecipePage,
  FetchBlockedError,
  sleep,
  type DiscoveredRecipe,
} from "./lib/punchdrink-crawl.js";

const FETCH_INTERVAL_MS = 1000;
const CURATION_LOOP = "pnpm extract && pnpm coverage && pnpm classify && pnpm mapping";

interface Args {
  limit: number | null;
  sitemap: boolean;
  dryRun: boolean;
}

function parseCliArgs(argv: string[]): Args {
  const { values } = parseArgs({
    args: stripPnpmSeparator(argv),
    options: {
      limit: { type: "string" },
      sitemap: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    strict: true,
  });

  return {
    limit: parsePositiveInt("limit", values.limit),
    sitemap: values.sitemap ?? false,
    dryRun: values["dry-run"] ?? false,
  };
}

async function discoverSlugs(existing: Set<string>, args: Args): Promise<DiscoveredRecipe[]> {
  const isCached = (slug: string) => existing.has(slug);

  if (args.sitemap) {
    console.log("Discovering recipe URLs from the sitemaps...");
    return discoverViaSitemap({ isCached, limit: args.limit ?? undefined });
  }

  console.log("Discovering recipe URLs from Algolia (newest first)...");
  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_API_KEY;
  if (!appId || !apiKey) {
    throw new Error(
      "ALGOLIA_APP_ID and ALGOLIA_API_KEY are required for the default crawl. Set them in .env.local, or use --sitemap for a full crawl (no keys needed).",
    );
  }

  return discoverViaAlgolia({
    appId,
    apiKey,
    isCached,
    limit: args.limit ?? undefined,
    onPage: ({ page, nbPages, totalSeen, newSlugs }) => {
      console.log(`  page ${page + 1}/${nbPages}: ${totalSeen} seen, ${newSlugs} new so far`);
    },
  });
}

interface FetchOutcome {
  fetched: number;
  failed: number;
  blocked: boolean;
}

/** Fetches, parses, gates on ingredients, and caches one recipe. Throws on
 * any failure (a fetch error, `FetchBlockedError`, or no ingredient lines);
 * the caller classifies the error. */
async function fetchOne(recipe: DiscoveredRecipe): Promise<void> {
  const { url, slug } = recipe;
  const html = await fetchRecipePage(url);
  const dataLayer = extractDataLayer(html);
  const recipeName = recipeNameFromHtml(html);
  const record: PunchdrinkDataLayer = { ...dataLayer, recipeName };

  if (ingredientLines({ slug, sourceUrl: url, dataLayer: record }).length === 0) {
    throw new Error("no ingredients");
  }

  writeCachedRecipe(slug, record);
}

async function fetchAndSave(recipes: DiscoveredRecipe[]): Promise<FetchOutcome> {
  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < recipes.length; i++) {
    const { slug } = recipes[i];
    console.log(`[${i + 1}/${recipes.length}] ${slug}`);

    try {
      await fetchOne(recipes[i]);
      fetched++;
    } catch (err) {
      if (err instanceof FetchBlockedError) {
        console.error(`Stopping: ${err.message}. The site is blocking this crawler; do not retry immediately.`);
        return { fetched, failed, blocked: true };
      }
      console.error(`  ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    if (i < recipes.length - 1) await sleep(FETCH_INTERVAL_MS);
  }

  return { fetched, failed, blocked: false };
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseCliArgs(process.argv.slice(2));

  const existing = new Set(cachedSlugs());
  console.log(`${existing.size} already cached\n`);

  const discovered = await discoverSlugs(existing, args);
  console.log(`\nDiscovered ${discovered.length} new slug(s) to fetch\n`);

  if (args.dryRun) {
    for (const { slug } of discovered) console.log(`  ${slug}`);
    return;
  }

  const { fetched, failed, blocked } = await fetchAndSave(discovered);
  console.log("");
  printSummary({ discovered: discovered.length, fetched, failed });
  if (blocked) process.exitCode = 1;
}

function printSummary(stats: { discovered: number; fetched: number; failed: number }): void {
  console.log("Summary:");
  console.log(`  discovered: ${stats.discovered}`);
  console.log(`  fetched: ${stats.fetched}`);
  console.log(`  failed: ${stats.failed}`);
  console.log(`\nAfter a real crawl, run the curation loop: ${CURATION_LOOP}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
