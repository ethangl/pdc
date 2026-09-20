// Pure reference implementation of the makeability matching rule from
// docs/APP.md, used to build the "staples only" fixture that the Swift
// Matcher must reproduce exactly. No I/O: callers pass in an already-loaded
// RecipesFile and taxonomy. Deliberately kept as the straightforward,
// descendants-of-each-requirement statement of the rule, distinct from the
// Swift side's ancestor-closure form, so the two agreeing on all 3187
// recipes is a real cross-check rather than the same code twice.

import type { Taxonomy } from "./taxonomy.js";
import type { RecipesFile } from "./mapping.js";

export interface MakeabilityResult {
  slug: string;
  unmet: number;
  unmetHouseMade: number;
}

/** True when stocking `stocked` satisfies a requirement listing `nodes` as
 * alternatives: stocking a node itself, or any of its descendants,
 * satisfies it. Stocking an ancestor does not. */
function isSatisfied(nodes: string[], stocked: ReadonlySet<string>, taxonomy: Taxonomy): boolean {
  return nodes.some((nodeId) => {
    if (stocked.has(nodeId)) return true;
    return taxonomy.descendantsOf(nodeId).some((descendantId) => stocked.has(descendantId));
  });
}

/** Computes, per recipe and in the recipes' order, the two makeability
 * counts from docs/APP.md: `unmet` (requires with no satisfied node, plus
 * unresolved lines) and `unmetHouseMade` (the house-made subset of those,
 * plus unresolved lines). `optional` is ignored. */
export function computeMakeability(
  recipes: RecipesFile,
  taxonomy: Taxonomy,
  stocked: ReadonlySet<string>,
): MakeabilityResult[] {
  return recipes.recipes.map((recipe) => {
    const unresolvedCount = recipe.unresolved?.length ?? 0;
    let unmet = unresolvedCount;
    let unmetHouseMade = unresolvedCount;

    for (const requirement of recipe.requires) {
      if (!isSatisfied(requirement.nodes, stocked, taxonomy)) {
        unmet++;
        if (requirement.houseMade) unmetHouseMade++;
      }
    }

    return { slug: recipe.slug, unmet, unmetHouseMade };
  });
}

/** Ids of every node with `staple: true`. */
export function stapleIds(taxonomy: Taxonomy): string[] {
  const ids: string[] = [];
  for (const [id, node] of taxonomy.nodes) {
    if (node.staple) ids.push(id);
  }
  return ids;
}
