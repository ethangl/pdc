#!/usr/bin/env tsx
// node:test cases for unknownIdsIn in scripts/lib/jev.ts. Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownIdsIn, decide, type CachedResponse } from "./lib/jev.js";
import { taxonomyFromRaw } from "./lib/taxonomy.js";
import type { ClassificationItem } from "./lib/data-files.js";

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

// --- decide ---

const priorAccepted = { core: "fancy gin", count: 5, status: "accepted" } as unknown as ClassificationItem;
const priorError = { core: "fancy gin", count: 5, status: "error" } as unknown as ClassificationItem;

function failingReadCache(): never {
  throw new Error("readCache should not be called");
}

test("an override never reaches the API", () => {
  const decision = decide({ overridden: true, refresh: true, readCache: failingReadCache, prior: priorAccepted });
  assert.deepEqual(decision, { kind: "override" });
});

test("--refresh always asks, without reading the cache", () => {
  const decision = decide({ overridden: false, refresh: true, readCache: failingReadCache, prior: priorAccepted });
  assert.deepEqual(decision, { kind: "ask", reason: "refresh", unknownIds: [] });
});

test("a cache hit rebuilds", () => {
  const cached = response({ rootChoice: "vodka", rootProbabilities: { gin: 0.1, vodka: 0.9 } });
  const decision = decide({
    overridden: false,
    refresh: false,
    readCache: () => ({ status: "hit", response: cached }),
    prior: undefined,
  });
  assert.deepEqual(decision, { kind: "rebuild", cached });
});

test("a stale cache entry asks even when a prior exists", () => {
  const decision = decide({
    overridden: false,
    refresh: false,
    readCache: () => ({ status: "stale", unknownIds: ["kummel"] }),
    prior: priorAccepted,
  });
  assert.deepEqual(decision, { kind: "ask", reason: "stale", unknownIds: ["kummel"] });
});

test("a cache miss keeps a non-error prior", () => {
  const decision = decide({
    overridden: false,
    refresh: false,
    readCache: () => ({ status: "miss" }),
    prior: priorAccepted,
  });
  assert.deepEqual(decision, { kind: "keep", prior: priorAccepted });
});

test("a cache miss with no usable prior asks (no prior, or an error prior)", () => {
  const noPrior = decide({ overridden: false, refresh: false, readCache: () => ({ status: "miss" }), prior: undefined });
  assert.deepEqual(noPrior, { kind: "ask", reason: "miss", unknownIds: [] });

  const errorPrior = decide({ overridden: false, refresh: false, readCache: () => ({ status: "miss" }), prior: priorError });
  assert.deepEqual(errorPrior, { kind: "ask", reason: "miss", unknownIds: [] });
});
