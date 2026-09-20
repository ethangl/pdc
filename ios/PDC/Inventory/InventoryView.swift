// The Inventory tab: a searchable list grouped by root category. See
// docs/APP.md "Inventory". The root -> node-id grouping is catalog-derived
// and never changes, so it is built once (via Catalog.descendants(of:))
// and cached in state rather than recomputed on every render.

import SwiftUI
import SwiftData

struct InventoryView: View {
    private struct RootSection: Identifiable {
        let root: TaxonomyNode
        let nodeIds: [String]
        var id: String { root.id }
    }

    @Environment(\.catalog) private var catalog
    @Environment(\.modelContext) private var modelContext
    @Query private var stocked: [StockedNode]
    @State private var searchText = ""
    @State private var showsStockedOnly = false
    @State private var rootSections: [RootSection] = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(filteredSections) { section in
                    Section(section.root.name) {
                        ForEach(section.nodeIds, id: \.self) { nodeId in
                            if let node = catalog.nodesById[nodeId] {
                                InventoryRow(node: node, isStocked: stockedIds.contains(nodeId)) {
                                    Stock.toggle(nodeId, in: modelContext)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Inventory")
            .searchable(text: $searchText)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Toggle("Stocked only", isOn: $showsStockedOnly)
                        .toggleStyle(.button)
                }
            }
        }
        .task {
            if rootSections.isEmpty {
                rootSections = buildRootSections()
            }
        }
    }

    private var stockedIds: Set<String> {
        Set(stocked.map(\.nodeId))
    }

    private func buildRootSections() -> [RootSection] {
        catalog.roots.map { root in
            let ids = ([root.id] + catalog.descendants(of: root.id)).sorted {
                nodeName($0).localizedStandardCompare(nodeName($1)) == .orderedAscending
            }
            return RootSection(root: root, nodeIds: ids)
        }
    }

    private func nodeName(_ nodeId: String) -> String {
        catalog.nodesById[nodeId]?.name ?? nodeId
    }

    private func matchesSearch(_ nodeId: String) -> Bool {
        guard !searchText.isEmpty else { return true }
        guard let node = catalog.nodesById[nodeId] else { return false }
        if node.name.localizedStandardContains(searchText) { return true }
        return (node.aliases ?? []).contains { $0.localizedStandardContains(searchText) }
    }

    /// The cached sections, narrowed by "stocked only" and the search text;
    /// a section with no matching rows is dropped.
    private var filteredSections: [RootSection] {
        rootSections.compactMap { section in
            let ids = section.nodeIds.filter { nodeId in
                (!showsStockedOnly || stockedIds.contains(nodeId)) && matchesSearch(nodeId)
            }
            return ids.isEmpty ? nil : RootSection(root: section.root, nodeIds: ids)
        }
    }
}
