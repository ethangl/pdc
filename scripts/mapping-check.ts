#!/usr/bin/env tsx
// Plain-script checks for scripts/lib/mapping.ts. No test framework: run
// with `pnpm mapping:check`, exits non-zero if any case fails.

import {
  resolveLine,
  dedupeRequirements,
  type ResolveDeps,
  type LineResolution,
  type Requirement,
} from "./lib/mapping.js";
import type { PreprocessedIngredient } from "./lib/preprocess.js";

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
  },
];

let failures = 0;

for (const testCase of cases) {
  const result = resolveLine(testCase.input, deps);
  const problems: string[] = [];

  if (result.bucket !== testCase.expectBucket) {
    problems.push(`bucket: expected ${testCase.expectBucket}, got ${result.bucket}`);
  }
  if (testCase.expectNodes) {
    const got = result.requirement?.nodes ?? [];
    if (JSON.stringify(got) !== JSON.stringify(testCase.expectNodes)) {
      problems.push(`nodes: expected ${JSON.stringify(testCase.expectNodes)}, got ${JSON.stringify(got)}`);
    }
  }
  if (testCase.expectHouseMade !== undefined && result.requirement?.houseMade !== testCase.expectHouseMade) {
    problems.push(`houseMade: expected ${testCase.expectHouseMade}, got ${result.requirement?.houseMade}`);
  }
  if (testCase.expectCategoryHits) {
    if (JSON.stringify(result.categoryHits) !== JSON.stringify(testCase.expectCategoryHits)) {
      problems.push(
        `categoryHits: expected ${JSON.stringify(testCase.expectCategoryHits)}, got ${JSON.stringify(result.categoryHits)}`
      );
    }
  }
  if (
    testCase.expectUnresolvedAlternatives !== undefined &&
    result.unresolvedAlternatives !== testCase.expectUnresolvedAlternatives
  ) {
    problems.push(
      `unresolvedAlternatives: expected ${testCase.expectUnresolvedAlternatives}, got ${result.unresolvedAlternatives}`
    );
  }
  if (testCase.expectSubstitute !== undefined) {
    const got = result.requirement?.substitute ?? false;
    if (got !== testCase.expectSubstitute) {
      problems.push(`substitute: expected ${testCase.expectSubstitute}, got ${got}`);
    }
  }

  if (problems.length > 0) {
    failures++;
    console.error(`FAIL: ${testCase.name}`);
    for (const problem of problems) console.error(`  ${problem}`);
  }
}

// --- dedupeRequirements ---

{
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
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    failures++;
    console.error("FAIL: dedupe of identical nodes");
    console.error(`  expected ${JSON.stringify(expected)}`);
    console.error(`  got      ${JSON.stringify(result)}`);
  }
}

// --- dedupeRequirements: substitute is ANDed across merged duplicates ---

{
  const input: Requirement[] = [
    { nodes: ["simple-syrup"], houseMade: false, raw: "mystery syrup", substitute: true },
    { nodes: ["simple-syrup"], houseMade: false, raw: "simple syrup" },
  ];
  const result = dedupeRequirements(input);
  const expected = [{ nodes: ["simple-syrup"], houseMade: false, raw: "mystery syrup" }];
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    failures++;
    console.error("FAIL: dedupe ANDs substitute across merged duplicates");
    console.error(`  expected ${JSON.stringify(expected)}`);
    console.error(`  got      ${JSON.stringify(result)}`);
  }
}

const totalCases = cases.length + 2;
console.log(`${totalCases - failures}/${totalCases} cases passed.`);

if (failures > 0) {
  process.exit(1);
}
