// Loads and validates curated/taxonomy.json, the hand-written ingredient
// tree. See curated/taxonomy.json's `notes` field for the semantics of
// categories, aliases, and staples.

import * as fs from "node:fs";
import { TAXONOMY_PATH } from "./paths.js";

export interface TaxonomyNode {
  id: string;
  name: string;
  parent?: string;
  kind?: "category";
  aliases?: string[];
  staple?: boolean;
  /** Node id a confident-but-unplaceable classification in this node's
   * subtree resolves to. Must be a non-category descendant of this node. */
  fallback?: string;
}

interface RawTaxonomyFile {
  version?: unknown;
  notes?: unknown;
  nodes?: unknown;
}

export interface Taxonomy {
  version: number;
  nodes: Map<string, TaxonomyNode>;
  roots: string[];
  childrenOf(id: string): string[];
  /** Nearest ancestor first, excludes the node itself. */
  ancestorsOf(id: string): string[];
  isCategory(id: string): boolean;
  /** Matches a lowercase preprocessed core against node ids, node names, and aliases. */
  resolveAlias(core: string): string | undefined;
  /** The node id `rootId`'s subtree resolves to when a confident answer cannot be placed more specifically. */
  fallbackFor(rootId: string): string | undefined;
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DEPTH = 4;

export function validateTaxonomy(raw: unknown): string[] {
  const problems: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return ["Taxonomy file must contain a JSON object."];
  }

  const file = raw as RawTaxonomyFile;
  if (!Array.isArray(file.nodes)) {
    return ["Taxonomy file must have a `nodes` array."];
  }
  const nodes = file.nodes as TaxonomyNode[];

  // Unique, well-formed ids.
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || !node.id) {
      problems.push(`Node is missing a valid id: ${JSON.stringify(node)}`);
      continue;
    }
    if (seenIds.has(node.id)) {
      problems.push(`Duplicate node id: ${node.id}`);
    }
    seenIds.add(node.id);
    if (!ID_RE.test(node.id)) {
      problems.push(`Node id is not kebab-case: ${node.id}`);
    }
  }

  const byId = new Map<string, TaxonomyNode>();
  for (const node of nodes) {
    if (typeof node.id === "string") byId.set(node.id, node);
  }

  // Parents exist.
  for (const node of nodes) {
    if (node.parent !== undefined && !byId.has(node.parent)) {
      problems.push(`Node ${node.id} has unknown parent: ${node.parent}`);
    }
  }

  // Cycles.
  const inCycle = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || inCycle.has(node.id)) continue;
    const chain: string[] = [node.id];
    const visited = new Set<string>([node.id]);
    let cursor: TaxonomyNode = node;
    while (cursor.parent) {
      const parentId = cursor.parent;
      if (visited.has(parentId)) {
        const cycleStart = chain.indexOf(parentId);
        const cycleNodes = chain.slice(cycleStart);
        for (const id of cycleNodes) inCycle.add(id);
        problems.push(`Cycle detected: ${cycleNodes.join(" -> ")} -> ${parentId}`);
        break;
      }
      const parentNode = byId.get(parentId);
      if (!parentNode) break; // already reported as a missing parent
      chain.push(parentId);
      visited.add(parentId);
      cursor = parentNode;
    }
  }

  // Aliases: lowercase/trimmed, unique across nodes, and distinct from any
  // other node's id or name.
  const idSet = seenIds;
  const nameOwner = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node.name === "string" && typeof node.id === "string") {
      nameOwner.set(node.name.toLowerCase(), node.id);
    }
  }

  const aliasOwner = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || !node.aliases) continue;
    for (const alias of node.aliases) {
      if (typeof alias !== "string") {
        problems.push(`Node ${node.id} has a non-string alias: ${JSON.stringify(alias)}`);
        continue;
      }
      if (alias !== alias.trim() || alias !== alias.toLowerCase()) {
        problems.push(`Node ${node.id} has an alias that is not lowercase and trimmed: ${JSON.stringify(alias)}`);
      }

      const existingOwner = aliasOwner.get(alias);
      if (existingOwner && existingOwner !== node.id) {
        problems.push(`Alias ${JSON.stringify(alias)} is used by both ${existingOwner} and ${node.id}`);
      } else {
        aliasOwner.set(alias, node.id);
      }

      if (idSet.has(alias) && alias !== node.id) {
        problems.push(`Alias ${JSON.stringify(alias)} on node ${node.id} equals another node's id`);
      }
      const nameOwnerId = nameOwner.get(alias);
      if (nameOwnerId && nameOwnerId !== node.id) {
        problems.push(`Alias ${JSON.stringify(alias)} on node ${node.id} equals another node's name (${nameOwnerId})`);
      }
    }
  }

  // Category rules.
  const childCount = new Map<string, number>();
  for (const node of nodes) {
    if (node.parent) childCount.set(node.parent, (childCount.get(node.parent) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (typeof node.id !== "string") continue;
    if (node.kind !== undefined && node.kind !== "category") {
      problems.push(`Node ${node.id} has an unknown kind: ${JSON.stringify(node.kind)}`);
    }
    if (node.kind === "category") {
      if ((childCount.get(node.id) ?? 0) === 0) {
        problems.push(`Category node ${node.id} has no children (category nodes cannot be leaves)`);
      }
      if (node.staple) {
        problems.push(`Node ${node.id} is both a category and a staple`);
      }
    }
  }

  // Fallbacks: must point to an existing non-category node that is a
  // descendant of the node carrying the fallback.
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.fallback === undefined) continue;
    if (typeof node.fallback !== "string") {
      problems.push(`Node ${node.id} has a non-string fallback: ${JSON.stringify(node.fallback)}`);
      continue;
    }
    const target = byId.get(node.fallback);
    if (!target) {
      problems.push(`Node ${node.id} has a fallback to an unknown node: ${node.fallback}`);
      continue;
    }
    if (target.kind === "category") {
      problems.push(`Node ${node.id} has a fallback to a category node: ${node.fallback}`);
      continue;
    }
    if (!isDescendantOf(target, node.id, byId)) {
      problems.push(`Node ${node.id} has a fallback that is not one of its descendants: ${node.fallback}`);
    }
  }

  // Depth.
  let maxDepth = 0;
  let deepestId: string | undefined;
  for (const node of nodes) {
    if (typeof node.id !== "string") continue;
    const depth = computeDepth(node, byId);
    if (depth > maxDepth) {
      maxDepth = depth;
      deepestId = node.id;
    }
  }
  if (maxDepth > MAX_DEPTH && deepestId) {
    const path: string[] = [];
    let cursor: TaxonomyNode | undefined = byId.get(deepestId);
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor.id);
      seen.add(cursor.id);
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
    problems.push(`Depth ${maxDepth} exceeds the max of ${MAX_DEPTH}: ${path.join(" -> ")}`);
  }

  return problems;
}

/** True if `node` descends from `ancestorId`, guarding against cycles. */
function isDescendantOf(node: TaxonomyNode, ancestorId: string, byId: Map<string, TaxonomyNode>): boolean {
  const seen = new Set<string>([node.id]);
  let cursor: TaxonomyNode = node;
  while (cursor.parent) {
    if (cursor.parent === ancestorId) return true;
    if (seen.has(cursor.parent)) break; // cycle; already reported separately
    const parent = byId.get(cursor.parent);
    if (!parent) break;
    seen.add(parent.id);
    cursor = parent;
  }
  return false;
}

function computeDepth(node: TaxonomyNode, byId: Map<string, TaxonomyNode>): number {
  let depth = 0;
  let cursor: TaxonomyNode = node;
  const seen = new Set<string>([node.id]);
  while (cursor.parent) {
    const parent = byId.get(cursor.parent);
    if (!parent || seen.has(parent.id)) break; // cycle; already reported separately
    seen.add(parent.id);
    cursor = parent;
    depth++;
  }
  return depth;
}

/** Builds a Taxonomy from raw, already-parsed JSON without validating it. */
export function taxonomyFromRaw(raw: unknown): Taxonomy {
  const file = raw as { version: number; nodes: TaxonomyNode[] };
  const nodeList = file.nodes;

  const nodes = new Map<string, TaxonomyNode>();
  for (const node of nodeList) nodes.set(node.id, node);

  const roots = nodeList.filter((node) => !node.parent).map((node) => node.id);

  const childrenIndex = new Map<string, string[]>();
  for (const node of nodeList) {
    if (!node.parent) continue;
    const siblings = childrenIndex.get(node.parent) ?? [];
    siblings.push(node.id);
    childrenIndex.set(node.parent, siblings);
  }

  const nameIndex = new Map<string, string>();
  const aliasIndex = new Map<string, string>();
  for (const node of nodeList) {
    nameIndex.set(node.name.toLowerCase(), node.id);
    for (const alias of node.aliases ?? []) {
      aliasIndex.set(alias, node.id);
    }
  }

  function childrenOf(id: string): string[] {
    return childrenIndex.get(id) ?? [];
  }

  function ancestorsOf(id: string): string[] {
    const node = nodes.get(id);
    if (!node) throw new Error(`Unknown taxonomy node: ${id}`);
    const result: string[] = [];
    const seen = new Set<string>([id]);
    let cursor: TaxonomyNode = node;
    while (cursor.parent) {
      const parent = nodes.get(cursor.parent);
      if (!parent || seen.has(parent.id)) break;
      result.push(parent.id);
      seen.add(parent.id);
      cursor = parent;
    }
    return result;
  }

  function isCategory(id: string): boolean {
    return nodes.get(id)?.kind === "category";
  }

  function resolveAlias(core: string): string | undefined {
    const normalized = core.trim().toLowerCase();
    if (nodes.has(normalized)) return normalized;
    const byName = nameIndex.get(normalized);
    if (byName) return byName;
    return aliasIndex.get(normalized);
  }

  function fallbackFor(rootId: string): string | undefined {
    return nodes.get(rootId)?.fallback;
  }

  return {
    version: file.version,
    nodes,
    roots,
    childrenOf,
    ancestorsOf,
    isCategory,
    resolveAlias,
    fallbackFor,
  };
}

export function loadTaxonomy(path = TAXONOMY_PATH): Taxonomy {
  const content = fs.readFileSync(path, "utf8");
  const raw = JSON.parse(content);

  const problems = validateTaxonomy(raw);
  if (problems.length > 0) {
    throw new Error(`Invalid taxonomy (${problems.length} problem(s)):\n${problems.join("\n")}`);
  }

  return taxonomyFromRaw(raw);
}
