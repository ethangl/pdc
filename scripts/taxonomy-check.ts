#!/usr/bin/env tsx
// Loads and validates curated/taxonomy.json, and prints a short summary.
// Run with `pnpm taxonomy:check`; exits non-zero if the taxonomy is invalid.

import { loadTaxonomy, type Taxonomy } from "./lib/taxonomy.js";

function main(): void {
  let taxonomy: Taxonomy;
  try {
    taxonomy = loadTaxonomy();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  let categoryCount = 0;
  let maxDepth = 0;

  for (const [id] of taxonomy.nodes) {
    if (taxonomy.isCategory(id)) categoryCount++;
    const depth = taxonomy.ancestorsOf(id).length;
    if (depth > maxDepth) maxDepth = depth;
  }
  const stapleCount = taxonomy.stapleIds().length;

  console.log(`Nodes: ${taxonomy.nodes.size}`);
  console.log(`Categories: ${categoryCount}`);
  console.log(`Staples: ${stapleCount}`);
  console.log(`Max depth: ${maxDepth}`);
  console.log("");
  console.log("Category and root tree (depth <= 2, ids only):");
  for (const rootId of taxonomy.roots) {
    printNode(taxonomy, rootId, 0);
  }
}

function printNode(taxonomy: Taxonomy, id: string, depth: number): void {
  const children = taxonomy.childrenOf(id);
  console.log(`${"  ".repeat(depth)}${id} (${children.length})`);
  if (depth >= 2) return;
  for (const childId of children) {
    if (taxonomy.isCategory(childId)) {
      printNode(taxonomy, childId, depth + 1);
    }
  }
}

main();
