#!/usr/bin/env tsx
// Reads every cached punchdrink recipe, extracts the raw ingredient strings,
// and writes two data files: the distinct raw strings with counts, and the
// same strings grouped by their deterministically preprocessed "core" name.
// No LLM classification happens here.

import { listCachedPunchFiles, readCachedPunchRecipe, ingredientLines } from "./lib/punchdrink-cache.js";
import { preprocessIngredient } from "./lib/preprocess.js";
import { writeJson, type RawIngredientsFile, type PreprocessedFile } from "./lib/data-files.js";
import { INGREDIENTS_RAW_PATH, INGREDIENTS_PREPROCESSED_PATH } from "./lib/paths.js";

interface RawAgg {
  count: number;
  slugs: string[];
}

interface CoreAgg {
  count: number;
  rawCounts: Map<string, number>;
  flags: { houseMade: number; optional: number; infused: number; garnishLike: number };
  preferred: Map<string, number>;
  slugs: string[];
}

async function main() {
  const files = await listCachedPunchFiles();

  const rawAgg = new Map<string, RawAgg>();
  const coreAgg = new Map<string, CoreAgg>();
  const removedCounts = new Map<string, number>();

  let recipeCount = 0;
  let lineCount = 0;

  for (const filepath of files) {
    const cached = await readCachedPunchRecipe(filepath);
    if (!cached.dataLayer.pagePostTerms?.meta) continue;
    recipeCount++;

    for (const { raw, description } of ingredientLines(cached)) {
      lineCount++;

      // --- raw aggregation ---
      let rawEntry = rawAgg.get(raw);
      if (!rawEntry) {
        rawEntry = { count: 0, slugs: [] };
        rawAgg.set(raw, rawEntry);
      }
      rawEntry.count++;
      if (rawEntry.slugs.length < 3 && !rawEntry.slugs.includes(cached.slug)) {
        rawEntry.slugs.push(cached.slug);
      }

      // --- deterministic preprocessing ---
      const processed = preprocessIngredient(raw, description);
      for (const fragment of processed.removed) {
        removedCounts.set(fragment, (removedCounts.get(fragment) ?? 0) + 1);
      }

      let coreEntry = coreAgg.get(processed.core);
      if (!coreEntry) {
        coreEntry = {
          count: 0,
          rawCounts: new Map(),
          flags: { houseMade: 0, optional: 0, infused: 0, garnishLike: 0 },
          preferred: new Map(),
          slugs: [],
        };
        coreAgg.set(processed.core, coreEntry);
      }
      coreEntry.count++;
      coreEntry.rawCounts.set(raw, (coreEntry.rawCounts.get(raw) ?? 0) + 1);
      if (processed.flags.houseMade) coreEntry.flags.houseMade++;
      if (processed.flags.optional) coreEntry.flags.optional++;
      if (processed.flags.infused) coreEntry.flags.infused++;
      if (processed.flags.garnishLike) coreEntry.flags.garnishLike++;
      if (processed.preferred) {
        coreEntry.preferred.set(processed.preferred, (coreEntry.preferred.get(processed.preferred) ?? 0) + 1);
      }
      if (coreEntry.slugs.length < 3 && !coreEntry.slugs.includes(cached.slug)) {
        coreEntry.slugs.push(cached.slug);
      }
    }
  }

  const generatedAt = new Date().toISOString();

  // --- ingredients-raw.json ---
  const rawItems = [...rawAgg.entries()]
    .map(([raw, agg]) => ({ raw, count: agg.count, slugs: agg.slugs }))
    .sort((a, b) => b.count - a.count || a.raw.localeCompare(b.raw));

  const rawOutput: RawIngredientsFile = {
    generatedAt,
    recipes: recipeCount,
    lines: lineCount,
    distinct: rawItems.length,
    items: rawItems,
  };

  // --- ingredients-preprocessed.json ---
  const coreItems = [...coreAgg.entries()]
    .map(([core, agg]) => {
      const rawVariants = [...agg.rawCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 12)
        .map(([variant]) => variant);
      const preferred = [...agg.preferred.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([brand]) => brand);
      return {
        core,
        count: agg.count,
        rawVariants,
        flags: agg.flags,
        ...(preferred.length > 0 ? { preferred } : {}),
        slugs: agg.slugs,
      };
    })
    .sort((a, b) => b.count - a.count || a.core.localeCompare(b.core));

  const preprocessedOutput: PreprocessedFile = {
    generatedAt,
    distinctCores: coreItems.length,
    items: coreItems,
  };

  writeJson(INGREDIENTS_RAW_PATH, rawOutput);
  writeJson(INGREDIENTS_PREPROCESSED_PATH, preprocessedOutput);

  // --- summary ---
  const singletonCores = coreItems.filter((c) => c.count === 1);
  const flagTotals = coreItems.reduce(
    (acc, c) => {
      acc.houseMade += c.flags.houseMade;
      acc.optional += c.flags.optional;
      acc.infused += c.flags.infused;
      acc.garnishLike += c.flags.garnishLike;
      return acc;
    },
    { houseMade: 0, optional: 0, infused: 0, garnishLike: 0 }
  );
  const topRemoved = [...removedCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15);

  console.log(`Recipes read:      ${recipeCount}`);
  console.log(`Ingredient lines:  ${lineCount}`);
  console.log(`Distinct raw:      ${rawItems.length}`);
  console.log(`Distinct cores:    ${coreItems.length}`);
  console.log(
    `Reduction:         ${rawItems.length} raw -> ${coreItems.length} cores (${(
      (1 - coreItems.length / rawItems.length) *
      100
    ).toFixed(1)}% reduction)`
  );
  console.log(`Singleton cores:   ${singletonCores.length} (count === 1)`);
  console.log(
    `Flags (lines):     houseMade=${flagTotals.houseMade} optional=${flagTotals.optional} infused=${flagTotals.infused} garnishLike=${flagTotals.garnishLike}`
  );
  console.log(`\nTop 15 removed fragments:`);
  for (const [fragment, count] of topRemoved) {
    console.log(`  ${count.toString().padStart(5)}  ${fragment}`);
  }

  console.log(`\n20 random singleton cores:`);
  const shuffled = [...singletonCores].sort(() => Math.random() - 0.5).slice(0, 20);
  for (const c of shuffled) {
    console.log(`  ${c.core}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
