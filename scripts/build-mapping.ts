#!/usr/bin/env tsx
// Builds data/recipes.json, the app-facing mapping from each cached
// punchdrink recipe to the taxonomy node ids it requires. Reads the
// punchdrink cache, curated/taxonomy.json, curated/overrides.json, and
// curated/classifications.json; writes no cache of its own besides the
// unresolved-cores report. See AGENTS.md for the resolution rules.
//
// Run with `pnpm mapping`.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { loadTaxonomy } from "./lib/taxonomy.js";
import {
  listCachedPunchFiles,
  readCachedPunchRecipe,
  extractRecipeName,
  extractPreferred,
  stripHtml,
} from "./lib/punchdrink-cache.js";
import { preprocessIngredient, mentionsEditorsNote } from "./lib/preprocess.js";
import {
  resolveLine,
  dedupeRequirements,
  type ResolveDeps,
  type RecipeMapping,
  type RecipesFile,
  type Requirement,
  type UnresolvedLine,
  type ResolutionSource,
} from "./lib/mapping.js";
import { OVERRIDES_PATH, CLASSIFICATIONS_PATH, RECIPES_PATH, REVIEW_DIR } from "./lib/paths.js";

const OUTPUT_PATH = RECIPES_PATH;
const UNRESOLVED_PATH = path.join(REVIEW_DIR, "mapping-unresolved.txt");

interface ClassificationItem {
  core: string;
  status: "override" | "accepted" | "fallback" | "review" | "none" | "error";
  node: string | null;
}

interface ClassificationsFile {
  taxonomyVersion: number;
  promptVersion: string;
  items: ClassificationItem[];
}

function loadOverrides(): Record<string, string | null> {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
}

interface Classifications {
  /** Accepted/override classifications only: core -> node id. */
  classifications: Map<string, string>;
  /** Fallback classifications only: core -> the family's fallback node id. */
  fallbackClassifications: Map<string, string>;
}

function loadClassifications(): Classifications {
  const classifications = new Map<string, string>();
  const fallbackClassifications = new Map<string, string>();
  if (!fs.existsSync(CLASSIFICATIONS_PATH)) return { classifications, fallbackClassifications };
  const file = JSON.parse(fs.readFileSync(CLASSIFICATIONS_PATH, "utf8")) as ClassificationsFile;
  for (const item of file.items) {
    if (typeof item.node !== "string") continue;
    if (item.status === "accepted" || item.status === "override") {
      classifications.set(item.core, item.node);
    } else if (item.status === "fallback") {
      fallbackClassifications.set(item.core, item.node);
    }
  }
  return { classifications, fallbackClassifications };
}

function bucketFor(count: number): string {
  if (count <= 3) return "1-3";
  if (count <= 5) return "4-5";
  if (count <= 7) return "6-7";
  return "8+";
}

async function main(): Promise<void> {
  const taxonomy = loadTaxonomy();
  const overrides = loadOverrides();
  const { classifications, fallbackClassifications } = loadClassifications();

  const deps: ResolveDeps = {
    overrides,
    classifications,
    fallbackClassifications,
    resolveAlias: taxonomy.resolveAlias,
    isCategory: taxonomy.isCategory,
  };

  const files = await listCachedPunchFiles();

  const recipes: RecipeMapping[] = [];

  let recipesSkippedNoLines = 0;
  let linesTotal = 0;
  let optionalLines = 0;
  let unresolvedLinesTotal = 0;
  let droppedLinesTotal = 0;
  let unresolvedAlternativesTotal = 0;
  const sourceCounts: Record<ResolutionSource, number> = { override: 0, alias: 0, classification: 0, fallback: 0 };
  const categoryHitCounts = new Map<string, number>();
  let categoryHitsTotal = 0;
  const unresolvedCoreAgg = new Map<string, { count: number; exampleSlug: string }>();
  const requiresLengthHistogram = new Map<string, number>();
  let requiresZero = 0;

  for (const filepath of files) {
    const cached = await readCachedPunchRecipe(filepath);
    const meta = cached.dataLayer.pagePostTerms?.meta;
    const ingredientCount = meta ? Number(meta.ingredients || 0) : 0;

    const requires: Requirement[] = [];
    const optional: Requirement[] = [];
    const unresolved: UnresolvedLine[] = [];
    let sawLine = false;

    for (let i = 0; i < ingredientCount; i++) {
      const item = stripHtml(String(meta![`ingredients_${i}_ingredient`] ?? "")).trim();
      if (!item) continue;
      sawLine = true;
      linesTotal++;

      const description = String(meta![`ingredients_${i}_description`] ?? "").trim();
      const processed = preprocessIngredient(item);
      const { preferred: descPreferred } = extractPreferred(description);
      void descPreferred; // brand recommendations are discarded, per docs/DESIGN.md
      const houseMade = processed.flags.houseMade || mentionsEditorsNote(description);

      const resolution = resolveLine(
        {
          raw: item,
          core: processed.core,
          alternatives: processed.alternatives,
          flags: { optional: processed.flags.optional, garnishLike: processed.flags.garnishLike },
        },
        houseMade,
        deps
      );

      for (const candidate of resolution.resolvedCandidates) {
        sourceCounts[candidate.source]++;
      }
      for (const nodeId of resolution.categoryHits) {
        categoryHitsTotal++;
        categoryHitCounts.set(nodeId, (categoryHitCounts.get(nodeId) ?? 0) + 1);
      }
      unresolvedAlternativesTotal += resolution.unresolvedAlternatives;

      if (resolution.bucket === "requires") {
        requires.push(resolution.requirement!);
      } else if (resolution.bucket === "optional") {
        optional.push(resolution.requirement!);
        optionalLines++;
      } else if (resolution.bucket === "dropped") {
        // Every candidate was overridden to null: not an ingredient at all.
        droppedLinesTotal++;
      } else {
        unresolved.push(resolution.unresolved!);
        unresolvedLinesTotal++;
        const agg = unresolvedCoreAgg.get(resolution.unresolved!.core);
        if (agg) {
          agg.count++;
        } else {
          unresolvedCoreAgg.set(resolution.unresolved!.core, { count: 1, exampleSlug: cached.slug });
        }
      }
    }

    if (!sawLine) {
      recipesSkippedNoLines++;
      continue;
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

  await fsp.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  await fsp.mkdir(REVIEW_DIR, { recursive: true });
  const unresolvedRows = [...unresolvedCoreAgg.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([core, agg]) => `${agg.count}\t${core}\t${agg.exampleSlug}`);
  await fsp.writeFile(UNRESOLVED_PATH, unresolvedRows.join("\n") + (unresolvedRows.length > 0 ? "\n" : ""), "utf8");

  // --- stats ---

  const recipesFullyResolved = recipes.filter((r) => !r.unresolved).length;
  const recipesWithOneUnresolved = recipes.filter((r) => r.unresolved?.length === 1).length;
  const recipesWithTwoPlusUnresolved = recipes.filter((r) => (r.unresolved?.length ?? 0) >= 2).length;

  console.log(`Recipes read:              ${files.length}`);
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
  console.log(`  dropped by override:       ${droppedLinesTotal}`);
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
  console.log(`requires.length distribution (recipes in output):`);
  console.log(`  0:    ${requiresZero}`);
  for (const bucket of ["1-3", "4-5", "6-7", "8+"]) {
    console.log(`  ${bucket}:  ${requiresLengthHistogram.get(bucket) ?? 0}`);
  }
  console.log("");
  console.log(`Wrote ${recipes.length} recipes to ${OUTPUT_PATH}`);
  console.log(`Wrote ${unresolvedRows.length} unresolved cores to ${UNRESOLVED_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
