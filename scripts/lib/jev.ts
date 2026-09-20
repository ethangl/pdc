// Jev (typesafe.ai) client construction, question builders, and answer
// parsing for scripts/classify.ts. Keeps classify.ts a thin driver.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TypeSafeClient, choice, noul, type ChoiceCriteria, type SystemOneResult } from "@typesafe-ai/sdk";
import type { Taxonomy } from "./taxonomy.js";
import { JEV_CACHE_DIR } from "./paths.js";
import {
  writeJson,
  type PreprocessedItem,
  type OverrideClassification,
  type JevClassification,
  type ClassificationItem,
} from "./data-files.js";

export const MODEL = "jev-latest";
export const PROMPT_VERSION = "2";
const CONFIDENCE_THRESHOLD = 0.9;
const NONE = "none";

export function createJevClient(apiKey: string): TypeSafeClient {
  return new TypeSafeClient({ apiKey, defaultModel: MODEL });
}

/** The state text describing one item, shared by both requests. */
export function buildState(item: PreprocessedItem): string {
  const variants = item.rawVariants.filter((variant) => variant !== item.core).slice(0, 3);
  let state = `Cocktail recipe ingredient: "${item.core}"`;
  if (variants.length > 0) {
    state += `\nAlso written in recipes as: ${variants.map((variant) => `"${variant}"`).join("; ")}`;
  }
  return state;
}

function topExampleNames(taxonomy: Taxonomy, id: string, limit: number): string {
  return taxonomy
    .childrenOf(id)
    .slice(0, limit)
    .map((childId) => taxonomy.node(childId).name)
    .join(", ");
}

function rootCriteria(taxonomy: Taxonomy): ChoiceCriteria {
  const criteria: Record<string, string> = {};
  for (const rootId of taxonomy.roots) {
    const node = taxonomy.node(rootId);
    const examples = topExampleNames(taxonomy, rootId, 6);
    criteria[rootId] = taxonomy.isCategory(rootId)
      ? `${node.name}: e.g. ${examples}`
      : `${node.name} and its styles: e.g. ${examples}`;
  }
  criteria[NONE] = "Not a recognizable ingredient, or a bar-specific preparation with no generic equivalent";
  return criteria;
}

/** Request 1's questions: root family, plus brand/house-prep/garnish flags. */
export function buildRootQuestions(taxonomy: Taxonomy) {
  return {
    root: choice("Which family does this ingredient belong to?", rootCriteria(taxonomy)),
    isBrand: noul("Is this primarily a brand or product name rather than a generic ingredient?"),
    isHousePrep: noul(
      "Is this a house-made preparation specific to a bar (a custom mix, batch, or syrup blend) rather than a standard ingredient?",
    ),
    isGarnish: noul("Is this used only as a garnish?"),
  };
}

function nodeCriteria(taxonomy: Taxonomy, rootId: string): ChoiceCriteria {
  const candidateIds = taxonomy.descendantsOf(rootId).filter((id) => !taxonomy.isCategory(id));
  if (!taxonomy.isCategory(rootId)) candidateIds.unshift(rootId);

  const criteria: Record<string, string> = {};
  for (const id of candidateIds) {
    const node = taxonomy.node(id);
    const hasChildren = taxonomy.childrenOf(id).length > 0;
    let description = hasChildren ? `${node.name} (generic, any style)` : node.name;
    if (node.aliases && node.aliases.length > 0) {
      description += `; also: ${node.aliases.slice(0, 4).join(", ")}`;
    }
    criteria[id] = description;
  }
  criteria[NONE] = "Does not belong to this family";
  return criteria;
}

/** Request 2's question: the specific node within the chosen root's subtree. */
export function buildNodeQuestions(taxonomy: Taxonomy, rootId: string) {
  return {
    node: choice(
      "Which specific ingredient is this? Choose the most specific option the text supports. " +
        "If it is a brand or product that belongs to this family but matches no specific option, " +
        "choose the generic option, not none. Choose none only when it does not belong to this family at all.",
      nodeCriteria(taxonomy, rootId),
    ),
  };
}

export type RootQuestions = ReturnType<typeof buildRootQuestions>;
export type NodeQuestions = ReturnType<typeof buildNodeQuestions>;

/** Raw shape stored on disk under data/cache/jev/<key>.json. */
export interface CachedResponse {
  request1: SystemOneResult<RootQuestions>;
  request2: SystemOneResult<NodeQuestions> | null;
}

/** A cache key stable across reruns, tied to the taxonomy version and
 * prompt version. It deliberately ignores tree shape: adding or removing a
 * node no longer invalidates the whole cache. A cached response that names
 * a node the current tree lacks is instead caught on read, by
 * `unknownIdsIn`. */
function cacheKeyFor(core: string, taxonomy: Taxonomy): string {
  return crypto.createHash("sha1").update(`${core}|${taxonomy.version}|${PROMPT_VERSION}`).digest("hex");
}

function cachePathFor(core: string, taxonomy: Taxonomy): string {
  return path.join(JEV_CACHE_DIR, `${cacheKeyFor(core, taxonomy)}.json`);
}

/**
 * Node ids a cached response refers to that the taxonomy no longer has.
 * Empty means the response is usable. Checks the root answer's
 * probabilities and choice, and, when present, the node answer's
 * probabilities and choice. A new node the cached response simply did not
 * have as an option is NOT stale: that additive drift is accepted, which is
 * the whole point of dropping the structure hash from the cache key. "none"
 * is a sentinel, never a real node id, so it is never reported.
 */
export function unknownIdsIn(response: CachedResponse, taxonomy: Taxonomy): string[] {
  const unknown = new Set<string>();

  function check(id: string): void {
    if (id !== NONE && !taxonomy.nodes.has(id)) unknown.add(id);
  }

  const rootAnswer = response.request1.answers.root;
  for (const id of Object.keys(rootAnswer.probabilities)) check(id);
  check(rootAnswer.choice);

  if (response.request2) {
    const nodeAnswer = response.request2.answers.node;
    for (const id of Object.keys(nodeAnswer.probabilities)) check(id);
    check(nodeAnswer.choice);
  }

  return [...unknown];
}

export type CacheRead =
  | { status: "hit"; response: CachedResponse }
  | { status: "stale"; unknownIds: string[] }
  | { status: "miss" };

/** Reads the cached Jev response for `core`, validating it against the
 * current taxonomy. "stale" means the response names node ids the taxonomy
 * no longer has (see `unknownIdsIn`); the caller should re-ask rather than
 * rebuild from it. */
export function readJevCache(core: string, taxonomy: Taxonomy): CacheRead {
  const cachePath = cachePathFor(core, taxonomy);
  if (!fs.existsSync(cachePath)) return { status: "miss" };
  const response = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedResponse;
  const unknownIds = unknownIdsIn(response, taxonomy);
  if (unknownIds.length > 0) return { status: "stale", unknownIds };
  return { status: "hit", response };
}

export function writeJevCache(core: string, taxonomy: Taxonomy, response: CachedResponse): void {
  writeJson(cachePathFor(core, taxonomy), response);
}

export type Decision =
  | { kind: "override" }
  | { kind: "rebuild"; cached: CachedResponse }
  | { kind: "keep"; prior: ClassificationItem }
  | { kind: "ask"; reason: "refresh" | "stale" | "miss"; unknownIds: string[] };

/** What to do with one selected item. Rules, in order: an override never
 * reaches the API; --refresh always asks; a cache hit rebuilds; a stale
 * cache entry asks even when a prior exists (the prior came from the same
 * response); a cache miss keeps a prior unless it is an error record;
 * otherwise ask. */
export function decide(input: {
  overridden: boolean;
  refresh: boolean;
  readCache: () => CacheRead;
  prior: ClassificationItem | undefined;
}): Decision {
  if (input.overridden) return { kind: "override" };
  if (input.refresh) return { kind: "ask", reason: "refresh", unknownIds: [] };

  const cacheRead = input.readCache();
  if (cacheRead.status === "hit") return { kind: "rebuild", cached: cacheRead.response };
  if (cacheRead.status === "stale") return { kind: "ask", reason: "stale", unknownIds: cacheRead.unknownIds };

  if (input.prior && input.prior.status !== "error") return { kind: "keep", prior: input.prior };
  return { kind: "ask", reason: "miss", unknownIds: [] };
}

function top3(probabilities: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3));
}

/**
 * Sum of `nodeId`'s own probability plus every other candidate that is a
 * descendant of it. Low confidence on a specific node is often the model's
 * probability mass split between that node and an ancestor (a brand that
 * could be "gin" in general or "london dry gin" specifically); this measures
 * how much mass a whole ancestor subtree carries, not just one leaf.
 */
function subtreeMass(taxonomy: Taxonomy, nodeId: string, probabilities: Record<string, number>, candidateIds: Set<string>): number {
  let mass = probabilities[nodeId] ?? 0;
  for (const descendantId of taxonomy.descendantsOf(nodeId)) {
    if (candidateIds.has(descendantId)) mass += probabilities[descendantId] ?? 0;
  }
  return mass;
}

interface CollapsedNode {
  node: string;
  nodeConfidence: number;
  collapsed: boolean;
}

/**
 * Walks from the raw node choice up its ancestor chain (most specific
 * first), looking for the deepest ancestor whose subtree mass reaches the
 * acceptance threshold. If one exists, that becomes the reported node. If
 * none does, falls back to the ancestor with the greatest subtree mass
 * (subtree mass is non-decreasing going up the chain, so that is the
 * topmost candidate) so review items still show their best-supported family
 * rather than a low-confidence leaf.
 */
function collapseNode(taxonomy: Taxonomy, rawChoice: string, probabilities: Record<string, number>): CollapsedNode {
  if (rawChoice === NONE) {
    return { node: NONE, nodeConfidence: probabilities[NONE] ?? 0, collapsed: false };
  }

  const candidateIds = new Set(Object.keys(probabilities).filter((id) => id !== NONE));
  const chain = [rawChoice, ...taxonomy.ancestorsOf(rawChoice)].filter((id) => candidateIds.has(id));

  let best: { node: string; mass: number } | null = null;
  for (const id of chain) {
    const mass = subtreeMass(taxonomy, id, probabilities, candidateIds);
    if (!best || mass > best.mass) best = { node: id, mass };
    if (mass >= CONFIDENCE_THRESHOLD) break;
  }

  return { node: best!.node, nodeConfidence: best!.mass, collapsed: best!.node !== rawChoice };
}

/**
 * The status for a root/node answer pair, with the family fallback applied
 * when the node question did not resolve. A string the classifier
 * confidently places in a family but cannot place at a specific node
 * (status "review" or "none" on the node question) is a substitute for that
 * family's designated fallback node, when the root carries one (see
 * curated/taxonomy.json's `fallback` field and docs/DESIGN.md). Fallback
 * confidence is judged on the root answer alone: the node question already
 * failed to resolve, so its confidence cannot gate this. A confident node
 * answer subsumes a noisy root answer: accept on the node alone, regardless
 * of root confidence.
 */
function deriveStatus(
  taxonomy: Taxonomy,
  root: string,
  rootConfidence: number,
  node: string | null,
  nodeConfidence: number | null,
): { status: JevClassification["status"]; node: string | null } {
  let status: JevClassification["status"];
  if (root === NONE || node === null) {
    status = "none";
  } else if (nodeConfidence !== null && nodeConfidence >= CONFIDENCE_THRESHOLD) {
    status = "accepted";
  } else {
    status = "review";
  }

  if (status !== "review" && status !== "none") return { status, node };
  if (root === NONE || rootConfidence < CONFIDENCE_THRESHOLD) return { status, node };
  const fallback = taxonomy.fallbackFor(root);
  if (fallback === undefined) return { status, node };
  return { status: "fallback", node: fallback };
}

/** Turns the two raw API responses (request2 may be skipped) into the committed record shape. */
export function buildRecord(item: PreprocessedItem, cached: CachedResponse, taxonomy: Taxonomy): JevClassification {
  const rootAnswer = cached.request1.answers.root;
  const { isBrand, isHousePrep, isGarnish } = cached.request1.answers;

  const root = rootAnswer.choice;
  const rootConfidence = rootAnswer.confidence;
  const rootTop3 = top3(rootAnswer.probabilities);

  let node: string | null = null;
  let nodeConfidence: number | null = null;
  let nodeTop3: Record<string, number> | null = null;
  let nodeProbabilities: Record<string, number> | null = null;
  let rawNodeChoice: string | null = null;
  let collapsed = false;
  if (cached.request2) {
    const nodeAnswer = cached.request2.answers.node;
    rawNodeChoice = nodeAnswer.choice;
    nodeProbabilities = nodeAnswer.probabilities;
    const result = collapseNode(taxonomy, rawNodeChoice, nodeAnswer.probabilities);
    node = result.node === NONE ? null : result.node;
    nodeConfidence = result.nodeConfidence;
    collapsed = result.collapsed;
    nodeTop3 = top3(nodeAnswer.probabilities);
  }

  const derived = deriveStatus(taxonomy, root, rootConfidence, node, nodeConfidence);

  return {
    core: item.core,
    count: item.count,
    status: derived.status,
    root,
    rootConfidence,
    rootTop3,
    node: derived.node,
    nodeConfidence,
    nodeTop3,
    nodeProbabilities,
    rawNodeChoice,
    collapsed,
    isBrand: isBrand.noul,
    isHousePrep: isHousePrep.noul,
    isGarnish: isGarnish.noul,
  };
}

/** A record for an item resolved by curated/overrides.json, skipping the API entirely. */
export function overrideRecord(item: PreprocessedItem, taxonomy: Taxonomy, nodeId: string | null): OverrideClassification {
  const root = nodeId !== null ? taxonomy.rootOf(nodeId) : null;
  return { core: item.core, count: item.count, status: "override", node: nodeId, root };
}
