#!/usr/bin/env tsx
// Classifies preprocessed ingredient cores that curated/taxonomy.json's
// aliases do not already resolve, using Jev (typesafe.ai) via
// @typesafe-ai/sdk. See
// docs/DESIGN.md's "Classification" section for the pipeline this fits into.
//
// Run with `pnpm classify`. Flags:
//   --limit N       classify only the first N unresolved items by count desc
//   --min-count N   skip cores with count below N (default 1)
//   --refresh       bypass the cache and any kept prior output
//   --dry-run       print what would happen; make no API calls
//   --only-review   classify only items whose current committed status is
//                   "review" or "none" (for re-checking after a prompt change)
//   --rederive      rebuild every kept item's record from its cached Jev
//                   response instead of trusting the prior output file
//                   verbatim (for re-deriving status after a status-logic
//                   change, e.g. a new taxonomy fallback, with no API calls)

import * as fs from "node:fs";
import * as path from "node:path";
import { loadTaxonomy, type Taxonomy } from "./lib/taxonomy.js";
import { loadLocalEnv } from "./lib/env.js";
import { OVERRIDES_PATH, CLASSIFICATIONS_PATH, JEV_CACHE_DIR, REVIEW_DIR, INGREDIENTS_PREPROCESSED_PATH } from "./lib/paths.js";
import {
  MODEL,
  PROMPT_VERSION,
  buildState,
  buildRootQuestions,
  buildNodeQuestions,
  cacheKeyFor,
  buildRecord,
  errorRecord,
  overrideRecord,
  createJevClient,
  type PreprocessedItem,
  type CachedResponse,
  type ClassificationRecord,
  type ClassificationStatus,
} from "./lib/jev.js";

const PREPROCESSED_PATH = INGREDIENTS_PREPROCESSED_PATH;
const OUTPUT_PATH = CLASSIFICATIONS_PATH;
const CACHE_DIR = JEV_CACHE_DIR;
const REVIEW_PATH = path.join(REVIEW_DIR, "review.txt");
// Jev's documented limit is 1,200 requests/minute (20/s). 8 in flight stays
// well under that even at low per-request latency; 429s still back off via
// the SDK's default retry policy (respects Retry-After).
const CONCURRENCY = 8;

/** Runs `worker` over `items` with at most `concurrency` in flight at once. */
async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  const size = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: size }, () => runNext()));
}

interface Args {
  limit: number | null;
  minCount: number;
  refresh: boolean;
  dryRun: boolean;
  onlyReview: boolean;
  rederive: boolean;
}

function parseArgs(argv: string[]): Args {
  let limit: number | null = null;
  let minCount = 1;
  let refresh = false;
  let dryRun = false;
  let onlyReview = false;
  let rederive = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
      i++;
    } else if (argv[i] === "--min-count") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value >= 0) minCount = Math.floor(value);
      i++;
    } else if (argv[i] === "--refresh") {
      refresh = true;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--only-review") {
      onlyReview = true;
    } else if (argv[i] === "--rederive") {
      rederive = true;
    }
  }
  return { limit, minCount, refresh, dryRun, onlyReview, rederive };
}

interface PreprocessedFile {
  generatedAt: string;
  distinctCores: number;
  items: PreprocessedItem[];
}

/** The narrower shape committed to curated/classifications.json. */
interface OutputItem {
  core: string;
  count: number;
  status: ClassificationStatus;
  root: string | null;
  rootConfidence: number | null;
  node: string | null;
  nodeConfidence: number | null;
  rawNodeChoice: string | null;
  collapsed: boolean;
  isBrand: number | null;
  isHousePrep: number | null;
  isGarnish: number | null;
  rootTop3: Record<string, number> | null;
  nodeTop3: Record<string, number> | null;
  nodeProbabilities: Record<string, number> | null;
  fallbackApplied?: boolean;
}

interface OutputFile {
  generatedAt: string;
  taxonomyVersion: number;
  promptVersion: string;
  model: string;
  items: OutputItem[];
}

function toOutputItem(record: ClassificationRecord): OutputItem {
  return {
    core: record.core,
    count: record.count,
    status: record.status,
    root: record.root,
    rootConfidence: record.rootConfidence,
    node: record.node,
    nodeConfidence: record.nodeConfidence,
    rawNodeChoice: record.rawNodeChoice,
    collapsed: record.collapsed,
    isBrand: record.isBrand,
    isHousePrep: record.isHousePrep,
    isGarnish: record.isGarnish,
    rootTop3: record.rootTop3,
    nodeTop3: record.nodeTop3,
    nodeProbabilities: record.nodeProbabilities,
    ...(record.fallbackApplied ? { fallbackApplied: true } : {}),
  };
}

function loadOverrides(): Record<string, string | null> {
  if (!fs.existsSync(OVERRIDES_PATH)) {
    fs.writeFileSync(OVERRIDES_PATH, "{}\n", "utf8");
    return {};
  }
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
}

function loadExistingOutput(): OutputFile | null {
  if (!fs.existsSync(OUTPUT_PATH)) return null;
  return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
}

const STATUS_ORDER: Record<ClassificationStatus, number> = {
  override: 0,
  accepted: 1,
  fallback: 2,
  review: 3,
  none: 4,
  error: 5,
};

function sortItems(items: OutputItem[]): OutputItem[] {
  return [...items].sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return b.count - a.count;
  });
}

function selectUnresolvedItems(taxonomy: Taxonomy, items: PreprocessedItem[], args: Args): PreprocessedItem[] {
  const unresolved = items
    .filter((item) => taxonomy.resolveAlias(item.core) === undefined)
    .filter((item) => item.count >= args.minCount)
    .sort((a, b) => b.count - a.count);
  return args.limit !== null ? unresolved.slice(0, args.limit) : unresolved;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();

  const taxonomy = loadTaxonomy();
  const preprocessed = JSON.parse(fs.readFileSync(PREPROCESSED_PATH, "utf8")) as PreprocessedFile;
  const preprocessedByCore = new Map(preprocessed.items.map((item) => [item.core, item]));

  const overrides = loadOverrides();
  const existing = loadExistingOutput();
  const versionMatches = existing !== null && existing.taxonomyVersion === taxonomy.version && existing.promptVersion === PROMPT_VERSION;
  const priorMap = new Map<string, OutputItem>();
  if (versionMatches) {
    for (const item of existing!.items) priorMap.set(item.core, item);
  }
  const currentStatusByCore = new Map<string, ClassificationStatus>();
  if (existing) {
    for (const item of existing.items) currentStatusByCore.set(item.core, item.status);
  }

  let selected = selectUnresolvedItems(taxonomy, preprocessed.items, args);
  if (args.onlyReview) {
    selected = selected.filter((item) => {
      const status = currentStatusByCore.get(item.core);
      return status === "review" || status === "none";
    });
  }

  // Classify decisions, without calling the API yet.
  const toOverride: PreprocessedItem[] = [];
  const toKeep: OutputItem[] = [];
  const toRederive: PreprocessedItem[] = [];
  const toClassify: PreprocessedItem[] = [];
  for (const item of selected) {
    if (Object.prototype.hasOwnProperty.call(overrides, item.core)) {
      toOverride.push(item);
      continue;
    }
    if (!args.refresh && priorMap.has(item.core)) {
      if (args.rederive) {
        toRederive.push(item);
      } else {
        toKeep.push(priorMap.get(item.core)!);
      }
      continue;
    }
    toClassify.push(item);
  }

  if (args.dryRun) {
    console.log(`Items considered (unresolved, count >= ${args.minCount}): ${selected.length}`);
    console.log(`  Would apply overrides: ${toOverride.length}`);
    console.log(`  Would keep prior output (unchanged): ${toKeep.length}`);
    console.log(`  Would rederive from cache (no API calls): ${toRederive.length}`);
    console.log(`  Would classify via Jev: ${toClassify.length}`);
    console.log(`Estimated requests: up to ${toClassify.length * 2} (2 per item; fewer when root resolves to "none")`);
    return;
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!toClassify.length) {
    console.log("No items need API calls (overrides/cache/prior output cover the selection).");
  } else if (!apiKey) {
    console.error("TYPESAFE_API_KEY is not set (checked process.env and .env.local).");
    process.exit(1);
  }
  const client = apiKey ? createJevClient(apiKey) : null;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let cacheHits = 0;
  let apiCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const statusCounts: Record<ClassificationStatus, number> = {
    override: 0,
    accepted: 0,
    fallback: 0,
    review: 0,
    none: 0,
    error: 0,
  };
  const freshlyBuilt: OutputItem[] = [];

  for (const item of toOverride) {
    const nodeId = overrides[item.core];
    const record = overrideRecord(item, taxonomy, nodeId, new Date().toISOString());
    statusCounts[record.status]++;
    freshlyBuilt.push(toOutputItem(record));
  }

  // Rebuild each item's record from its cached Jev response, applying the
  // current status-derivation logic (e.g. a taxonomy fallback change)
  // without any new API calls.
  for (const item of toRederive) {
    const cacheKey = cacheKeyFor(item.core, taxonomy.version, PROMPT_VERSION);
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (!fs.existsSync(cachePath)) {
      // No cached response to rebuild from (unexpected for a previously
      // classified item): keep the prior record rather than losing it.
      const prior = priorMap.get(item.core)!;
      statusCounts[prior.status]++;
      freshlyBuilt.push(prior);
      continue;
    }
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedResponse;
    const record = buildRecord(item, cached, new Date().toISOString(), taxonomy);
    statusCounts[record.status]++;
    freshlyBuilt.push(toOutputItem(record));
  }

  let completed = 0;
  await runWithConcurrency(toClassify, CONCURRENCY, async (item) => {
    const cacheKey = cacheKeyFor(item.core, taxonomy.version, PROMPT_VERSION);
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

    let cached: CachedResponse | null = null;
    if (!args.refresh && fs.existsSync(cachePath)) {
      cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedResponse;
      cacheHits++;
    }

    let record: ClassificationRecord;
    if (cached) {
      record = buildRecord(item, cached, new Date().toISOString(), taxonomy);
    } else {
      try {
        const state = buildState(item);
        const request1 = await client!.systemOne({ state, questions: buildRootQuestions(taxonomy), model: MODEL });
        apiCalls++;
        inputTokens += request1.usage.input_tokens;
        outputTokens += request1.usage.output_tokens;

        let request2: CachedResponse["request2"] = null;
        const rootChoice = request1.answers.root.choice;
        if (rootChoice !== "none") {
          request2 = await client!.systemOne({ state, questions: buildNodeQuestions(taxonomy, rootChoice), model: MODEL });
          apiCalls++;
          inputTokens += request2.usage.input_tokens;
          outputTokens += request2.usage.output_tokens;
        }

        cached = { request1, request2 };
        fs.writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf8");
        record = buildRecord(item, cached, new Date().toISOString(), taxonomy);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record = errorRecord(item, message, new Date().toISOString());
      }
    }

    statusCounts[record.status]++;
    freshlyBuilt.push(toOutputItem(record));

    completed++;
    if (completed % 100 === 0 || completed === toClassify.length) {
      console.error(`  ...classified ${completed}/${toClassify.length}`);
    }
  });

  for (const item of toKeep) {
    statusCounts[item.status]++;
  }

  // Merge: prior items (version-matched) survive unless this run replaced them.
  const finalMap = new Map<string, OutputItem>(priorMap);
  for (const item of freshlyBuilt) finalMap.set(item.core, item);
  for (const item of toKeep) finalMap.set(item.core, item);
  // Refresh counts from the current preprocessed file where available.
  for (const [core, item] of finalMap) {
    const current = preprocessedByCore.get(core);
    if (current) item.count = current.count;
  }

  const output: OutputFile = {
    generatedAt: new Date().toISOString(),
    taxonomyVersion: taxonomy.version,
    promptVersion: PROMPT_VERSION,
    model: MODEL,
    items: sortItems([...finalMap.values()]),
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(`Items considered: ${selected.length}`);
  console.log(`  Overrides applied: ${toOverride.length}`);
  console.log(`  Kept from prior output: ${toKeep.length}`);
  console.log(`  Rederived from cache: ${toRederive.length}`);
  console.log(`  Cache hits: ${cacheHits}`);
  console.log(`  API calls made: ${apiCalls}`);
  if (apiCalls > 0) {
    console.log(`  Token usage: ${inputTokens} input, ${outputTokens} output`);
  }
  console.log("Status counts (this run's selection):");
  for (const status of Object.keys(statusCounts) as ClassificationStatus[]) {
    console.log(`  ${status}: ${statusCounts[status]}`);
  }
  const collapsedCount = freshlyBuilt.filter((item) => item.collapsed).length;
  console.log(`  collapsed (node raised to an ancestor): ${collapsedCount}`);
  console.log(`Wrote ${output.items.length} items to ${OUTPUT_PATH}`);
  console.log("");

  const REPORT_TOP_N = 40;
  const reviewItems = output.items.filter((item) => item.status === "review");
  const noneItems = output.items.filter((item) => item.status === "none");

  console.log(`Top ${Math.min(REPORT_TOP_N, reviewItems.length)} review items:`);
  for (const item of reviewItems.slice(0, REPORT_TOP_N)) console.log(reportRow(item));
  console.log("");

  console.log(`Top ${Math.min(REPORT_TOP_N, noneItems.length)} none items:`);
  for (const item of noneItems.slice(0, REPORT_TOP_N)) console.log(reportRow(item));
  console.log("");

  // output.items is already sorted by status then count desc (sortItems),
  // so a fallback-status slice is already in highest-count-first order.
  const FALLBACK_REPORT_TOP_N = 30;
  const fallbackItems = output.items.filter((item) => item.status === "fallback");
  console.log(`Top ${Math.min(FALLBACK_REPORT_TOP_N, fallbackItems.length)} fallback items:`);
  for (const item of fallbackItems.slice(0, FALLBACK_REPORT_TOP_N)) console.log(fallbackRow(item));
  console.log("");

  const rootDistribution = new Map<string, { items: number; occurrences: number }>();
  for (const item of output.items) {
    if (item.status !== "accepted" || !item.root) continue;
    const entry = rootDistribution.get(item.root) ?? { items: 0, occurrences: 0 };
    entry.items++;
    entry.occurrences += item.count;
    rootDistribution.set(item.root, entry);
  }
  const rootRows = [...rootDistribution.entries()].sort((a, b) => b[1].occurrences - a[1].occurrences);
  console.log("Accepted items by root category:");
  for (const [root, { items, occurrences }] of rootRows) {
    console.log(`  ${root}: ${items} cores, ${occurrences} occurrences`);
  }
  console.log("");

  const reviewAndNoneLines = [...reviewItems, ...noneItems].map(reportRow);
  fs.writeFileSync(REVIEW_PATH, reviewAndNoneLines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${reviewAndNoneLines.length} review+none lines to ${REVIEW_PATH}`);
}

function formatTop3(top3: Record<string, number> | null): string {
  if (!top3) return "-";
  return Object.entries(top3)
    .map(([label, probability]) => `${label}:${fmt(probability)}`)
    .join(", ");
}

/** `count core → node (root/node conf) raw choice`, per the fallback report brief. */
function fallbackRow(item: OutputItem): string {
  const rc = item.rootConfidence !== null ? fmt(item.rootConfidence) : "-";
  const nc = item.nodeConfidence !== null ? fmt(item.nodeConfidence) : "-";
  return `${item.count}\t${item.core}\t→\t${item.node} (${rc}/${nc})\t${item.rawNodeChoice ?? "-"}`;
}

function reportRow(item: OutputItem): string {
  const rc = item.rootConfidence !== null ? fmt(item.rootConfidence) : "-";
  const nc = item.nodeConfidence !== null ? fmt(item.nodeConfidence) : "-";
  const top3 = formatTop3(item.nodeTop3 ?? item.rootTop3);
  return `${item.count}\t${item.core}\t→\t${item.node ?? "(root none)"} (${rc}/${nc})\t| ${top3}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
