#!/usr/bin/env tsx
// node:test cases for scripts/lib/data-files.ts. Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dropRemovedNodes, invalidOverrides, type ClassificationItem, type Overrides } from "./lib/data-files.js";
import { taxonomyFromRaw } from "./lib/taxonomy.js";

// --- a tiny stand-in taxonomy: one root with a child, one category ---

const taxonomy = taxonomyFromRaw({
  version: 1,
  nodes: [
    { id: "gin", name: "Gin" },
    { id: "london-dry-gin", name: "London Dry Gin", parent: "gin" },
    { id: "syrup", name: "Syrup", kind: "category" },
    { id: "simple-syrup", name: "Simple Syrup", parent: "syrup" },
  ],
});

function jevItem(core: string, node: string | null): ClassificationItem {
  return {
    core,
    count: 1,
    status: node === null ? "none" : "accepted",
    root: "gin",
    rootConfidence: 0.95,
    rootTop3: {},
    node,
    nodeConfidence: node === null ? null : 0.95,
    nodeTop3: null,
    nodeProbabilities: null,
    rawNodeChoice: node,
    collapsed: false,
    isBrand: 0,
    isHousePrep: 0,
    isGarnish: 0,
  };
}

// --- dropRemovedNodes ---

test("a record naming an existing node is kept", () => {
  const items = [jevItem("fancy gin", "london-dry-gin")];
  const { items: kept, droppedCores } = dropRemovedNodes(items, taxonomy);
  assert.deepEqual(kept, items);
  assert.deepEqual(droppedCores, []);
});

test("a record naming a removed node is dropped", () => {
  const items = [jevItem("old kummel", "kummel")];
  const { items: kept, droppedCores } = dropRemovedNodes(items, taxonomy);
  assert.deepEqual(kept, []);
  assert.deepEqual(droppedCores, ["old kummel"]);
});

test("an override record with node: null is kept", () => {
  const items: ClassificationItem[] = [{ core: "not an ingredient", count: 1, status: "override", node: null, root: null }];
  const { items: kept, droppedCores } = dropRemovedNodes(items, taxonomy);
  assert.deepEqual(kept, items);
  assert.deepEqual(droppedCores, []);
});

test("a none-status record with node: null is kept", () => {
  const items = [jevItem("moon dust", null)];
  const { items: kept, droppedCores } = dropRemovedNodes(items, taxonomy);
  assert.deepEqual(kept, items);
  assert.deepEqual(droppedCores, []);
});

// --- invalidOverrides ---

test("a valid overrides map reports nothing", () => {
  const overrides: Overrides = { gin: "london-dry-gin", "not an ingredient": null };
  assert.deepEqual(invalidOverrides(overrides, taxonomy), []);
});

test("an override naming an unknown node is reported", () => {
  const overrides: Overrides = { "old kummel": "kummel" };
  assert.deepEqual(invalidOverrides(overrides, taxonomy), ["old kummel -> kummel"]);
});

test("an override naming a category node is reported", () => {
  const overrides: Overrides = { "some syrup": "syrup" };
  assert.deepEqual(invalidOverrides(overrides, taxonomy), ["some syrup -> syrup"]);
});

test("a null override value is fine", () => {
  const overrides: Overrides = { "to top": null };
  assert.deepEqual(invalidOverrides(overrides, taxonomy), []);
});
