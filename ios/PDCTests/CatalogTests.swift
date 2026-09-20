// Decode checks for the bundled data files. The test host is PDC, so
// Bundle.main here is the app bundle (holds the JSON resources), not the
// test bundle. Expected counts are read from the real
// data/recipes.json / curated/taxonomy.json, not assumed.

import Testing
import Foundation
@testable import PDC

struct CatalogTests {
    static let catalog = try! Catalog.load(from: .main)

    @Test func recipeCount() {
        #expect(Self.catalog.recipes.count == 3187)
    }

    @Test func nodeCount() {
        #expect(Self.catalog.nodesById.count == 495)
    }

    @Test func stapleCount() {
        #expect(Self.catalog.stapleIds.count == 15)
    }

    @Test func taxonomyVersion() {
        #expect(Self.catalog.taxonomyVersion == 1)
    }

    @Test func hasAtLeastOneUnresolvedRecipe() {
        #expect(Self.catalog.recipes.contains { !$0.unresolved.isEmpty })
    }

    @Test func ancestors() {
        #expect(Self.catalog.ancestors(of: "bourbon") == ["whiskey"])
        #expect(Self.catalog.ancestors(of: "whiskey") == [])
        #expect(Self.catalog.ancestors(of: "not-a-real-node") == [])
    }

    @Test func browseSectionCountMatchesTheDocumentedRootCount() {
        #expect(Self.catalog.browseSections.count == 21)
    }

    @Test func everySectionRootHasNoParent() {
        #expect(Self.catalog.browseSections.allSatisfy { $0.root.parent == nil })
    }

    @Test func whiskeySectionIncludesBourbonAndWhiskeyItself() {
        let whiskey = Self.catalog.browseSections.first { $0.root.id == "whiskey" }
        let ids = whiskey?.nodes.map(\.id) ?? []
        #expect(ids.contains("whiskey"))
        #expect(ids.contains("bourbon"))
    }

    @Test func everySectionsNodesAreSortedByName() {
        for section in Self.catalog.browseSections {
            let names = section.nodes.map(\.name)
            #expect(names == names.sorted { $0.localizedStandardCompare($1) == .orderedAscending })
        }
    }
}
