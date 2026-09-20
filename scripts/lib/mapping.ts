// Types and pure resolution logic for the app-facing recipe mapping
// (data/recipes.json). See docs/DESIGN.md for the resolution rules;
// scripts/build-mapping.ts is the thin driver that calls resolveLine and
// dedupeRequirements for every cached recipe's ingredient lines.

import type { PreprocessedIngredient } from "./preprocess.js";
import type { ClassificationItem, Overrides } from "./data-files.js";

export interface Requirement {
  nodes: string[];
  houseMade: boolean;
  raw: string;
  /** True when this requirement is a proposed stand-in (the family's
   * taxonomy `fallback` node) rather than the ingredient itself, because
   * the classifier could place it in the family but not at a specific
   * node. Omitted when false. */
  substitute?: boolean;
}

export interface UnresolvedLine {
  raw: string;
  core: string;
}

export interface RecipeMapping {
  slug: string;
  name: string;
  url: string;
  requires: Requirement[];
  optional?: Requirement[];
  unresolved?: UnresolvedLine[];
}

export interface RecipesFile {
  generatedAt: string;
  taxonomyVersion: number;
  recipes: RecipeMapping[];
}

export type ResolutionSource = "override" | "alias" | "classification" | "fallback";

export interface ResolveDeps {
  /** curated/overrides.json: exact core -> node id, or null meaning "no ingredient". */
  overrides: Overrides;
  /** core -> node, from accepted, override, and fallback classifications. */
  classifications: Map<string, { nodeId: string; source: "classification" | "fallback" }>;
  resolveAlias: (core: string) => string | undefined;
  isCategory: (nodeId: string) => boolean;
}

/** core -> node, keyed for resolveCandidate: accepted/override classifications
 * resolve as "classification", fallback classifications as "fallback".
 * Override items with no node ("not an ingredient") are skipped. */
export function classificationLookup(items: ClassificationItem[]): ResolveDeps["classifications"] {
  const lookup: ResolveDeps["classifications"] = new Map();
  for (const item of items) {
    if (item.status === "accepted" || item.status === "fallback") {
      if (item.node === null) continue; // invariant: always a string node for these statuses
      lookup.set(item.core, { nodeId: item.node, source: item.status === "fallback" ? "fallback" : "classification" });
    } else if (item.status === "override" && item.node !== null) {
      lookup.set(item.core, { nodeId: item.node, source: "classification" });
    }
  }
  return lookup;
}

export type LineBucket = "requires" | "optional" | "unresolved" | "dropped";

export interface ResolvedCandidate {
  candidate: string;
  nodeId: string;
  source: ResolutionSource;
}

interface ResolutionStats {
  /** Every candidate that resolved to a non-category node, in order. */
  resolvedCandidates: ResolvedCandidate[];
  /** Node ids hit by a candidate that resolved to a category (unusable). */
  categoryHits: string[];
  /** Alternatives that failed to resolve while at least one other resolved. */
  unresolvedAlternatives: number;
}

/** A line whose every candidate was overridden to null (not an ingredient,
 * e.g. "to top", "spirit") is discarded entirely: bucket "dropped", not
 * reported as unresolved. */
export type LineResolution = ResolutionStats &
  (
    | { bucket: "requires" | "optional"; requirement: Requirement }
    | { bucket: "unresolved"; unresolved: UnresolvedLine }
    | { bucket: "dropped" }
  );

type CandidateResult =
  | { status: "resolved"; nodeId: string; source: ResolutionSource }
  | { status: "dropped" }
  | { status: "category"; nodeId: string }
  | { status: "none" };

/** Tries override, then alias, then classification/fallback, in that order;
 * the first hit wins. Applies the category check once, to whichever hit was
 * found. */
function resolveCandidate(candidate: string, deps: ResolveDeps): CandidateResult {
  let hit: { nodeId: string; source: ResolutionSource } | undefined;

  if (Object.prototype.hasOwnProperty.call(deps.overrides, candidate)) {
    const nodeId = deps.overrides[candidate];
    if (nodeId === null) return { status: "dropped" };
    hit = { nodeId, source: "override" };
  } else {
    const aliasHit = deps.resolveAlias(candidate);
    if (aliasHit !== undefined) {
      hit = { nodeId: aliasHit, source: "alias" };
    } else {
      const classificationHit = deps.classifications.get(candidate);
      if (classificationHit !== undefined) {
        hit = { nodeId: classificationHit.nodeId, source: classificationHit.source };
      }
    }
  }

  if (!hit) return { status: "none" };
  if (deps.isCategory(hit.nodeId)) return { status: "category", nodeId: hit.nodeId };
  return { status: "resolved", nodeId: hit.nodeId, source: hit.source };
}

/**
 * Resolves one preprocessed ingredient line against overrides, taxonomy
 * aliases, and classifications, per docs/DESIGN.md and the mapping brief.
 * Pure: takes its dependencies as arguments, makes no I/O.
 */
export function resolveLine(line: PreprocessedIngredient, deps: ResolveDeps): LineResolution {
  const candidates = line.alternatives ?? [line.core];

  const resolvedNodes: string[] = [];
  const resolvedCandidates: ResolvedCandidate[] = [];
  const categoryHits: string[] = [];
  let misses = 0;
  let dropped = 0;

  for (const candidate of candidates) {
    const result = resolveCandidate(candidate, deps);
    switch (result.status) {
      case "dropped":
        // Overridden to "no ingredient": not a candidate, not a miss.
        dropped++;
        break;
      case "resolved":
        if (!resolvedNodes.includes(result.nodeId)) resolvedNodes.push(result.nodeId);
        resolvedCandidates.push({ candidate, nodeId: result.nodeId, source: result.source });
        break;
      case "category":
        categoryHits.push(result.nodeId);
        misses++;
        break;
      case "none":
        misses++;
        break;
    }
  }

  if (resolvedNodes.length === 0) {
    if (dropped > 0 && misses === 0) {
      // Every candidate was overridden to null: this line is not an
      // ingredient at all ("to top", "spirit", "liquid nitrogen"). Discard
      // it entirely rather than reporting it as unresolved.
      return {
        bucket: "dropped",
        resolvedCandidates,
        categoryHits,
        unresolvedAlternatives: 0,
      };
    }
    return {
      bucket: "unresolved",
      unresolved: { raw: line.raw, core: line.core },
      resolvedCandidates,
      categoryHits,
      unresolvedAlternatives: 0,
    };
  }

  const requirement: Requirement = { nodes: resolvedNodes, houseMade: line.flags.houseMade, raw: line.raw };
  const allSubstitute = resolvedCandidates.every((c) => c.source === "fallback");
  if (allSubstitute) requirement.substitute = true;
  const isOptional = line.flags.optional || line.flags.garnishLike;

  return {
    bucket: isOptional ? "optional" : "requires",
    requirement,
    resolvedCandidates,
    categoryHits,
    unresolvedAlternatives: misses,
  };
}

/**
 * Dedupes requirements within a recipe by identical `nodes` arrays, keeping
 * the first occurrence's raw text, OR-ing houseMade across duplicates, and
 * ANDing substitute across duplicates (a requirement is a substitute only
 * when every merged line needed one).
 */
export function dedupeRequirements(requirements: Requirement[]): Requirement[] {
  const byKey = new Map<string, Requirement>();
  const order: string[] = [];
  for (const req of requirements) {
    const key = JSON.stringify(req.nodes);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        nodes: existing.nodes,
        houseMade: existing.houseMade || req.houseMade,
        raw: existing.raw,
        ...(existing.substitute && req.substitute ? { substitute: true } : {}),
      });
    } else {
      byKey.set(key, { ...req });
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key)!);
}
