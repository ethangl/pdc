#!/usr/bin/env tsx
// node:test cases for unknownIdsIn in scripts/lib/jev.ts. Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownIdsIn, type CachedResponse } from "./lib/jev.js";
import { taxonomyFromRaw } from "./lib/taxonomy.js";

// --- a tiny stand-in taxonomy: two roots, one with a child ---

const taxonomy = taxonomyFromRaw({
  version: 1,
  nodes: [
    { id: "gin", name: "Gin" },
    { id: "london-dry-gin", name: "London Dry Gin", parent: "gin" },
    { id: "vodka", name: "Vodka" },
  ],
});

/** Builds a CachedResponse-shaped object. The SDK's response types carry
 * more fields than unknownIdsIn reads; cast rather than construct them. */
function response(options: {
  rootChoice: string;
  rootProbabilities: Record<string, number>;
  nodeChoice?: string;
  nodeProbabilities?: Record<string, number>;
}): CachedResponse {
  const request1 = {
    answers: {
      root: { choice: options.rootChoice, confidence: 0.9, probabilities: options.rootProbabilities },
      isBrand: { noul: 0 },
      isHousePrep: { noul: 0 },
      isGarnish: { noul: 0 },
    },
  };
  const request2 =
    options.nodeChoice === undefined
      ? null
      : { answers: { node: { choice: options.nodeChoice, confidence: 0.9, probabilities: options.nodeProbabilities } } };
  return { request1, request2 } as unknown as CachedResponse;
}

test("all-known ids report nothing stale", () => {
  const cached = response({
    rootChoice: "gin",
    rootProbabilities: { gin: 0.9, vodka: 0.1 },
    nodeChoice: "london-dry-gin",
    nodeProbabilities: { "london-dry-gin": 0.9, gin: 0.05, none: 0.05 },
  });
  assert.deepEqual(unknownIdsIn(cached, taxonomy), []);
});

test("an unknown id in the node probabilities is reported", () => {
  const cached = response({
    rootChoice: "gin",
    rootProbabilities: { gin: 0.9, vodka: 0.1 },
    nodeChoice: "london-dry-gin",
    nodeProbabilities: { "london-dry-gin": 0.5, "unknown-gin-brand": 0.5 },
  });
  assert.deepEqual(unknownIdsIn(cached, taxonomy), ["unknown-gin-brand"]);
});

test("an unknown root choice is reported", () => {
  const cached = response({
    rootChoice: "removed-root",
    rootProbabilities: { gin: 0.4, vodka: 0.6 },
  });
  assert.deepEqual(unknownIdsIn(cached, taxonomy), ["removed-root"]);
});

test("request2: null with a valid root reports nothing stale", () => {
  const cached = response({
    rootChoice: "vodka",
    rootProbabilities: { gin: 0.1, vodka: 0.9 },
  });
  assert.deepEqual(unknownIdsIn(cached, taxonomy), []);
});

test('"none" is never reported', () => {
  const cached = response({
    rootChoice: "none",
    rootProbabilities: { gin: 0.4, vodka: 0.1, none: 0.5 },
    nodeChoice: "none",
    nodeProbabilities: { "london-dry-gin": 0.1, none: 0.9 },
  });
  assert.deepEqual(unknownIdsIn(cached, taxonomy), []);
});
