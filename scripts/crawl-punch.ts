#!/usr/bin/env tsx
// Crawls recipe pages from punchdrink.com into the raw cache that the
// extractor reads (data/source/punchdrink/<slug>.json). No browser: recipe
// pages carry their data inline as `dataLayer_content = {...};`, so a plain
// `fetch` plus parsing is enough. See AGENTS.md and README.md's Cache
// policy: this only adds slugs that are missing; it never refetches or
// overwrites what is already cached.
//
// Two discovery modes:
//   - Algolia (default): incremental, newest-first. Needs ALGOLIA_APP_ID and
//     ALGOLIA_API_KEY (in .env.local).
//   - --sitemap: full crawl from the public recipe sitemaps. No secrets
//     needed.
//
// Flags: --limit N, --sitemap, --dry-run.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { loadLocalEnv } from "./lib/env.js";
import { RAW_CACHE_DIR } from "./lib/paths.js";
import type { PunchdrinkDataLayer } from "./lib/punchdrink-cache.js";
import {
  extractDataLayer,
  extractRecipeName,
  extractSlug,
  discoverViaAlgolia,
  discoverViaSitemap,
  fetchRecipePage,
  FetchBlockedError,
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
  // pnpm forwards a literal "--" separator when invoked as `pnpm crawl --
  // --dry-run`; strict parseArgs treats anything after it as a positional
  // and rejects it. Drop one leading "--" so both invocations behave alike.
  if (argv[0] === "--") argv = argv.slice(1);
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: "string" },
      sitemap: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    strict: true,
  });

  let limit: number | null = null;
  if (values.limit !== undefined) {
    const value = Number(values.limit);
    if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
  }

  return {
    limit,
    sitemap: values.sitemap ?? false,
    dryRun: values["dry-run"] ?? false,
  };
}

function readExistingSlugs(dir: string): Set<string> {
  const slugs = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return slugs; // directory doesn't exist yet
  }
  for (const entry of entries) {
    if (entry.endsWith(".json") && !entry.startsWith(".")) {
      slugs.add(entry.replace(/\.json$/, ""));
    }
  }
  return slugs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverSlugs(existing: Set<string>, args: Args): Promise<DiscoveredRecipe[]> {
  if (args.sitemap) {
    console.log("Discovering recipe URLs from the sitemaps...");
    const urls = await discoverViaSitemap();
    console.log(`  found ${urls.length} recipe URLs in the sitemaps`);

    const seen = new Set<string>();
    const discovered: DiscoveredRecipe[] = [];
    for (const url of urls) {
      const slug = extractSlug(url);
      if (!slug || seen.has(slug) || existing.has(slug)) continue;
      seen.add(slug);
      discovered.push({ url, slug });
      if (args.limit !== null && discovered.length >= args.limit) break;
    }
    return discovered;
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
    isCached: (slug) => existing.has(slug),
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

async function fetchAndSave(recipes: DiscoveredRecipe[], dir: string): Promise<FetchOutcome> {
  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < recipes.length; i++) {
    const { url, slug } = recipes[i];
    console.log(`[${i + 1}/${recipes.length}] ${slug}`);

    let html: string;
    try {
      html = await fetchRecipePage(url);
    } catch (err) {
      if (err instanceof FetchBlockedError) {
        console.error(`Stopping: ${err.message}. The site is blocking this crawler; do not retry immediately.`);
        return { fetched, failed, blocked: true };
      }
      console.error(`  ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      await sleep(FETCH_INTERVAL_MS);
      continue;
    }

    try {
      const dataLayer = extractDataLayer(html) as PunchdrinkDataLayer;
      const recipeName = extractRecipeName(html);

      const meta = dataLayer.pagePostTerms?.meta;
      const ingredientCount = meta ? Number(meta.ingredients) : NaN;
      if (!meta || !(ingredientCount > 0)) {
        console.error(`  ${slug}: no ingredients in pagePostTerms.meta, skipping`);
        failed++;
      } else {
        const record = { ...dataLayer, recipeName };
        fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(record, null, 2));
        fetched++;
      }
    } catch (err) {
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

  fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
  const existing = readExistingSlugs(RAW_CACHE_DIR);
  console.log(`${existing.size} already cached\n`);

  const discovered = await discoverSlugs(existing, args);
  console.log(`\nDiscovered ${discovered.length} new slug(s) to fetch\n`);

  if (args.dryRun) {
    for (const { slug } of discovered) console.log(`  ${slug}`);
    console.log("");
    printSummary({ discovered: discovered.length, alreadyCached: existing.size, fetched: 0, failed: 0 });
    return;
  }

  const { fetched, failed, blocked } = await fetchAndSave(discovered, RAW_CACHE_DIR);
  console.log("");
  printSummary({ discovered: discovered.length, alreadyCached: existing.size, fetched, failed });
  if (blocked) process.exitCode = 1;
}

function printSummary(stats: { discovered: number; alreadyCached: number; fetched: number; failed: number }): void {
  console.log("Summary:");
  console.log(`  discovered: ${stats.discovered}`);
  console.log(`  already cached: ${stats.alreadyCached}`);
  console.log(`  fetched: ${stats.fetched}`);
  console.log(`  failed: ${stats.failed}`);
  console.log(`\nAfter a real crawl, run the curation loop: ${CURATION_LOOP}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
