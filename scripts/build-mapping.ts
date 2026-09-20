#!/usr/bin/env tsx
// Builds data/recipes.json, the app-facing mapping from each cached
// punchdrink recipe to the taxonomy node ids it requires. Reads the
// punchdrink cache, curated/taxonomy.json, curated/overrides.json, and
// curated/classifications.json; writes no cache of its own besides the
// unresolved-cores report. See docs/DESIGN.md for the resolution rules.
//
// Run with `pnpm mapping`.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { loadTaxonomy } from "./lib/taxonomy.js";
import { cachedRecipes, extractRecipeName, ingredientLines } from "./lib/punchdrink-cache.js";
import { preprocessIngredient } from "./lib/preprocess.js";
import {
  resolveLine,
  dedupeRequirements,
  classificationLookup,
  type ResolveDeps,
  type RecipeMapping,
  type RecipesFile,
  type Requirement,
  type UnresolvedLine,
  type ResolutionSource,
} from "./lib/mapping.js";
import { readOverrides, readClassifications, writeJson } from "./lib/data-files.js";
import { RECIPES_PATH, REVIEW_DIR } from "./lib/paths.js";

const UNRESOLVED_PATH = path.join(REVIEW_DIR, "mapping-unresolved.txt");

function bucketFor(count: number): string {
  if (count <= 3) return "1-3";
  if (count <= 5) return "4-5";
  if (count <= 7) return "6-7";
  return "8+";
}

async function main(): Promise<void> {
  const taxonomy = loadTaxonomy();
  const overrides = readOverrides();
  const classificationsFile = readClassifications();
  const { lookup: classifications, skipped: skippedClassifications } = classificationLookup(
    classificationsFile?.items ?? [],
    (id) => taxonomy.nodes.has(id),
  );

  const deps: ResolveDeps = {
    overrides,
    classifications,
    resolveAlias: taxonomy.resolveAlias,
    isCategory: taxonomy.isCategory,
  };

  const recipes: RecipeMapping[] = [];

  let recipesRead = 0;
  let recipesSkippedNoLines = 0;
  let linesTotal = 0;
  let optionalLines = 0;
  let unresolvedLinesTotal = 0;
  let droppedOverrideTotal = 0;
  let droppedOptionalTotal = 0;
  let unresolvedAlternativesTotal = 0;
  const sourceCounts: Record<ResolutionSource, number> = { override: 0, alias: 0, classification: 0, fallback: 0 };
  const categoryHitCounts = new Map<string, number>();
  let categoryHitsTotal = 0;
  const unresolvedCoreAgg = new Map<string, { count: number; exampleSlug: string }>();
  const optionalDroppedCoreAgg = new Map<string, { count: number; exampleSlug: string }>();
  const requiresLengthHistogram = new Map<string, number>();
  let requiresZero = 0;

  for await (const cached of cachedRecipes()) {
    recipesRead++;
    const lines = ingredientLines(cached);

    if (lines.length === 0) {
      recipesSkippedNoLines++;
      continue;
    }

    const requires: Requirement[] = [];
    const optional: Requirement[] = [];
    const unresolved: UnresolvedLine[] = [];

    for (const { raw, description } of lines) {
      linesTotal++;

      const processed = preprocessIngredient(raw, description);
      const resolution = resolveLine(processed, deps);

      for (const candidate of resolution.resolvedCandidates) {
        sourceCounts[candidate.source]++;
      }
      for (const nodeId of resolution.categoryHits) {
        categoryHitsTotal++;
        categoryHitCounts.set(nodeId, (categoryHitCounts.get(nodeId) ?? 0) + 1);
      }
      unresolvedAlternativesTotal += resolution.unresolvedAlternatives;

      switch (resolution.bucket) {
        case "requires":
          requires.push(resolution.requirement);
          break;
        case "optional":
          optional.push(resolution.requirement);
          optionalLines++;
          break;
        case "dropped":
          if (resolution.reason === "override") {
            // Every candidate was overridden to null: not an ingredient at all.
            droppedOverrideTotal++;
          } else {
            // No candidate resolved, but the line is optional or garnish-like
            // so it never blocks the recipe; still worth surfacing to curation.
            droppedOptionalTotal++;
            const agg = optionalDroppedCoreAgg.get(processed.core);
            if (agg) {
              agg.count++;
            } else {
              optionalDroppedCoreAgg.set(processed.core, { count: 1, exampleSlug: cached.slug });
            }
          }
          break;
        case "unresolved": {
          unresolved.push(resolution.unresolved);
          unresolvedLinesTotal++;
          const agg = unresolvedCoreAgg.get(resolution.unresolved.core);
          if (agg) {
            agg.count++;
          } else {
            unresolvedCoreAgg.set(resolution.unresolved.core, { count: 1, exampleSlug: cached.slug });
          }
          break;
        }
      }
    }

    const dedupedRequires = dedupeRequirements(requires);

    const mapping: RecipeMapping = {
      slug: cached.slug,
      name: extractRecipeName(cached.dataLayer) ?? cached.slug,
      url: cached.sourceUrl,
      requires: dedupedRequires,
      ...(optional.length > 0 ? { optional } : {}),
      ...(unresolved.length > 0 ? { unresolved } : {}),
    };
    recipes.push(mapping);

    if (dedupedRequires.length === 0) {
      requiresZero++;
    } else {
      const bucket = bucketFor(dedupedRequires.length);
      requiresLengthHistogram.set(bucket, (requiresLengthHistogram.get(bucket) ?? 0) + 1);
    }
  }

  recipes.sort((a, b) => a.slug.localeCompare(b.slug));

  const output: RecipesFile = {
    generatedAt: new Date().toISOString(),
    taxonomyVersion: taxonomy.version,
    recipes,
  };

  writeJson(RECIPES_PATH, output);

  await fsp.mkdir(REVIEW_DIR, { recursive: true });
  const unresolvedRows = [...unresolvedCoreAgg.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([core, agg]) => `${agg.count}\t${core}\t${agg.exampleSlug}`);
  // Optional/garnish-like lines that never blocked a recipe, but still have
  // no resolution: a third column marks them so they aren't mistaken for the
  // blocking kind above.
  const optionalDroppedRows = [...optionalDroppedCoreAgg.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([core, agg]) => `${agg.count}\t${core}\t${agg.exampleSlug}\toptional`);
  const allUnresolvedRows = [...unresolvedRows, ...optionalDroppedRows];
  await fsp.writeFile(UNRESOLVED_PATH, allUnresolvedRows.join("\n") + (allUnresolvedRows.length > 0 ? "\n" : ""), "utf8");

  // --- stats ---

  const recipesFullyResolved = recipes.filter((r) => !r.unresolved).length;
  const recipesWithOneUnresolved = recipes.filter((r) => r.unresolved?.length === 1).length;
  const recipesWithTwoPlusUnresolved = recipes.filter((r) => (r.unresolved?.length ?? 0) >= 2).length;

  if (skippedClassifications.length > 0) {
    console.log(`Ignored ${skippedClassifications.length} classifications naming removed nodes`);
    console.log("");
  }
  console.log(`Recipes read:              ${recipesRead}`);
  console.log(`Recipes skipped (no lines): ${recipesSkippedNoLines}`);
  console.log(`Recipes in output:         ${recipes.length}`);
  console.log(`  fully resolved:          ${recipesFullyResolved}`);
  console.log(`  exactly 1 unresolved:    ${recipesWithOneUnresolved}`);
  console.log(`  2+ unresolved:           ${recipesWithTwoPlusUnresolved}`);
  console.log("");
  console.log(`Lines total:               ${linesTotal}`);
  console.log(`  resolved via override:      ${sourceCounts.override}`);
  console.log(`  resolved via alias:         ${sourceCounts.alias}`);
  console.log(`  resolved via classification: ${sourceCounts.classification}`);
  console.log(`  resolved via fallback:       ${sourceCounts.fallback}`);
  console.log(`  unresolved:                ${unresolvedLinesTotal}`);
  console.log(`  optional:                  ${optionalLines}`);
  console.log(`  dropped by override:       ${droppedOverrideTotal}`);
  console.log(`  dropped, optional/garnish-like, unresolved: ${droppedOptionalTotal}`);
  console.log("");
  console.log(`Category hits: ${categoryHitsTotal}`);
  const topCategoryHits = [...categoryHitCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [nodeId, count] of topCategoryHits) {
    console.log(`  ${count}\t${nodeId}`);
  }
  console.log("");
  console.log(`Unresolved alternatives: ${unresolvedAlternativesTotal}`);
  console.log("");
  console.log(`Top 60 unresolved cores:`);
  const topUnresolved = [...unresolvedCoreAgg.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 60);
  for (const [core, agg] of topUnresolved) {
    console.log(`  ${agg.count}\t${core}`);
  }
  console.log("");
  console.log(`Top 20 unresolved optional/garnish-like cores (dropped, not blocking):`);
  const topOptionalDropped = [...optionalDroppedCoreAgg.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 20);
  for (const [core, agg] of topOptionalDropped) {
    console.log(`  ${agg.count}\t${core}`);
  }
  console.log("");
  console.log(`requires.length distribution (recipes in output):`);
  console.log(`  0:    ${requiresZero}`);
  for (const bucket of ["1-3", "4-5", "6-7", "8+"]) {
    console.log(`  ${bucket}:  ${requiresLengthHistogram.get(bucket) ?? 0}`);
  }
  console.log("");
  console.log(`Wrote ${recipes.length} recipes to ${RECIPES_PATH}`);
  console.log(
    `Wrote ${unresolvedRows.length} unresolved cores and ${optionalDroppedRows.length} optional/garnish-like dropped cores to ${UNRESOLVED_PATH}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
