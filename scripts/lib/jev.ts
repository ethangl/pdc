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

/** A cache key stable across reruns, tied to the taxonomy (version and
 * structure) and prompt version. The structure hash invalidates the cache
 * when nodes, parents, or categories change; it deliberately ignores names
 * and aliases, so an alias edit does not invalidate the cache. */
function cacheKeyFor(core: string, taxonomy: Taxonomy): string {
  return crypto.createHash("sha1").update(`${core}|${taxonomy.version}|${PROMPT_VERSION}|${taxonomy.structureHash}`).digest("hex");
}

function cachePathFor(core: string, taxonomy: Taxonomy): string {
  return path.join(JEV_CACHE_DIR, `${cacheKeyFor(core, taxonomy)}.json`);
}

/** The cached Jev response for `core`, or null when nothing is cached. */
export function readJevCache(core: string, taxonomy: Taxonomy): CachedResponse | null {
  const cachePath = cachePathFor(core, taxonomy);
  if (!fs.existsSync(cachePath)) return null;
  return JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedResponse;
}

export function writeJevCache(core: string, taxonomy: Taxonomy, response: CachedResponse): void {
  writeJson(cachePathFor(core, taxonomy), response);
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
  if (root === NONE || node === null || node === NONE) {
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
    node = result.node;
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
