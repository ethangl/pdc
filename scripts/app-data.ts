#!/usr/bin/env tsx
// Copies data/recipes.json and the taxonomy into the app bundle
// (ios/PDC/Resources/), minified, and writes the "staples only" matcher
// fixture the Swift Matcher must reproduce. Run after `pnpm mapping`;
// commit the result. See docs/APP.md "Bundling".

import * as fs from "node:fs";
import * as path from "node:path";
import { loadTaxonomy } from "./lib/taxonomy.js";
import { computeMakeability, type MakeabilityResult } from "./lib/makeability.js";
import type { RecipesFile } from "./lib/mapping.js";
import {
  RECIPES_PATH,
  TAXONOMY_PATH,
  APP_RECIPES_PATH,
  APP_TAXONOMY_PATH,
  APP_STAPLES_FIXTURE_PATH,
} from "./lib/paths.js";

function writeAndReport(destPath: string, content: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  console.log(`${destPath}: ${bytes} bytes`);
}

/** The fixture as JSON with one result per line, so a regeneration diff
 * reads as one line per changed recipe. */
function formatFixture(taxonomyVersion: number, stocked: string[], results: MakeabilityResult[]): string {
  return [
    "{",
    `  "taxonomyVersion": ${taxonomyVersion},`,
    `  "stocked": ${JSON.stringify(stocked)},`,
    `  "results": [`,
    results.map((result) => `    ${JSON.stringify(result)}`).join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

function main(): void {
  if (!fs.existsSync(RECIPES_PATH)) {
    console.error(`${RECIPES_PATH} not found. Run pnpm mapping first.`);
    process.exit(1);
  }

  const recipes: RecipesFile = JSON.parse(fs.readFileSync(RECIPES_PATH, "utf8"));
  const taxonomy = loadTaxonomy();
  if (recipes.taxonomyVersion !== taxonomy.version) {
    console.error(
      `${RECIPES_PATH} was built against taxonomy version ${recipes.taxonomyVersion}, but the taxonomy is version ${taxonomy.version}. Run pnpm mapping first.`,
    );
    process.exit(1);
  }

  writeAndReport(APP_RECIPES_PATH, JSON.stringify(recipes));
  writeAndReport(APP_TAXONOMY_PATH, JSON.stringify(JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf8"))));

  const stocked = taxonomy.stapleIds().sort();
  const results = computeMakeability(recipes, taxonomy, new Set(stocked));
  writeAndReport(APP_STAPLES_FIXTURE_PATH, formatFixture(recipes.taxonomyVersion, stocked, results));

  // Index 3 holds every recipe with 3 or more unmet requirements.
  const counts = [0, 0, 0, 0];
  for (const result of results) counts[Math.min(result.unmet, 3)]!++;
  console.log(
    `staples-only distribution: unmet 0: ${counts[0]}, 1: ${counts[1]}, 2: ${counts[2]}, 3+: ${counts[3]} (of ${results.length} recipes)`,
  );
}

main();
