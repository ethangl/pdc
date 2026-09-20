// Pure matching logic: no SwiftUI, no SwiftData. Views read @Query for
// stocked rows, build an Inventory, and call Matcher.evaluate. See
// docs/APP.md "Matching" and "Architecture".

import Foundation

/// The satisfied-id closure of a stocked set, computed once per inventory
/// change: every stocked node plus all of its ancestors. A requirement is
/// satisfied when any of its `nodes` is in this set, which is O(1) per
/// requirement after the O(stocked x depth) build.
struct Inventory: Sendable {
    let stocked: Set<String>
    /// Satisfied node id -> the stocked node that satisfies it (itself for
    /// a directly stocked node, otherwise the descendant that provides it).
    private let providedBy: [String: String]

    init(catalog: Catalog, stocked: Set<String>) {
        self.stocked = stocked
        var providedBy: [String: String] = [:]
        for node in stocked.sorted() {
            providedBy[node] = providedBy[node] ?? node
            for ancestor in catalog.ancestors(of: node) {
                providedBy[ancestor] = providedBy[ancestor] ?? node
            }
        }
        self.providedBy = providedBy
    }

    /// The stocked node id that satisfies any of `nodes`, checked in order;
    /// nil when none is satisfied.
    func provider(for nodes: [String]) -> String? {
        for node in nodes {
            if let provider = providedBy[node] {
                return provider
            }
        }
        return nil
    }
}

enum RequirementStatus: Sendable, Hashable {
    case stocked(by: String)
    case missing
}

struct RequirementResult: Sendable, Hashable {
    let requirement: Requirement
    let status: RequirementStatus
}

/// Per-recipe result. `unmet` and `unmetHouseMade` follow docs/APP.md
/// exactly: `requires` entries with no satisfied node, plus unresolved
/// lines, counted in both, and the house-made subset of the former also
/// counted in `unmetHouseMade`. `optional` is not evaluated here.
struct RecipeResult: Sendable, Identifiable, Hashable {
    let recipe: Recipe
    let requirements: [RequirementResult]
    let unmet: Int
    let unmetHouseMade: Int

    var id: String { recipe.slug }
}

enum Matcher {
    /// The one copy of the matching rule; the catalog-wide overload below
    /// just maps over it. RecipeDetailView calls this directly to
    /// re-evaluate a single recipe without re-running the whole catalog.
    static func evaluate(_ recipe: Recipe, inventory: Inventory) -> RecipeResult {
        let unresolvedCount = recipe.unresolved?.count ?? 0
        var unmet = unresolvedCount
        var unmetHouseMade = unresolvedCount

        var requirementResults: [RequirementResult] = []
        requirementResults.reserveCapacity(recipe.requires.count)
        for requirement in recipe.requires {
            if let provider = inventory.provider(for: requirement.nodes) {
                requirementResults.append(RequirementResult(requirement: requirement, status: .stocked(by: provider)))
            } else {
                requirementResults.append(RequirementResult(requirement: requirement, status: .missing))
                unmet += 1
                if requirement.houseMade { unmetHouseMade += 1 }
            }
        }

        return RecipeResult(recipe: recipe, requirements: requirementResults, unmet: unmet, unmetHouseMade: unmetHouseMade)
    }

    static func evaluate(_ catalog: Catalog, inventory: Inventory) -> [RecipeResult] {
        catalog.recipes.map { evaluate($0, inventory: inventory) }
    }
}
