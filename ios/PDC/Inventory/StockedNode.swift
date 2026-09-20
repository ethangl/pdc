// On-device inventory. Presence of a row means the node is stocked, as in
// PD2's BarItem. See docs/APP.md "Inventory".

import Foundation
import SwiftData

@Model
final class StockedNode {
    @Attribute(.unique) var nodeId: String
    var createdAt: Date

    init(nodeId: String, createdAt: Date = Date()) {
        self.nodeId = nodeId
        self.createdAt = createdAt
    }
}

extension Array where Element == StockedNode {
    /// The stocked node ids, as a set for O(1) membership checks.
    var nodeIds: Set<String> {
        Set(map(\.nodeId))
    }
}

/// Mutates the inventory. Views read `@Query` for the current rows; this
/// enum only writes.
@MainActor
enum Stock {
    /// Implementation detail of `seedStaplesIfNeeded`; not needed outside
    /// this enum since tests inject their own `UserDefaults` instance.
    private static let didSeedStaplesKey = "didSeedStaples"

    /// Stocks `nodeId` if it isn't stocked, unstocks it if it is.
    static func toggle(_ nodeId: String, in context: ModelContext) {
        let descriptor = FetchDescriptor<StockedNode>(predicate: #Predicate { $0.nodeId == nodeId })
        if let existing = try? context.fetch(descriptor).first {
            context.delete(existing)
        } else {
            context.insert(StockedNode(nodeId: nodeId))
        }
    }

    /// Stocks every staple, once per install. After that the user owns the
    /// list, so this never runs again even if every staple gets unstocked.
    /// `defaults` is injectable so tests don't share process-global state.
    static func seedStaplesIfNeeded(catalog: Catalog, context: ModelContext, defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: didSeedStaplesKey) else { return }
        for nodeId in catalog.stapleIds {
            context.insert(StockedNode(nodeId: nodeId))
        }
        defaults.set(true, forKey: didSeedStaplesKey)
    }
}
