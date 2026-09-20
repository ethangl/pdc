// Unit tests for ios/PDC/Matching/Matcher.swift and Ranking.swift, on a
// small synthetic catalog. See docs/APP.md "Matching" and "Testing".

import Testing
@testable import PDC

private enum Synthetic {
    // gin
    //   london-dry-gin
    //   old-tom-gin
    // citrus (category)
    //   lime-juice
    //   lemon-juice
    // syrup (category, fallback: simple-syrup)
    //   simple-syrup (staple)
    //   vanilla-syrup
    // salt (staple)

    static func node(
        _ id: String,
        parent: String? = nil,
        staple: Bool = false
    ) -> TaxonomyNode {
        TaxonomyNode(id: id, name: id, parent: parent, staple: staple)
    }

    static let nodes: [TaxonomyNode] = [
        node("gin"),
        node("london-dry-gin", parent: "gin"),
        node("old-tom-gin", parent: "gin"),
        node("citrus"),
        node("lime-juice", parent: "citrus"),
        node("lemon-juice", parent: "citrus"),
        node("syrup"),
        node("simple-syrup", parent: "syrup", staple: true),
        node("vanilla-syrup", parent: "syrup"),
        node("salt", staple: true),
    ]

    static func catalog(recipes: [Recipe]) -> Catalog {
        Catalog(recipes: recipes, nodes: nodes, taxonomyVersion: 0)
    }

    static func requirement(_ nodes: [String], houseMade: Bool = false, substitute: Bool = false) -> Requirement {
        Requirement(nodes: nodes, houseMade: houseMade, raw: nodes.joined(separator: " or "), substitute: substitute)
    }

    static func recipe(
        slug: String,
        name: String? = nil,
        requires: [Requirement] = [],
        optional: [Requirement] = [],
        unresolved: [UnresolvedLine] = []
    ) -> Recipe {
        Recipe(slug: slug, name: name ?? slug, url: "https://example.com/\(slug)", requires: requires, optional: optional, unresolved: unresolved)
    }

    static func inventory(_ stocked: Set<String>, in catalog: Catalog) -> Inventory {
        Inventory(catalog: catalog, stocked: stocked)
    }
}

struct MatcherTests {
    @Test func alternativesSatisfiedByEither() {
        let recipe = Synthetic.recipe(slug: "a", requires: [Synthetic.requirement(["lime-juice", "lemon-juice"])])
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory(["lemon-juice"], in: catalog))
        #expect(results[0].unmet == 0)
        #expect(results[0].requirements[0].status == .stocked(by: "lemon-juice"))
    }

    @Test func childSatisfiesParent() {
        let recipe = Synthetic.recipe(slug: "a", requires: [Synthetic.requirement(["gin"])])
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory(["london-dry-gin"], in: catalog))
        #expect(results[0].unmet == 0)
        #expect(results[0].requirements[0].status == .stocked(by: "london-dry-gin"))
    }

    @Test func parentDoesNotSatisfyChild() {
        let recipe = Synthetic.recipe(slug: "a", requires: [Synthetic.requirement(["old-tom-gin"])])
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory(["gin"], in: catalog))
        #expect(results[0].unmet == 1)
        #expect(results[0].requirements[0].status == .missing)
    }

    @Test func stockedCategoryNodeSatisfiesItsOwnRequirement() {
        let recipe = Synthetic.recipe(slug: "a", requires: [Synthetic.requirement(["citrus"])])
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory(["citrus"], in: catalog))
        #expect(results[0].unmet == 0)
        #expect(results[0].requirements[0].status == .stocked(by: "citrus"))
    }

    @Test func substituteRequirementSatisfiedByFallbackNode() {
        let recipe = Synthetic.recipe(
            slug: "a",
            requires: [Synthetic.requirement(["simple-syrup"], houseMade: true, substitute: true)]
        )
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory(["simple-syrup"], in: catalog))
        #expect(results[0].unmet == 0)
        #expect(results[0].unmetHouseMade == 0)
    }

    @Test func unresolvedLinesAddToBothCounts() {
        let recipe = Synthetic.recipe(slug: "a", unresolved: [UnresolvedLine(raw: "mystery", core: "mystery")])
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory([], in: catalog))
        #expect(results[0].unmet == 1)
        #expect(results[0].unmetHouseMade == 1)
    }

    @Test func optionalLinesChangeNothing() {
        let recipe = Synthetic.recipe(slug: "a", optional: [Synthetic.requirement(["lime-juice"])])
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory([], in: catalog))
        #expect(results[0].unmet == 0)
        #expect(results[0].unmetHouseMade == 0)
    }

    @Test func emptyInventoryLeavesEveryRequirementMissing() {
        let recipe = Synthetic.recipe(
            slug: "a",
            requires: [Synthetic.requirement(["gin"]), Synthetic.requirement(["lime-juice"], houseMade: true)]
        )
        let catalog = Synthetic.catalog(recipes: [recipe])
        let results = Matcher.evaluate(catalog, inventory: Synthetic.inventory([], in: catalog))
        #expect(results[0].unmet == 2)
        #expect(results[0].unmetHouseMade == 1)
        #expect(results[0].requirements.allSatisfy { $0.status == .missing })
    }

    @Test func providerReturnsTheSpecificStockedDescendant() {
        let catalog = Synthetic.catalog(recipes: [])
        let inventory = Synthetic.inventory(["london-dry-gin"], in: catalog)
        #expect(inventory.provider(for: ["gin"]) == "london-dry-gin")
    }

    @Test func providerReturnsTheFirstMatchingAlternative() {
        let catalog = Synthetic.catalog(recipes: [])
        let inventory = Synthetic.inventory(["lime-juice", "lemon-juice"], in: catalog)
        #expect(inventory.provider(for: ["lime-juice", "lemon-juice"]) == "lime-juice")
        #expect(inventory.provider(for: ["lemon-juice", "lime-juice"]) == "lemon-juice")
    }

    @Test func rankedOrdersByUnmetThenUnmetHouseMadeThenName() {
        func result(slug: String, name: String, unmet: Int, unmetHouseMade: Int) -> RecipeResult {
            RecipeResult(recipe: Synthetic.recipe(slug: slug, name: name), requirements: [], unmet: unmet, unmetHouseMade: unmetHouseMade)
        }
        let results = [
            result(slug: "z", name: "Zed", unmet: 1, unmetHouseMade: 0),
            result(slug: "a", name: "Banana", unmet: 0, unmetHouseMade: 0),
            result(slug: "b", name: "Apple", unmet: 0, unmetHouseMade: 0),
            result(slug: "c", name: "Zed", unmet: 1, unmetHouseMade: 1),
        ]
        let ranked = results.ranked()
        #expect(ranked.map(\.recipe.slug) == ["b", "a", "z", "c"])
    }

    @Test func singleRecipeEvaluateMatchesCatalogWideEvaluate() {
        let recipeA = Synthetic.recipe(slug: "a", requires: [Synthetic.requirement(["gin"])])
        let recipeB = Synthetic.recipe(slug: "b", requires: [Synthetic.requirement(["lime-juice"], houseMade: true)])
        let catalog = Synthetic.catalog(recipes: [recipeA, recipeB])
        let inventory = Synthetic.inventory(["london-dry-gin"], in: catalog)

        let catalogWide = Matcher.evaluate(catalog, inventory: inventory)
        let single = Matcher.evaluate(recipeB, inventory: inventory)

        #expect(single == catalogWide[1])
    }

    @Test func makeabilityBucketBoundaries() {
        #expect(MakeabilityBucket(unmet: 0) == .ready)
        #expect(MakeabilityBucket(unmet: 1) == .missingOne)
        #expect(MakeabilityBucket(unmet: 2) == .missingTwo)
        #expect(MakeabilityBucket(unmet: 3) == .missingThreeOrMore)
        #expect(MakeabilityBucket(unmet: 10) == .missingThreeOrMore)
    }
}
