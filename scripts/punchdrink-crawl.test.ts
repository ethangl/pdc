#!/usr/bin/env tsx
// node:test cases for the pure helpers in scripts/lib/punchdrink-crawl.ts.
// Run with `pnpm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSlug,
  parseSitemapLocs,
  extractDataLayer,
  recipeNameFromHtml,
  selectNew,
  discoverViaAlgolia,
  discoverViaSitemap,
  fetchRecipePage,
  FetchBlockedError,
} from "./lib/punchdrink-crawl.js";

interface FakeCall {
  url: string;
  init?: RequestInit;
}

/** A `fetch` replacement that returns the given responses in order and
 * records the URL and init of every call. Throws if called more times than
 * there are queued responses. */
function fakeFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let next = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[next++];
    if (!response) throw new Error(`fakeFetch: no response queued for call ${calls.length}`);
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function algoliaPage(permalinks: string[], nbPages = 1): Response {
  return new Response(JSON.stringify({ hits: permalinks.map((permalink) => ({ permalink })), nbPages }), {
    status: 200,
  });
}

function sitemapXmlFor(slug: string): string {
  return `<urlset><url><loc>https://punchdrink.com/recipes/${slug}/</loc></url></urlset>`;
}

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

test("parseSitemapLocs strips a CDATA wrapper and still reads a plain loc", () => {
  const xml = `<urlset>
  <url><loc><![CDATA[https://punchdrink.com/recipes/mai-tai/]]></loc></url>
  <url><loc>https://punchdrink.com/recipes/negroni/</loc></url>
</urlset>`;
  assert.deepEqual(parseSitemapLocs(xml), [
    "https://punchdrink.com/recipes/mai-tai/",
    "https://punchdrink.com/recipes/negroni/",
  ]);
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

// --- recipeNameFromHtml ---

test("recipeNameFromHtml strips attributes and inner HTML from the first h1", () => {
  const html = `<div><h1 class="entry-title" id="title">100-pt <em>Julep</em></h1></div>`;
  assert.equal(recipeNameFromHtml(html), "100-pt Julep");
});

test("recipeNameFromHtml returns null when there is no h1", () => {
  const html = `<div><h2>Not an h1</h2></div>`;
  assert.equal(recipeNameFromHtml(html), null);
});

// --- selectNew ---

test("selectNew skips null slugs, already-seen slugs, and cached slugs, and stops at limit", () => {
  const urls = [
    "https://punchdrink.com/recipes/a/",
    "https://punchdrink.com/2024/not-a-recipe/",
    "https://punchdrink.com/recipes/a/", // duplicate
    "https://punchdrink.com/recipes/cached/",
    "https://punchdrink.com/recipes/b/",
    "https://punchdrink.com/recipes/c/",
  ];
  const seen = new Set<string>();
  const selected = selectNew(urls, seen, (slug) => slug === "cached", 2);

  assert.deepEqual(selected, [
    { url: "https://punchdrink.com/recipes/a/", slug: "a" },
    { url: "https://punchdrink.com/recipes/b/", slug: "b" },
  ]);
  assert.ok(seen.has("cached"), "a cached slug is still marked seen");
});

test("selectNew returns nothing when limit is 0", () => {
  const urls = ["https://punchdrink.com/recipes/a/"];
  const selected = selectNew(urls, new Set(), () => false, 0);
  assert.deepEqual(selected, []);
});

// --- discoverViaAlgolia ---

test("discoverViaAlgolia stops after a page (after page 0) adds zero new slugs", async () => {
  const { fetchImpl, calls } = fakeFetch([
    algoliaPage(["https://punchdrink.com/recipes/a/", "https://punchdrink.com/recipes/b/"]),
    algoliaPage(["https://punchdrink.com/recipes/a/", "https://punchdrink.com/recipes/b/"]), // all already seen
    algoliaPage(["https://punchdrink.com/recipes/c/"]), // would be new, but must not be reached
  ]);

  const discovered = await discoverViaAlgolia({ appId: "app", apiKey: "key", isCached: () => false, fetchImpl });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    discovered.map((r) => r.slug),
    ["a", "b"],
  );
});

test("discoverViaAlgolia does not stop on page 0 even if every hit is cached", async () => {
  const { fetchImpl, calls } = fakeFetch([
    algoliaPage(["https://punchdrink.com/recipes/cached-1/", "https://punchdrink.com/recipes/cached-2/"]),
    algoliaPage(["https://punchdrink.com/recipes/new/"]),
    algoliaPage([]), // empty hits ends the run
  ]);

  const discovered = await discoverViaAlgolia({
    appId: "app",
    apiKey: "key",
    isCached: (slug) => slug.startsWith("cached"),
    fetchImpl,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    discovered.map((r) => r.slug),
    ["new"],
  );
});

test("discoverViaAlgolia respects limit", async () => {
  const { fetchImpl, calls } = fakeFetch([
    algoliaPage([
      "https://punchdrink.com/recipes/a/",
      "https://punchdrink.com/recipes/b/",
      "https://punchdrink.com/recipes/c/",
    ]),
  ]);

  const discovered = await discoverViaAlgolia({
    appId: "app",
    apiKey: "key",
    isCached: () => false,
    limit: 1,
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    discovered.map((r) => r.slug),
    ["a"],
  );
});

test("discoverViaAlgolia skips cached and duplicate permalinks", async () => {
  const { fetchImpl } = fakeFetch([
    algoliaPage([
      "https://punchdrink.com/recipes/cached/",
      "https://punchdrink.com/recipes/cached/",
      "https://punchdrink.com/recipes/new/",
    ]),
    algoliaPage([]),
  ]);

  const discovered = await discoverViaAlgolia({
    appId: "app",
    apiKey: "key",
    isCached: (slug) => slug === "cached",
    fetchImpl,
  });

  assert.deepEqual(
    discovered.map((r) => r.slug),
    ["new"],
  );
});

// --- discoverViaSitemap ---

test("discoverViaSitemap fetches sitemap 1, 2, 3 and stops at the first non-ok response", async () => {
  const { fetchImpl, calls } = fakeFetch([
    new Response(sitemapXmlFor("a"), { status: 200 }),
    new Response(sitemapXmlFor("b"), { status: 200 }),
    new Response(sitemapXmlFor("c"), { status: 200 }),
    new Response("", { status: 404 }),
  ]);

  const discovered = await discoverViaSitemap({ isCached: () => false, fetchImpl });

  assert.equal(calls.length, 4);
  assert.deepEqual(
    discovered.map((r) => r.slug),
    ["a", "b", "c"],
  );
});

test("discoverViaSitemap applies limit and isCached", async () => {
  const xml = `<urlset>
    <url><loc>https://punchdrink.com/recipes/a/</loc></url>
    <url><loc>https://punchdrink.com/recipes/b/</loc></url>
    <url><loc>https://punchdrink.com/recipes/c/</loc></url>
  </urlset>`;
  const { fetchImpl } = fakeFetch([new Response(xml, { status: 200 }), new Response("", { status: 404 })]);

  const discovered = await discoverViaSitemap({
    isCached: (slug) => slug === "b",
    limit: 2,
    fetchImpl,
  });

  assert.deepEqual(
    discovered.map((r) => r.slug),
    ["a", "c"],
  );
});

test("discoverViaSitemap throws on a 404 for the first file", async () => {
  const { fetchImpl } = fakeFetch([new Response("", { status: 404 })]);

  await assert.rejects(() => discoverViaSitemap({ isCached: () => false, fetchImpl }), /Failed to fetch .* HTTP 404/);
});

test("discoverViaSitemap throws on a 500 for a later file", async () => {
  const { fetchImpl } = fakeFetch([new Response(sitemapXmlFor("a"), { status: 200 }), new Response("", { status: 500 })]);

  await assert.rejects(() => discoverViaSitemap({ isCached: () => false, fetchImpl }), /Failed to fetch .* HTTP 500/);
});

test("discoverViaSitemap throws when the sitemaps yield no recipe URLs", async () => {
  const { fetchImpl } = fakeFetch([new Response("<urlset></urlset>", { status: 200 }), new Response("", { status: 404 })]);

  await assert.rejects(
    () => discoverViaSitemap({ isCached: () => false, fetchImpl }),
    /No recipe URLs found in the sitemaps/,
  );
});

test("discoverViaSitemap sends the same desktop User-Agent as fetchRecipePage", async () => {
  const { fetchImpl: sitemapFetch, calls: sitemapCalls } = fakeFetch([
    new Response(sitemapXmlFor("a"), { status: 200 }),
    new Response("", { status: 404 }),
  ]);
  await discoverViaSitemap({ isCached: () => false, fetchImpl: sitemapFetch });

  const { fetchImpl: pageFetch, calls: pageCalls } = fakeFetch([new Response("<html>ok</html>", { status: 200 })]);
  await fetchRecipePage("https://punchdrink.com/recipes/a/", pageFetch);

  const headerValue = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.["User-Agent"];
  const sitemapUserAgent = headerValue(sitemapCalls[0].init);

  assert.ok(sitemapUserAgent, "sitemap request sent a User-Agent header");
  assert.equal(sitemapUserAgent, headerValue(pageCalls[0].init));
});

// --- fetchRecipePage ---

test("fetchRecipePage throws FetchBlockedError on 403 without retrying", async () => {
  const { fetchImpl, calls } = fakeFetch([new Response("", { status: 403 })]);

  await assert.rejects(() => fetchRecipePage("https://punchdrink.com/recipes/a/", fetchImpl), FetchBlockedError);
  assert.equal(calls.length, 1);
});

test("fetchRecipePage throws on 404 without retrying", async () => {
  const { fetchImpl, calls } = fakeFetch([new Response("", { status: 404 })]);

  await assert.rejects(
    () => fetchRecipePage("https://punchdrink.com/recipes/a/", fetchImpl),
    /Failed to fetch .* HTTP 404/,
  );
  assert.equal(calls.length, 1);
});

test("fetchRecipePage retries a 500 once and returns the body on the following 200", async () => {
  const { fetchImpl, calls } = fakeFetch([new Response("", { status: 500 }), new Response("<html>ok</html>", { status: 200 })]);

  const body = await fetchRecipePage("https://punchdrink.com/recipes/a/", fetchImpl, [0]);

  assert.equal(body, "<html>ok</html>");
  assert.equal(calls.length, 2);
});

test("fetchRecipePage retries when a 200 response's body stream errors, and returns the following 200's body", async () => {
  // A response whose body errors partway through the read (e.g. a dropped
  // connection while streaming), rather than failing at the fetch() call.
  const brokenBody = new ReadableStream({
    start(controller) {
      controller.error(new Error("stream broke"));
    },
  });
  const broken = new Response(brokenBody, { status: 200 });
  const { fetchImpl, calls } = fakeFetch([broken, new Response("<html>ok</html>", { status: 200 })]);

  const body = await fetchRecipePage("https://punchdrink.com/recipes/a/", fetchImpl, [0]);

  assert.equal(body, "<html>ok</html>");
  assert.equal(calls.length, 2);
});
