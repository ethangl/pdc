// Pure helpers and network-calling functions for scripts/crawl-punch.ts.
// Kept separate so the pure parsing logic (extractSlug, parseSitemapLocs,
// extractDataLayer, extractRecipeName) can be unit-tested without a network.

import { stripHtml } from "./punchdrink-cache.js";

export const ALGOLIA_INDEX = "wp_posts_recipe";
export const ALGOLIA_HITS_PER_PAGE = 50;
export const ALGOLIA_MAX_PAGES = 40;
export const SITEMAP_URL_BASE = "https://punchdrink.com/recipe-sitemap";
// Safety bound on how many numbered sitemap files to try; the site has four
// today and a non-200 response ends the series long before this is reached.
const SITEMAP_MAX_FILES = 40;
export const DESKTOP_USER_AGENT =
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
 * (contain `/recipes/`) and are not the archive listing page itself. */
export function parseSitemapLocs(xml: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(/<loc>([^<]*)<\/loc>/g)) {
    const url = match[1].trim();
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
export function extractDataLayer(html: string): Record<string, unknown> {
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
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`dataLayer_content did not parse as JSON: ${message}`);
  }
}

/** The recipe title from the page's first `<h1 ...>...</h1>`, HTML-stripped
 * and trimmed. Null when the page has no `<h1>`. */
export function extractRecipeName(html: string): string | null {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return null;
  const name = stripHtml(match[1]).trim();
  return name || null;
}

// --- discovery ---

export interface AlgoliaHit {
  permalink: string;
  post_modified?: string;
  post_title?: string;
}

export interface AlgoliaQueryResponse {
  hits: AlgoliaHit[];
  nbPages: number;
}

/** One page of the Algolia `wp_posts_recipe` index, newest first. */
export async function queryAlgoliaPage(
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

export interface AlgoliaDiscoveryOptions {
  appId: string;
  apiKey: string;
  /** True when the slug is already present in the raw cache. */
  isCached: (slug: string) => boolean;
  /** Stop once this many new (uncached) slugs have been found. */
  limit?: number;
  maxPages?: number;
  onPage?: (info: { page: number; nbPages: number; totalSeen: number; newSlugs: number }) => void;
  fetchImpl?: typeof fetch;
}

/** Pages through the Algolia index newest-first, collecting slugs not
 * already cached. Stops when a page (after page 0) adds zero new uncached
 * slugs, when `limit` new slugs have been found, or after `maxPages`. */
export async function discoverViaAlgolia(options: AlgoliaDiscoveryOptions): Promise<DiscoveredRecipe[]> {
  const { appId, apiKey, isCached, limit, maxPages = ALGOLIA_MAX_PAGES, onPage, fetchImpl = fetch } = options;

  const seen = new Set<string>();
  const discovered: DiscoveredRecipe[] = [];

  for (let page = 0; page < maxPages; page++) {
    const response = await queryAlgoliaPage(appId, apiKey, page, fetchImpl);
    if (response.hits.length === 0) break;

    let newOnThisPage = 0;
    for (const hit of response.hits) {
      const slug = extractSlug(hit.permalink);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      if (isCached(slug)) continue;
      discovered.push({ url: hit.permalink, slug });
      newOnThisPage++;
    }

    onPage?.({ page, nbPages: response.nbPages, totalSeen: seen.size, newSlugs: discovered.length });

    if (limit !== undefined && discovered.length >= limit) break;
    if (newOnThisPage === 0 && page > 0) break;
  }

  return limit !== undefined ? discovered.slice(0, limit) : discovered;
}

function sitemapUrl(n: number): string {
  return n === 1 ? `${SITEMAP_URL_BASE}.xml` : `${SITEMAP_URL_BASE}${n}.xml`;
}

/** Fetches recipe-sitemap.xml, recipe-sitemap2.xml, ... in order, stopping
 * at the first non-200 response (a 404 on a later number ends the series). */
export async function discoverViaSitemap(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const urls: string[] = [];
  for (let n = 1; n <= SITEMAP_MAX_FILES; n++) {
    const url = sitemapUrl(n);
    const response = await fetchImpl(url);
    if (!response.ok) break;
    const xml = await response.text();
    urls.push(...parseSitemapLocs(xml));
  }
  return urls;
}

// --- fetching a recipe page ---

export class FetchBlockedError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`Blocked fetching ${url}: HTTP ${status}`);
    this.name = "FetchBlockedError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches one recipe page's HTML with a desktop Chrome User-Agent, a 30 s
 * timeout, and two retries with backoff on network errors and 5xx
 * responses. A 403 or 429 throws `FetchBlockedError` immediately, without
 * retrying, so the caller can stop the whole run. */
export async function fetchRecipePage(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": DESKTOP_USER_AGENT },
        signal: controller.signal,
      });

      if (response.status === 403 || response.status === 429) {
        throw new FetchBlockedError(response.status, url);
      }
      if (response.status >= 500) {
        throw new Error(`Server error fetching ${url}: HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
      }
      return await response.text();
    } catch (err) {
      if (err instanceof FetchBlockedError) throw err;
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
