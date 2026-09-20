#!/usr/bin/env tsx
// node:test cases for the pure helpers in scripts/lib/punchdrink-crawl.ts.
// Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSlug, parseSitemapLocs, extractDataLayer, extractRecipeName } from "./lib/punchdrink-crawl.js";

// --- extractSlug ---

test("extractSlug reads the last path segment with a trailing slash", () => {
  assert.equal(extractSlug("https://punchdrink.com/recipes/100-pt-julep/"), "100-pt-julep");
});

test("extractSlug reads the last path segment without a trailing slash", () => {
  assert.equal(extractSlug("https://punchdrink.com/recipes/100-pt-julep"), "100-pt-julep");
});

test("extractSlug returns null for a non-recipe URL", () => {
  assert.equal(extractSlug("https://punchdrink.com/2024/01/01/some-article/"), null);
});

// --- parseSitemapLocs ---

test("parseSitemapLocs keeps recipe locs and drops the archive page and non-recipe locs", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://punchdrink.com/recipes/mai-tai/</loc></url>
  <url><loc>https://punchdrink.com/recipes/recipe-archives/</loc></url>
  <url><loc>https://punchdrink.com/2024/01/01/some-article/</loc></url>
</urlset>`;
  assert.deepEqual(parseSitemapLocs(xml), ["https://punchdrink.com/recipes/mai-tai/"]);
});

// --- extractDataLayer ---

test("extractDataLayer parses a balanced object with nested braces and a string containing a closing brace", () => {
  const html = `<html><head><script>
    var dataLayer_content = {"pageTitle": "A Drink", "nested": {"a": 1, "b": "text with } inside"}, "arr": [1, 2, 3]};
    var other = {};
  </script></head></html>`;
  assert.deepEqual(extractDataLayer(html), {
    pageTitle: "A Drink",
    nested: { a: 1, b: "text with } inside" },
    arr: [1, 2, 3],
  });
});

test("extractDataLayer handles an escaped quote inside a string", () => {
  const html = `var dataLayer_content = {"dek": "she said \\"hi\\" to me"};`;
  assert.deepEqual(extractDataLayer(html), { dek: 'she said "hi" to me' });
});

test("extractDataLayer throws a clear error when there is no data layer", () => {
  const html = `<html><body><h1>No Data Here</h1></body></html>`;
  assert.throws(() => extractDataLayer(html), /dataLayer_content not found/);
});

// --- extractRecipeName ---

test("extractRecipeName strips attributes and inner HTML from the first h1", () => {
  const html = `<div><h1 class="entry-title" id="title">100-pt <em>Julep</em></h1></div>`;
  assert.equal(extractRecipeName(html), "100-pt Julep");
});

test("extractRecipeName returns null when there is no h1", () => {
  const html = `<div><h2>Not an h1</h2></div>`;
  assert.equal(extractRecipeName(html), null);
});
