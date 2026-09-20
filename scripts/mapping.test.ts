#!/usr/bin/env tsx
// node:test cases for scripts/lib/mapping.ts. Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLine,
  dedupeRequirements,
  classificationLookup,
  type ResolveDeps,
  type LineResolution,
  type Requirement,
} from "./lib/mapping.js";
import type { PreprocessedIngredient } from "./lib/preprocess.js";
import type { ClassificationItem } from "./lib/data-files.js";

// --- a small in-memory taxonomy stand-in ---

const ALIASES: Record<string, string> = {
  gin: "gin",
  vodka: "vodka",
  "lime juice": "lime-juice",
  "mint leaf": "mint",
  "citrus fruit": "citrus", // resolves to a category
};

const CATEGORY_IDS = new Set(["citrus"]);

const OVERRIDES: Record<string, string | null> = {
  salt: "kosher-salt",
  "unicorn tears": null,
};

const CLASSIFICATIONS = new Map<string, { nodeId: string; source: "classification" | "fallback" }>([
  ["fancy gin", { nodeId: "gin", source: "classification" }],
  ["vanilla syrup", { nodeId: "vanilla-syrup", source: "classification" }],
  ["mystery syrup", { nodeId: "simple-syrup", source: "fallback" }],
]);

const deps: ResolveDeps = {
  overrides: OVERRIDES,
  classifications: CLASSIFICATIONS,
  resolveAlias: (core) => ALIASES[core],
  isCategory: (id) => CATEGORY_IDS.has(id),
};

function line(partial: {
  core: string;
  raw?: string;
  alternatives?: string[];
  flags?: Partial<PreprocessedIngredient["flags"]>;
}): PreprocessedIngredient {
  return {
    raw: partial.raw ?? partial.core,
    core: partial.core,
    alternatives: partial.alternatives,
    flags: { houseMade: false, optional: false, infused: false, garnishLike: false, ...partial.flags },
    removed: [],
  };
}

interface Case {
  name: string;
  input: PreprocessedIngredient;
  expectBucket: LineResolution["bucket"];
  expectNodes?: string[];
  expectHouseMade?: boolean;
  expectCategoryHits?: string[];
  expectUnresolvedAlternatives?: number;
  expectSubstitute?: boolean;
  expectDroppedReason?: "override" | "optional";
}

const cases: Case[] = [
  {
    name: "alias hit",
    input: line({ core: "lime juice" }),
    expectBucket: "requires",
    expectNodes: ["lime-juice"],
  },
  {
    name: "classification hit",
    input: line({ core: "fancy gin" }),
    expectBucket: "requires",
    expectNodes: ["gin"],
  },
  {
    name: "override to null drops a candidate",
    input: line({ core: "unicorn tears", alternatives: ["unicorn tears", "gin"] }),
    expectBucket: "requires",
    expectNodes: ["gin"],
    expectUnresolvedAlternatives: 0,
  },
  {
    name: "alternatives where one resolves",
    input: line({ core: "mystery liqueur", alternatives: ["mystery liqueur", "gin"] }),
    expectBucket: "requires",
    expectNodes: ["gin"],
    expectUnresolvedAlternatives: 1,
  },
  {
    name: "garnish goes to optional",
    input: line({ core: "mint leaf", flags: { garnishLike: true } }),
    expectBucket: "optional",
    expectNodes: ["mint"],
  },
  {
    name: ", to top goes to optional",
    input: line({ core: "gin", flags: { optional: true } }),
    expectBucket: "optional",
    expectNodes: ["gin"],
  },
  {
    name: "category hit is unresolved",
    input: line({ core: "citrus fruit" }),
    expectBucket: "unresolved",
    expectCategoryHits: ["citrus"],
  },
  {
    name: "houseMade from description",
    input: line({ core: "vanilla syrup", flags: { houseMade: true } }),
    expectBucket: "requires",
    expectNodes: ["vanilla-syrup"],
    expectHouseMade: true,
  },
  {
    name: "override to a node",
    input: line({ core: "salt" }),
    expectBucket: "requires",
    expectNodes: ["kosher-salt"],
  },
  {
    name: "fallback classification resolves as a substitute",
    input: line({ core: "mystery syrup" }),
    expectBucket: "requires",
    expectNodes: ["simple-syrup"],
    expectSubstitute: true,
  },
  {
    name: "no candidate resolves",
    input: line({ core: "moon dust" }),
    expectBucket: "unresolved",
  },
  {
    name: "line entirely dropped by null override",
    input: line({ core: "unicorn tears" }),
    expectBucket: "dropped",
    expectDroppedReason: "override",
  },
  {
    name: "garnish-like line with no resolution is dropped, not unresolved",
    input: line({ core: "moon dust", flags: { garnishLike: true } }),
    expectBucket: "dropped",
    expectDroppedReason: "optional",
  },
  {
    name: "optional line with no resolution is dropped, not unresolved",
    input: line({ core: "moon dust", flags: { optional: true } }),
    expectBucket: "dropped",
    expectDroppedReason: "optional",
  },
];

for (const testCase of cases) {
  test(testCase.name, () => {
    const result = resolveLine(testCase.input, deps);
    assert.equal(result.bucket, testCase.expectBucket);

    const requirement = "requirement" in result ? result.requirement : undefined;
    if (testCase.expectNodes) {
      assert.deepEqual(requirement?.nodes ?? [], testCase.expectNodes);
    }
    if (testCase.expectHouseMade !== undefined) {
      assert.equal(requirement?.houseMade, testCase.expectHouseMade);
    }
    if (testCase.expectCategoryHits) {
      assert.deepEqual(result.categoryHits, testCase.expectCategoryHits);
    }
    if (testCase.expectUnresolvedAlternatives !== undefined) {
      assert.equal(result.unresolvedAlternatives, testCase.expectUnresolvedAlternatives);
    }
    if (testCase.expectSubstitute !== undefined) {
      assert.equal(requirement?.substitute ?? false, testCase.expectSubstitute);
    }
    if (testCase.expectDroppedReason !== undefined) {
      assert.equal(result.bucket === "dropped" ? result.reason : undefined, testCase.expectDroppedReason);
    }
  });
}

// --- dedupeRequirements ---

test("dedupe of identical nodes", () => {
  const input: Requirement[] = [
    { nodes: ["gin"], houseMade: false, raw: "gin" },
    { nodes: ["lime-juice"], houseMade: false, raw: "lime juice" },
    { nodes: ["gin"], houseMade: true, raw: "London dry gin" },
  ];
  const result = dedupeRequirements(input);
  const expected = [
    { nodes: ["gin"], houseMade: true, raw: "gin" },
    { nodes: ["lime-juice"], houseMade: false, raw: "lime juice" },
  ];
  assert.deepEqual(result, expected);
});

// --- dedupeRequirements: substitute is ANDed across merged duplicates ---

test("dedupe ANDs substitute across merged duplicates", () => {
  const input: Requirement[] = [
    { nodes: ["simple-syrup"], houseMade: false, raw: "mystery syrup", substitute: true },
    { nodes: ["simple-syrup"], houseMade: false, raw: "simple syrup" },
  ];
  const result = dedupeRequirements(input);
  const expected = [{ nodes: ["simple-syrup"], houseMade: false, raw: "mystery syrup" }];
  assert.deepEqual(result, expected);
});

// --- classificationLookup: skips a classification naming a removed node ---

test("classificationLookup skips an accepted item whose node the taxonomy lacks", () => {
  const items: ClassificationItem[] = [
    { core: "fancy gin", count: 5, status: "accepted", root: "gin", rootConfidence: 0.95, rootTop3: {}, node: "gin", nodeConfidence: 0.95, nodeTop3: {}, nodeProbabilities: {}, rawNodeChoice: "gin", collapsed: false, isBrand: 0, isHousePrep: 0, isGarnish: 0 },
    { core: "old kummel", count: 2, status: "accepted", root: "liqueur", rootConfidence: 0.95, rootTop3: {}, node: "kummel", nodeConfidence: 0.95, nodeTop3: {}, nodeProbabilities: {}, rawNodeChoice: "kummel", collapsed: false, isBrand: 0, isHousePrep: 0, isGarnish: 0 },
  ];
  const hasNode = (id: string) => id !== "kummel"; // the taxonomy dropped "kummel"
  const { lookup, skipped } = classificationLookup(items, hasNode);
  assert.deepEqual([...lookup.keys()], ["fancy gin"]);
  assert.deepEqual(skipped, ["old kummel"]);
});
