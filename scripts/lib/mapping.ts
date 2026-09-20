// Types and pure resolution logic for the app-facing recipe mapping
// (data/recipes.json). See AGENTS.md's brief for scripts/build-mapping.ts,
// which is the thin driver that calls resolveLine and dedupeRequirements
// for every cached recipe's ingredient lines.

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
  overrides: Record<string, string | null>;
  /** Accepted/override classifications only: core -> node id. */
  classifications: Map<string, string>;
  /** Fallback classifications only: core -> the family's fallback node id.
   * Resolves like `classifications`, but the resulting requirement is
   * flagged `substitute`. */
  fallbackClassifications: Map<string, string>;
  resolveAlias: (core: string) => string | undefined;
  isCategory: (nodeId: string) => boolean;
}

/** The subset of a preprocessed ingredient line that resolveLine needs. */
export interface LineInput {
  raw: string;
  core: string;
  alternatives?: string[];
  flags: {
    optional: boolean;
    garnishLike: boolean;
  };
}

export type LineBucket = "requires" | "optional" | "unresolved" | "dropped";

export interface ResolvedCandidate {
  candidate: string;
  nodeId: string;
  source: ResolutionSource;
}

export interface LineResolution {
  bucket: LineBucket;
  /** Present when bucket is "requires" or "optional". */
  requirement?: Requirement;
  /** Present when bucket is "unresolved". Absent for "dropped": a line whose
   * every candidate was overridden to null (not an ingredient, e.g. "to
   * top", "spirit") is discarded entirely, not reported as unresolved. */
  unresolved?: UnresolvedLine;
  /** Every candidate that resolved to a non-category node, in order. */
  resolvedCandidates: ResolvedCandidate[];
  /** Node ids hit by a candidate that resolved to a category (unusable). */
  categoryHits: string[];
  /** Alternatives that failed to resolve while at least one other resolved. */
  unresolvedAlternatives: number;
}

type CandidateResult =
  | { status: "resolved"; nodeId: string; source: ResolutionSource }
  | { status: "dropped" }
  | { status: "category"; nodeId: string }
  | { status: "none" };

function resolveCandidate(candidate: string, deps: ResolveDeps): CandidateResult {
  if (Object.prototype.hasOwnProperty.call(deps.overrides, candidate)) {
    const nodeId = deps.overrides[candidate];
    if (nodeId === null) return { status: "dropped" };
    if (deps.isCategory(nodeId)) return { status: "category", nodeId };
    return { status: "resolved", nodeId, source: "override" };
  }

  const aliasHit = deps.resolveAlias(candidate);
  if (aliasHit !== undefined) {
    if (deps.isCategory(aliasHit)) return { status: "category", nodeId: aliasHit };
    return { status: "resolved", nodeId: aliasHit, source: "alias" };
  }

  const classificationHit = deps.classifications.get(candidate);
  if (classificationHit !== undefined) {
    if (deps.isCategory(classificationHit)) return { status: "category", nodeId: classificationHit };
    return { status: "resolved", nodeId: classificationHit, source: "classification" };
  }

  const fallbackHit = deps.fallbackClassifications.get(candidate);
  if (fallbackHit !== undefined) {
    if (deps.isCategory(fallbackHit)) return { status: "category", nodeId: fallbackHit };
    return { status: "resolved", nodeId: fallbackHit, source: "fallback" };
  }

  return { status: "none" };
}

/**
 * Resolves one preprocessed ingredient line against overrides, taxonomy
 * aliases, and classifications, per docs/DESIGN.md and the mapping brief.
 * Pure: takes its dependencies as arguments, makes no I/O.
 */
export function resolveLine(line: LineInput, houseMade: boolean, deps: ResolveDeps): LineResolution {
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

  const requirement: Requirement = { nodes: resolvedNodes, houseMade, raw: line.raw };
  const allSubstitute = resolvedCandidates.length > 0 && resolvedCandidates.every((c) => c.source === "fallback");
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
      existing.houseMade = existing.houseMade || req.houseMade;
      const merged = (existing.substitute ?? false) && (req.substitute ?? false);
      if (merged) {
        existing.substitute = true;
      } else {
        delete existing.substitute;
      }
    } else {
      byKey.set(key, { ...req });
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key)!);
}
