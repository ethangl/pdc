#!/usr/bin/env tsx
// node:test cases for scripts/lib/punchdrink-cache.ts's cache-file handling
// (cachedSlugs, cachedRecipes, writeCachedRecipe). Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cachedSlugs, cachedRecipes, writeCachedRecipe } from "./lib/punchdrink-cache.js";

/** A fresh temp cache directory for one test, removed afterwards. */
function withTempDir(run: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-cache-"));
    try {
      await run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// --- cachedSlugs ---

test(
  "cachedSlugs sorts by filename (with .json), not by the stripped slug",
  withTempDir((dir) => {
    // Regression guard: sorting the stripped slugs (rather than the
    // filenames) puts "alfonso" before "alfonso-x", because "." (the start
    // of ".json") sorts after "-". Sorting filenames first is what the
    // original crawler did, and pnpm extract's output must match it exactly.
    fs.writeFileSync(path.join(dir, "alfonso.json"), "{}");
    fs.writeFileSync(path.join(dir, "alfonso-xiii.json"), "{}");
    fs.writeFileSync(path.join(dir, "alfonso-x.json"), "{}");
    fs.writeFileSync(path.join(dir, ".hidden.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not json");

    assert.deepEqual(cachedSlugs(dir), ["alfonso-x", "alfonso-xiii", "alfonso"]);
  }),
);

test("cachedSlugs returns [] for a missing directory", () => {
  const missing = path.join(os.tmpdir(), "pdc-cache-does-not-exist");
  assert.deepEqual(cachedSlugs(missing), []);
});

// --- cachedRecipes ---

test(
  "cachedRecipes rejects when the cache directory is empty",
  withTempDir(async (dir) => {
    await assert.rejects(async () => {
      for await (const _recipe of cachedRecipes(dir)) {
        // unreachable
      }
    }, /is empty or missing\. Run pnpm crawl first\./);
  }),
);

// --- writeCachedRecipe ---

test(
  "writeCachedRecipe round-trips through cachedSlugs and leaves no .tmp file",
  withTempDir((dir) => {
    writeCachedRecipe("mai-tai", { pageTitle: "Mai Tai" }, dir);

    assert.deepEqual(cachedSlugs(dir), ["mai-tai"]);
    const entries = fs.readdirSync(dir);
    assert.ok(!entries.some((entry) => entry.endsWith(".tmp")), "no .tmp file left behind");
  }),
);
