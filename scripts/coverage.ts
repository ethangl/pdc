#!/usr/bin/env tsx
// Reports how much of data/ingredients-preprocessed.json is already covered
// by direct taxonomy aliases, and lists what is not, for the reviewer to
// extend curated/taxonomy.json or for the classifier to handle.
// Run with `pnpm coverage`. Flags: `--limit N` (default 150), `--no-validate`
// (compute coverage even when the taxonomy fails validation).

import * as fs from "node:fs";
import * as path from "node:path";
import { validateTaxonomy, taxonomyFromRaw, type Taxonomy } from "./lib/taxonomy.js";
import { TAXONOMY_PATH, REVIEW_DIR } from "./lib/paths.js";
import { readPreprocessed, type PreprocessedItem } from "./lib/data-files.js";

const OUT_PATH = path.join(REVIEW_DIR, "coverage-unmatched.txt");
const DEFAULT_LIMIT = 150;

function parseArgs(argv: string[]): { limit: number; noValidate: boolean } {
  let limit = DEFAULT_LIMIT;
  let noValidate = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
      i++;
    } else if (argv[i] === "--no-validate") {
      noValidate = true;
    }
  }
  return { limit, noValidate };
}

function loadTaxonomyForCoverage(noValidate: boolean): Taxonomy {
  const content = fs.readFileSync(TAXONOMY_PATH, "utf8");
  const raw = JSON.parse(content);

  if (!noValidate) {
    const problems = validateTaxonomy(raw);
    if (problems.length > 0) {
      console.error(`Taxonomy has ${problems.length} problem(s); not computing coverage:`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("Re-run with --no-validate to compute coverage anyway.");
      process.exit(1);
    }
  }

  return taxonomyFromRaw(raw);
}

function formatPercent(part: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function flagsSummary(flags: PreprocessedItem["flags"]): string {
  return Object.entries(flags)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}=${count}`)
    .join(",");
}

function main(): void {
  const { limit, noValidate } = parseArgs(process.argv.slice(2));
  const taxonomy = loadTaxonomyForCoverage(noValidate);

  const preprocessed = readPreprocessed();
  const items = preprocessed.items;

  const resolved = items.map((item) => ({ item, nodeId: taxonomy.resolveAlias(item.core) }));

  const totalLines = items.reduce((sum, item) => sum + item.count, 0);
  const totalCores = items.length;
  const coveredEntries = resolved.filter((entry) => entry.nodeId !== undefined);
  const coveredLines = coveredEntries.reduce((sum, entry) => sum + entry.item.count, 0);
  const coveredCores = coveredEntries.length;

  const multi = resolved.filter((entry) => entry.item.count >= 2);
  const multiLines = multi.reduce((sum, entry) => sum + entry.item.count, 0);
  const multiCores = multi.length;
  const multiCovered = multi.filter((entry) => entry.nodeId !== undefined);
  const multiCoveredLines = multiCovered.reduce((sum, entry) => sum + entry.item.count, 0);
  const multiCoveredCores = multiCovered.length;

  console.log(`Total lines: ${totalLines}`);
  console.log(`Total distinct cores: ${totalCores}`);
  console.log("");
  console.log("Direct alias coverage (all cores):");
  console.log(`  Lines covered: ${coveredLines} / ${totalLines} (${formatPercent(coveredLines, totalLines)})`);
  console.log(`  Cores covered: ${coveredCores} / ${totalCores} (${formatPercent(coveredCores, totalCores)})`);
  console.log("");
  console.log("Direct alias coverage (cores with count >= 2):");
  console.log(`  Lines covered: ${multiCoveredLines} / ${multiLines} (${formatPercent(multiCoveredLines, multiLines)})`);
  console.log(`  Cores covered: ${multiCoveredCores} / ${multiCores} (${formatPercent(multiCoveredCores, multiCores)})`);
  console.log("");

  const rootHistogram = new Map<string, number>();
  for (const entry of coveredEntries) {
    const root = taxonomy.rootOf(entry.nodeId!);
    rootHistogram.set(root, (rootHistogram.get(root) ?? 0) + entry.item.count);
  }
  const rootRows = [...rootHistogram.entries()].sort((a, b) => b[1] - a[1]);
  console.log("Covered lines by root category:");
  for (const [rootId, count] of rootRows) {
    const name = taxonomy.nodes.get(rootId)?.name ?? rootId;
    console.log(`  ${rootId} (${name}): ${count}`);
  }
  console.log("");

  const unmatched = resolved
    .filter((entry) => entry.nodeId === undefined)
    .map((entry) => entry.item)
    .sort((a, b) => b.count - a.count);
  const unmatchedTop = unmatched.slice(0, limit);

  const unmatchedLines = unmatchedTop.map((item) => {
    const flags = flagsSummary(item.flags);
    return `${item.count}\t${item.core}${flags ? `\t${flags}` : ""}`;
  });

  console.log(`Top ${unmatchedTop.length} unmatched cores by count (of ${unmatched.length} total unmatched):`);
  for (const line of unmatchedLines) console.log(line);
  console.log("");

  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, unmatchedLines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${unmatchedTop.length} unmatched cores to ${OUT_PATH}`);
  console.log("");

  const pureGarnish = coveredEntries
    .filter((entry) => entry.item.flags.garnishLike > 0 && entry.item.flags.garnishLike === entry.item.count)
    .map((entry) => entry.item)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  console.log(`Matched, pure-garnish cores (flags.garnishLike === count), top ${pureGarnish.length}:`);
  for (const item of pureGarnish) {
    console.log(`${item.count}\t${item.core}`);
  }
}

main();
