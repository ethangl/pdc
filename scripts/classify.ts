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

import * as fs from "node:fs";
import * as path from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadTaxonomy, type Taxonomy } from "./lib/taxonomy.js";
import { loadLocalEnv } from "./lib/env.js";
import { CLASSIFICATIONS_PATH, JEV_CACHE_DIR, REVIEW_DIR } from "./lib/paths.js";
import {
  MODEL,
  PROMPT_VERSION,
  buildState,
  buildRootQuestions,
  buildNodeQuestions,
  buildRecord,
  errorRecord,
  overrideRecord,
  createJevClient,
  readJevCache,
  writeJevCache,
  type CachedResponse,
} from "./lib/jev.js";
import {
  readPreprocessed,
  readOverrides,
  readClassifications,
  writeJson,
  type PreprocessedItem,
  type ClassificationItem,
  type ClassificationsFile,
  type ClassificationStatus,
} from "./lib/data-files.js";

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
}

function parseArgs(argv: string[]): Args {
  let limit: number | null = null;
  let minCount = 1;
  let refresh = false;
  let dryRun = false;
  let onlyReview = false;
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
    }
  }
  return { limit, minCount, refresh, dryRun, onlyReview };
}

const STATUS_ORDER: Record<ClassificationStatus, number> = {
  override: 0,
  accepted: 1,
  fallback: 2,
  review: 3,
  none: 4,
  error: 5,
};

function sortItems(items: ClassificationItem[]): ClassificationItem[] {
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

interface ApiResult {
  record: ClassificationItem;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Runs the two-request Jev classification for one item and writes its cache
 * entry. A request failure becomes an error record (logged once to stderr)
 * rather than propagating. */
async function classifyViaApi(client: TypeSafeClient, item: PreprocessedItem, taxonomy: Taxonomy): Promise<ApiResult> {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const state = buildState(item);
    const request1 = await client.systemOne({ state, questions: buildRootQuestions(taxonomy), model: MODEL });
    calls++;
    inputTokens += request1.usage.input_tokens;
    outputTokens += request1.usage.output_tokens;

    let request2: CachedResponse["request2"] = null;
    const rootChoice = request1.answers.root.choice;
    if (rootChoice !== "none") {
      request2 = await client.systemOne({ state, questions: buildNodeQuestions(taxonomy, rootChoice), model: MODEL });
      calls++;
      inputTokens += request2.usage.input_tokens;
      outputTokens += request2.usage.output_tokens;
    }

    const cached: CachedResponse = { request1, request2 };
    writeJevCache(item.core, taxonomy, cached);
    return { record: buildRecord(item, cached, taxonomy), calls, inputTokens, outputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${item.core}: ${message}`);
    return { record: errorRecord(item), calls, inputTokens, outputTokens };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();

  const taxonomy = loadTaxonomy();
  const preprocessed = readPreprocessed();
  const preprocessedByCore = new Map(preprocessed.items.map((item) => [item.core, item]));

  const overrides = readOverrides();
  const existing = readClassifications();
  const priorMap = new Map<string, ClassificationItem>();
  if (existing && existing.taxonomyVersion === taxonomy.version && existing.promptVersion === PROMPT_VERSION) {
    for (const item of existing.items) priorMap.set(item.core, item);
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

  // Classify decisions, without calling the API yet. For each selected item
  // that is not an override: refresh forces the API; otherwise a cached Jev
  // response wins (rebuild is a pure function of the cache and the current
  // taxonomy/status logic), else the prior committed item survives verbatim,
  // else the API is called.
  const toOverride: PreprocessedItem[] = [];
  const toRebuild: { item: PreprocessedItem; cached: CachedResponse }[] = [];
  const toKeep: ClassificationItem[] = [];
  const toClassify: PreprocessedItem[] = [];
  for (const item of selected) {
    if (Object.prototype.hasOwnProperty.call(overrides, item.core)) {
      toOverride.push(item);
      continue;
    }
    if (!args.refresh) {
      const cached = readJevCache(item.core, taxonomy);
      if (cached) {
        toRebuild.push({ item, cached });
        continue;
      }
      const prior = priorMap.get(item.core);
      if (prior) {
        toKeep.push(prior);
        continue;
      }
    }
    toClassify.push(item);
  }

  if (args.dryRun) {
    console.log(`Items considered (unresolved, count >= ${args.minCount}): ${selected.length}`);
    console.log(`  Would apply overrides: ${toOverride.length}`);
    console.log(`  Would rederive from cache (no API calls): ${toRebuild.length}`);
    console.log(`  Would keep prior output, no cache: ${toKeep.length}`);
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

  fs.mkdirSync(JEV_CACHE_DIR, { recursive: true });

  let apiCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const freshlyBuilt: ClassificationItem[] = [];

  for (const item of toOverride) {
    const nodeId = overrides[item.core];
    freshlyBuilt.push(overrideRecord(item, taxonomy, nodeId));
  }

  for (const { item, cached } of toRebuild) {
    freshlyBuilt.push(buildRecord(item, cached, taxonomy));
  }

  let completed = 0;
  await runWithConcurrency(toClassify, CONCURRENCY, async (item) => {
    const result = await classifyViaApi(client!, item, taxonomy);
    apiCalls += result.calls;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    freshlyBuilt.push(result.record);

    completed++;
    if (completed % 100 === 0 || completed === toClassify.length) {
      console.error(`  ...classified ${completed}/${toClassify.length}`);
    }
  });

  // Merge: prior items (version-matched) survive unless this run replaced them.
  const finalMap = new Map<string, ClassificationItem>(priorMap);
  for (const item of freshlyBuilt) finalMap.set(item.core, item);
  for (const item of toKeep) finalMap.set(item.core, item);
  // Refresh counts from the current preprocessed file where available.
  for (const [core, item] of finalMap) {
    const current = preprocessedByCore.get(core);
    if (current) item.count = current.count;
  }

  const output: ClassificationsFile = {
    generatedAt: new Date().toISOString(),
    taxonomyVersion: taxonomy.version,
    promptVersion: PROMPT_VERSION,
    model: MODEL,
    items: sortItems([...finalMap.values()]),
  };
  writeJson(CLASSIFICATIONS_PATH, output);

  const statusCounts: Record<ClassificationStatus, number> = {
    override: 0,
    accepted: 0,
    fallback: 0,
    review: 0,
    none: 0,
    error: 0,
  };
  for (const record of [...freshlyBuilt, ...toKeep]) statusCounts[record.status]++;
  const collapsedCount = freshlyBuilt.filter((item) => item.collapsed).length;

  printReport(output, {
    selected: selected.length,
    overrides: toOverride.length,
    rebuilt: toRebuild.length,
    kept: toKeep.length,
    apiCalls,
    inputTokens,
    outputTokens,
    statusCounts,
    collapsedCount,
  });
}

interface RunStats {
  selected: number;
  overrides: number;
  rebuilt: number;
  kept: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  statusCounts: Record<ClassificationStatus, number>;
  collapsedCount: number;
}

/** Everything printed and written after curated/classifications.json itself:
 * the run summary, the review/none/fallback tables, the root distribution,
 * and data/cache/review.txt. */
function printReport(output: ClassificationsFile, stats: RunStats): void {
  console.log(`Items considered: ${stats.selected}`);
  console.log(`  Overrides applied: ${stats.overrides}`);
  console.log(`  Rederived from cache: ${stats.rebuilt}`);
  console.log(`  Kept from prior, no cache: ${stats.kept}`);
  console.log(`  API calls made: ${stats.apiCalls}`);
  if (stats.apiCalls > 0) {
    console.log(`  Token usage: ${stats.inputTokens} input, ${stats.outputTokens} output`);
  }
  console.log("Status counts (this run's selection):");
  for (const status of Object.keys(stats.statusCounts) as ClassificationStatus[]) {
    console.log(`  ${status}: ${stats.statusCounts[status]}`);
  }
  console.log(`  collapsed (node raised to an ancestor): ${stats.collapsedCount}`);
  console.log(`Wrote ${output.items.length} items to ${CLASSIFICATIONS_PATH}`);
  console.log("");

  const REPORT_TOP_N = 40;
  const reviewItems = output.items.filter((item) => item.status === "review");
  const noneItems = output.items.filter((item) => item.status === "none");

  console.log(`Top ${Math.min(REPORT_TOP_N, reviewItems.length)} review items:`);
  for (const item of reviewItems.slice(0, REPORT_TOP_N)) console.log(reviewRow(item));
  console.log("");

  console.log(`Top ${Math.min(REPORT_TOP_N, noneItems.length)} none items:`);
  for (const item of noneItems.slice(0, REPORT_TOP_N)) console.log(reviewRow(item));
  console.log("");

  // output.items is already sorted by status then count desc (sortItems),
  // so a fallback-status slice is already in highest-count-first order.
  const FALLBACK_REPORT_TOP_N = 30;
  const fallbackItems = output.items.filter((item) => item.status === "fallback");
  console.log(`Top ${Math.min(FALLBACK_REPORT_TOP_N, fallbackItems.length)} fallback items:`);
  for (const item of fallbackItems.slice(0, FALLBACK_REPORT_TOP_N)) console.log(row(item, item.rawNodeChoice ?? "-"));
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

  const reviewAndNoneLines = [...reviewItems, ...noneItems].map(reviewRow);
  fs.writeFileSync(REVIEW_PATH, reviewAndNoneLines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${reviewAndNoneLines.length} review+none lines to ${REVIEW_PATH}`);
}

function formatTop3(top3: Record<string, number> | null): string {
  if (!top3) return "-";
  return Object.entries(top3)
    .map(([label, probability]) => `${label}:${fmt(probability)}`)
    .join(", ");
}

/** `count core → node (root/node conf) tail`, shared by the review/none and fallback tables. */
function row(item: ClassificationItem, tail: string): string {
  const rc = item.rootConfidence !== null ? fmt(item.rootConfidence) : "-";
  const nc = item.nodeConfidence !== null ? fmt(item.nodeConfidence) : "-";
  return `${item.count}\t${item.core}\t→\t${item.node ?? "(root none)"} (${rc}/${nc})\t${tail}`;
}

/** A review or none row: the row plus the top-3 probabilities of the deepest answered question. */
function reviewRow(item: ClassificationItem): string {
  return row(item, `| ${formatTop3(item.nodeTop3 ?? item.rootTop3)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
