// Pure helpers and network-calling functions for scripts/crawl-punch.ts.
// Kept separate so the pure parsing logic (extractSlug, parseSitemapLocs,
// extractDataLayer, recipeNameFromHtml) can be unit-tested without a network.

import { stripHtml, type PunchdrinkDataLayer } from "./punchdrink-cache.js";

const ALGOLIA_INDEX = "wp_posts_recipe";
const ALGOLIA_HITS_PER_PAGE = 50;
const ALGOLIA_MAX_PAGES = 40;
const SITEMAP_URL_BASE = "https://punchdrink.com/recipe-sitemap";
// Safety bound on how many numbered sitemap files to try; the site has four
// today and a non-200 response ends the series long before this is reached.
const SITEMAP_MAX_FILES = 40;
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1000, 3000]; // two retries with backoff, on network errors and 5xx

// --- pure helpers ---

/** The last path segment of a `/recipes/<slug>/` URL, or null if the URL
 * does not look like a recipe page. */
export function extractSlug(url: string): string | null {
  const match = url.match(/\/recipes\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

/** `<loc>` URLs from a sitemap XML document that point at a recipe page
 * (contain `/recipes/`) and are not the archive listing page itself. Strips
 * an optional `<![CDATA[ ... ]]>` wrapper around the loc text first. */
export function parseSitemapLocs(xml: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)) {
    const cdata = match[1].match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    const url = (cdata ? cdata[1] : match[1]).trim();
    if (url.includes("/recipes/") && !url.endsWith("/recipe-archives/")) {
      urls.push(url);
    }
  }
  return urls;
}

/** Finds `dataLayer_content = ` in a recipe page's HTML and JSON-parses the
 * balanced `{...}` object that follows it (scanning for the matching closing
 * brace while respecting quoted strings, rather than a greedy regex, since
 * the payload can itself contain `}` inside a string). Throws with a clear
 * message when the marker, an opening brace, a balanced close, or valid JSON
 * is missing. */
export function extractDataLayer(html: string): PunchdrinkDataLayer {
  const marker = "dataLayer_content = ";
  const markerStart = html.indexOf(marker);
  if (markerStart === -1) {
    throw new Error("dataLayer_content not found in page HTML");
  }

  const braceStart = html.indexOf("{", markerStart + marker.length);
  if (braceStart === -1) {
    throw new Error("dataLayer_content has no opening brace");
  }

  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let braceEnd = -1;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) {
    throw new Error("dataLayer_content object is not balanced (no matching closing brace)");
  }

  const jsonText = html.slice(braceStart, braceEnd + 1);
  try {
    return JSON.parse(jsonText) as PunchdrinkDataLayer;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`dataLayer_content did not parse as JSON: ${message}`);
  }
}

/** The recipe title from the page's first `<h1 ...>...</h1>`, HTML-stripped
 * and trimmed. Null when the page has no `<h1>`. */
export function recipeNameFromHtml(html: string): string | null {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return null;
  const name = stripHtml(match[1]).trim();
  return name || null;
}

// --- discovery ---

interface AlgoliaHit {
  permalink: string;
}

interface AlgoliaQueryResponse {
  hits: AlgoliaHit[];
  nbPages: number;
}

/** One page of the Algolia `wp_posts_recipe` index, newest first. */
async function queryAlgoliaPage(
  appId: string,
  apiKey: string,
  page: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AlgoliaQueryResponse> {
  const response = await fetchImpl(`https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`, {
    method: "POST",
    headers: {
      "x-algolia-application-id": appId,
      "x-algolia-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hitsPerPage: ALGOLIA_HITS_PER_PAGE, page }),
  });
  if (!response.ok) {
    throw new Error(`Algolia query failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as AlgoliaQueryResponse;
}

export interface DiscoveredRecipe {
  url: string;
  slug: string;
}

/** The shared new-recipe selection step: for each URL, extracts the slug,
 * skips URLs with no slug, skips slugs already seen (marking new ones as
 * seen), and skips slugs already cached. Returns the rest, in order, up to
 * `limit`. Mutates `seen` so a caller can dedupe across repeated calls
 * (Algolia's cross-page dedupe). */
export function selectNew(
  urls: Iterable<string>,
  seen: Set<string>,
  isCached: (slug: string) => boolean,
  limit: number | undefined,
): DiscoveredRecipe[] {
  const selected: DiscoveredRecipe[] = [];
  for (const url of urls) {
    if (limit !== undefined && selected.length >= limit) break;
    const slug = extractSlug(url);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (isCached(slug)) continue;
    selected.push({ url, slug });
  }
  return selected;
}

export interface DiscoveryOptions {
  /** True when the slug is already present in the raw cache. */
  isCached: (slug: string) => boolean;
  /** Stop once this many new (uncached) slugs have been found. */
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface AlgoliaDiscoveryOptions extends DiscoveryOptions {
  appId: string;
  apiKey: string;
  onPage?: (info: { page: number; nbPages: number; totalSeen: number; newSlugs: number }) => void;
}

/** Pages through the Algolia index newest-first, collecting slugs not
 * already cached. Stops when a page (after page 0) adds zero new uncached
 * slugs, when `limit` new slugs have been found, or after `ALGOLIA_MAX_PAGES`. */
export async function discoverViaAlgolia(options: AlgoliaDiscoveryOptions): Promise<DiscoveredRecipe[]> {
  const { appId, apiKey, isCached, limit, onPage, fetchImpl = fetch } = options;

  const seen = new Set<string>();
  const discovered: DiscoveredRecipe[] = [];

  for (let page = 0; page < ALGOLIA_MAX_PAGES; page++) {
    const response = await queryAlgoliaPage(appId, apiKey, page, fetchImpl);
    if (response.hits.length === 0) break;

    const remaining = limit === undefined ? undefined : limit - discovered.length;
    const added = selectNew(
      response.hits.map((hit) => hit.permalink),
      seen,
      isCached,
      remaining,
    );
    discovered.push(...added);

    onPage?.({ page, nbPages: response.nbPages, totalSeen: seen.size, newSlugs: discovered.length });

    if (limit !== undefined && discovered.length >= limit) break;
    if (added.length === 0 && page > 0) break;
  }

  return discovered;
}

function sitemapUrl(n: number): string {
  return n === 1 ? `${SITEMAP_URL_BASE}.xml` : `${SITEMAP_URL_BASE}${n}.xml`;
}

/** Fetches recipe-sitemap.xml, recipe-sitemap2.xml, ... in order, sending
 * the same desktop User-Agent as recipe pages. A 404 on the second file or
 * later ends the series (the site simply has fewer sitemaps than
 * `SITEMAP_MAX_FILES`). Any other non-ok status, or a 404 on the first
 * file, throws `Error("Failed to fetch <url>: HTTP <status>")`. Throws
 * `Error("No recipe URLs found in the sitemaps")` when the series yields
 * none. Otherwise selects new (uncached) recipes from the concatenated URLs
 * in order. */
export async function discoverViaSitemap(options: DiscoveryOptions): Promise<DiscoveredRecipe[]> {
  const { isCached, limit, fetchImpl = fetch } = options;

  const urls: string[] = [];
  for (let n = 1; n <= SITEMAP_MAX_FILES; n++) {
    const url = sitemapUrl(n);
    const response = await fetchImpl(url, { headers: { "User-Agent": DESKTOP_USER_AGENT } });
    if (!response.ok) {
      if (response.status === 404 && n >= 2) break;
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    const xml = await response.text();
    urls.push(...parseSitemapLocs(xml));
  }

  if (urls.length === 0) {
    throw new Error("No recipe URLs found in the sitemaps");
  }

  return selectNew(urls, new Set<string>(), isCached, limit);
}

// --- fetching a recipe page ---

export class FetchBlockedError extends Error {
  constructor(status: number, url: string) {
    super(`Blocked fetching ${url}: HTTP ${status}`);
    this.name = "FetchBlockedError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one fetch attempt for `url`: owns the `AbortController`, its 30 s
 * timeout, and the response classification. Throws `FetchBlockedError` on
 * 403/429 and a plain `Error` on any other non-ok, non-5xx status; neither
 * retries. Returns (does not throw) an `Error` for a network error, an
 * abort, a 5xx response, or a body read that fails partway (e.g. a dropped
 * connection while streaming), so the caller can retry any of them the same
 * way. Returns the body string on ok. */
async function attemptFetch(url: string, fetchImpl: typeof fetch): Promise<string | Error> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": DESKTOP_USER_AGENT },
        signal: controller.signal,
      });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    if (response.status === 403 || response.status === 429) {
      throw new FetchBlockedError(response.status, url);
    }
    if (response.status >= 500) {
      return new Error(`Server error fetching ${url}: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }

    try {
      return await response.text();
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetches one recipe page's HTML with a desktop Chrome User-Agent. A 403
 * or 429 throws `FetchBlockedError` immediately, so the caller can stop the
 * whole run. Any other non-ok status (including 404) throws immediately
 * too. It will not resolve on retry. A network error, an abort, or a 5xx
 * response is retried, up to twice, with backoff.
 *
 * `retryDelaysMs` defaults to the real backoff and exists as a seam for
 * tests, which pass near-zero delays to exercise retries without waiting. */
export async function fetchRecipePage(
  url: string,
  fetchImpl: typeof fetch = fetch,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<string> {
  let result = await attemptFetch(url, fetchImpl);
  for (const delay of retryDelaysMs) {
    if (typeof result === "string") break;
    await sleep(delay);
    result = await attemptFetch(url, fetchImpl);
  }
  if (typeof result === "string") return result;
  throw result;
}
