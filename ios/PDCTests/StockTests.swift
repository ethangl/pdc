// Unit tests for ios/PDC/Inventory/StockedNode.swift, against an in-memory
// ModelContainer so nothing touches a real store. Each test gets its own
// UserDefaults suite (removed afterward) so seedStaplesIfNeeded's flag
// never leaks between tests, including under the default parallel run.

import Testing
import SwiftData
import Foundation
@testable import PDC

@MainActor
struct StockTests {
    private func makeContext() throws -> ModelContext {
        let schema = Schema([StockedNode.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        return ModelContext(container)
    }

    private func makeDefaults() -> (defaults: UserDefaults, suiteName: String) {
        let suiteName = "PDCTests-\(UUID().uuidString)"
        return (UserDefaults(suiteName: suiteName)!, suiteName)
    }

    private func catalog(stapleIds: Set<String>) -> Catalog {
        let nodes = stapleIds.map { TaxonomyNode(id: $0, name: $0, staple: true) }
        return Catalog(recipes: [], nodes: nodes, taxonomyVersion: 0)
    }

    @Test func seedingTwiceYields15Rows() throws {
        let context = try makeContext()
        let (defaults, suiteName) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let staples = Set((1...15).map { "staple-\($0)" })
        let cat = catalog(stapleIds: staples)

        Stock.seedStaplesIfNeeded(catalog: cat, context: context, defaults: defaults)
        Stock.seedStaplesIfNeeded(catalog: cat, context: context, defaults: defaults)

        #expect(try context.fetch(FetchDescriptor<StockedNode>()).count == 15)
    }

    @Test func toggleAddsThenRemoves() throws {
        let context = try makeContext()

        Stock.toggle("gin", in: context)
        #expect(try context.fetch(FetchDescriptor<StockedNode>()).count == 1)

        Stock.toggle("gin", in: context)
        #expect(try context.fetch(FetchDescriptor<StockedNode>()).count == 0)
    }

    @Test func reseedingAfterUnstockingAStapleDoesNotReaddIt() throws {
        let context = try makeContext()
        let (defaults, suiteName) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let cat = catalog(stapleIds: ["salt", "simple-syrup"])

        Stock.seedStaplesIfNeeded(catalog: cat, context: context, defaults: defaults)
        Stock.toggle("salt", in: context) // the user unstocks a staple
        Stock.seedStaplesIfNeeded(catalog: cat, context: context, defaults: defaults) // no-op: already seeded

        let ids = Set(try context.fetch(FetchDescriptor<StockedNode>()).map(\.nodeId))
        #expect(ids == ["simple-syrup"])
    }
}
