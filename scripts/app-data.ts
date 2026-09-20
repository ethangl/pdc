#!/usr/bin/env tsx
// Copies data/recipes.json and the taxonomy into the app bundle
// (ios/PDC/Resources/), minified, and writes the "staples only" matcher
// fixture the Swift Matcher must reproduce. Run after `pnpm mapping`;
// commit the result. See docs/APP.md "Bundling".

import * as fs from "node:fs";
import * as path from "node:path";
import { loadTaxonomy } from "./lib/taxonomy.js";
import { computeMakeability, stapleIds } from "./lib/makeability.js";
import type { RecipesFile } from "./lib/mapping.js";
import {
  RECIPES_PATH,
  TAXONOMY_PATH,
  APP_RECIPES_PATH,
  APP_TAXONOMY_PATH,
  APP_FIXTURES_DIR,
  APP_STAPLES_FIXTURE_PATH,
} from "./lib/paths.js";

function writeAndReport(destPath: string, content: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  console.log(`${destPath}: ${bytes} bytes`);
}

function main(): void {
  if (!fs.existsSync(RECIPES_PATH)) {
    console.error(`${RECIPES_PATH} not found. Run pnpm mapping first.`);
    process.exit(1);
  }

  const recipesRaw = fs.readFileSync(RECIPES_PATH, "utf8");
  const recipes: RecipesFile = JSON.parse(recipesRaw);
  writeAndReport(APP_RECIPES_PATH, JSON.stringify(recipes));

  const taxonomy = loadTaxonomy();
  const taxonomyRaw = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf8"));
  writeAndReport(APP_TAXONOMY_PATH, JSON.stringify(taxonomyRaw));

  const stocked = new Set(stapleIds(taxonomy));
  const results = computeMakeability(recipes, taxonomy, stocked);

  fs.mkdirSync(APP_FIXTURES_DIR, { recursive: true });
  const fixture = {
    taxonomyVersion: recipes.taxonomyVersion,
    stocked: [...stocked].sort(),
    results,
  };
  writeAndReport(APP_STAPLES_FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");

  const buckets = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  for (const result of results) {
    if (result.unmet === 0) buckets[0]++;
    else if (result.unmet === 1) buckets[1]++;
    else if (result.unmet === 2) buckets[2]++;
    else buckets["3+"]++;
  }
  console.log(
    `staples-only distribution: unmet 0: ${buckets[0]}, 1: ${buckets[1]}, 2: ${buckets[2]}, 3+: ${buckets["3+"]} (of ${results.length} recipes)`,
  );
}

main();
