#!/usr/bin/env tsx
// node:test cases for scripts/lib/makeability.ts. Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMakeability } from "./lib/makeability.js";
import type { RecipesFile, Requirement } from "./lib/mapping.js";
import { taxonomyFromRaw, type TaxonomyNode } from "./lib/taxonomy.js";

// --- a small synthetic taxonomy ---

const NODES: TaxonomyNode[] = [
  { id: "gin", name: "Gin" },
  { id: "london-dry-gin", name: "London dry gin", parent: "gin" },
  { id: "old-tom-gin", name: "Old tom gin", parent: "gin" },
  { id: "citrus", name: "Citrus", kind: "category" },
  { id: "lime-juice", name: "Lime juice", parent: "citrus" },
  { id: "lemon-juice", name: "Lemon juice", parent: "citrus" },
  { id: "syrup", name: "Syrup", kind: "category", fallback: "simple-syrup" },
  { id: "simple-syrup", name: "Simple syrup", parent: "syrup", staple: true },
  { id: "vanilla-syrup", name: "Vanilla syrup", parent: "syrup" },
  { id: "salt", name: "Salt", staple: true },
];

const TAXONOMY = taxonomyFromRaw({ version: 0, nodes: NODES });

function req(partial: Partial<Requirement> & { nodes: string[] }): Requirement {
  return { houseMade: false, raw: partial.nodes.join(" or "), ...partial };
}

function recipes(list: RecipesFile["recipes"]): RecipesFile {
  return { generatedAt: "2026-09-20T00:00:00.000Z", taxonomyVersion: 0, recipes: list };
}

test("alternatives: either satisfies the requirement", () => {
  const file = recipes([{ slug: "a", name: "A", url: "u", requires: [req({ nodes: ["lime-juice", "lemon-juice"] })] }]);
  const stocked = new Set(["lemon-juice"]);
  const [result] = computeMakeability(file, TAXONOMY, stocked);
  assert.equal(result!.unmet, 0);
  assert.equal(result!.unmetHouseMade, 0);
});

test("descendant matching: a child satisfies its parent", () => {
  const file = recipes([{ slug: "a", name: "A", url: "u", requires: [req({ nodes: ["gin"] })] }]);
  const stocked = new Set(["london-dry-gin"]);
  const [result] = computeMakeability(file, TAXONOMY, stocked);
  assert.equal(result!.unmet, 0);
});

test("descendant matching: a parent does not satisfy its child", () => {
  const file = recipes([{ slug: "a", name: "A", url: "u", requires: [req({ nodes: ["old-tom-gin"] })] }]);
  const stocked = new Set(["gin"]);
  const [result] = computeMakeability(file, TAXONOMY, stocked);
  assert.equal(result!.unmet, 1);
});

test("a stocked category node satisfies a requirement naming it directly", () => {
  const file = recipes([{ slug: "a", name: "A", url: "u", requires: [req({ nodes: ["citrus"] })] }]);
  const stocked = new Set(["citrus"]);
  const [result] = computeMakeability(file, TAXONOMY, stocked);
  assert.equal(result!.unmet, 0);
});

test("a substitute requirement is satisfied by stocking the fallback node", () => {
  const file = recipes([
    {
      slug: "a",
      name: "A",
      url: "u",
      requires: [req({ nodes: ["simple-syrup"], houseMade: true, raw: "black tea syrup", substitute: true })],
    },
  ]);
  const stocked = new Set(["simple-syrup"]);
  const [result] = computeMakeability(file, TAXONOMY, stocked);
  assert.equal(result!.unmet, 0);
  assert.equal(result!.unmetHouseMade, 0);
});

test("unresolved lines count toward both totals", () => {
  const file = recipes([
    {
      slug: "a",
      name: "A",
      url: "u",
      requires: [],
      unresolved: [{ raw: "Quesos La Ricura", core: "quesos la ricura" }],
    },
  ]);
  const [result] = computeMakeability(file, TAXONOMY, new Set());
  assert.equal(result!.unmet, 1);
  assert.equal(result!.unmetHouseMade, 1);
});

test("optional requirements never affect the counts", () => {
  const file = recipes([
    {
      slug: "a",
      name: "A",
      url: "u",
      requires: [],
      optional: [req({ nodes: ["lime-juice"] })],
    },
  ]);
  const [result] = computeMakeability(file, TAXONOMY, new Set());
  assert.equal(result!.unmet, 0);
  assert.equal(result!.unmetHouseMade, 0);
});

test("empty stocked set: every non-optional requirement is unmet", () => {
  const file = recipes([
    {
      slug: "a",
      name: "A",
      url: "u",
      requires: [req({ nodes: ["gin"] }), req({ nodes: ["lime-juice"], houseMade: true })],
    },
  ]);
  const [result] = computeMakeability(file, TAXONOMY, new Set());
  assert.equal(result!.unmet, 2);
  assert.equal(result!.unmetHouseMade, 1);
});

test("houseMade unmet requirements count toward unmetHouseMade, others do not", () => {
  const file = recipes([
    {
      slug: "a",
      name: "A",
      url: "u",
      requires: [req({ nodes: ["gin"], houseMade: false }), req({ nodes: ["vanilla-syrup"], houseMade: true })],
    },
  ]);
  const [result] = computeMakeability(file, TAXONOMY, new Set());
  assert.equal(result!.unmet, 2);
  assert.equal(result!.unmetHouseMade, 1);
});

test("results preserve the recipes' order", () => {
  const file = recipes([
    { slug: "b", name: "B", url: "u", requires: [] },
    { slug: "a", name: "A", url: "u", requires: [] },
  ]);
  const results = computeMakeability(file, TAXONOMY, new Set());
  assert.deepEqual(results.map((r) => r.slug), ["b", "a"]);
});

test("stapleIds returns every node with staple: true", () => {
  assert.deepEqual(TAXONOMY.stapleIds().sort(), ["salt", "simple-syrup"]);
});
