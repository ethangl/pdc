// Cross-check against scripts/lib/makeability.ts: the TypeScript reference
// computes the same per-recipe unmet/unmetHouseMade for the "staples only"
// stocked set, and this must reproduce it exactly. See docs/APP.md
// "Testing". Loads the real Catalog from Bundle.main (the test host) and
// the fixture from the test bundle, where it lands at the bundle root.

import Testing
import Foundation
@testable import PDC

/// Anchors Bundle(for:) to the PDCTests bundle, which holds the fixture.
private final class FixtureBundleMarker {}

private struct FixtureResult: Decodable {
    let slug: String
    let unmet: Int
    let unmetHouseMade: Int
}

private struct StaplesFixture: Decodable {
    let taxonomyVersion: Int
    let stocked: [String]
    let results: [FixtureResult]
}

private func loadFixture() throws -> StaplesFixture {
    let bundle = Bundle(for: FixtureBundleMarker.self)
    guard let url = bundle.url(forResource: "staples-only", withExtension: "json") else {
        throw CatalogError.missingResource("staples-only.json")
    }
    return try JSONDecoder().decode(StaplesFixture.self, from: Data(contentsOf: url))
}

struct FixtureTests {
    static let catalog = try! Catalog.load(from: .main)
    private static let fixture = try! loadFixture()

    @Test func taxonomyVersionsMatch() {
        #expect(Self.fixture.taxonomyVersion == Self.catalog.taxonomyVersion)
    }

    @Test func stockedStaplesMatchTheCatalog() {
        #expect(Set(Self.fixture.stocked) == Self.catalog.stapleIds)
    }

    @Test func matchesTheTypeScriptReferenceForEveryRecipe() {
        let inventory = Inventory(catalog: Self.catalog, stocked: Self.catalog.stapleIds)
        let results = Matcher.evaluate(Self.catalog, inventory: inventory)

        #expect(results.count == Self.fixture.results.count)
        #expect(results.map(\.recipe.slug) == Self.fixture.results.map(\.slug))

        for (swift, reference) in zip(results, Self.fixture.results) {
            #expect(
                swift.unmet == reference.unmet && swift.unmetHouseMade == reference.unmetHouseMade,
                Comment(
                    rawValue:
                        "slug \(swift.recipe.slug): swift (unmet \(swift.unmet), unmetHouseMade \(swift.unmetHouseMade)) "
                        + "!= fixture (unmet \(reference.unmet), unmetHouseMade \(reference.unmetHouseMade))"
                )
            )
        }
    }

    /// Times what RecipeListView does on every inventory change: build the
    /// Inventory, evaluate every recipe, and rank the results. The bound is
    /// loose on purpose: it catches an accidental quadratic, not a slow
    /// machine. The print shows the real number.
    @Test func ranksTheFullCatalogQuickly() {
        let start = DispatchTime.now()
        let inventory = Inventory(catalog: Self.catalog, stocked: Self.catalog.stapleIds)
        _ = Matcher.evaluate(Self.catalog, inventory: inventory).ranked()
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
        print("Inventory + evaluate + ranked over the full catalog took \(elapsedMs) ms")
        #expect(elapsedMs < 2_000)
    }
}
