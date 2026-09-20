// The Inventory tab: a searchable list grouped by root category. See
// docs/APP.md "Inventory". Catalog.browseSections holds the root -> subtree
// grouping, computed once when the catalog loads.

import SwiftUI
import SwiftData

struct InventoryView: View {
    @Environment(\.catalog) private var catalog
    @Environment(\.modelContext) private var modelContext
    @Query private var stocked: [StockedNode]
    @State private var searchText = ""
    @State private var showsStockedOnly = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(filteredSections) { section in
                    Section(section.root.name) {
                        ForEach(section.nodes) { node in
                            InventoryRow(node: node, isStocked: stocked.nodeIds.contains(node.id)) {
                                Stock.toggle(node.id, in: modelContext)
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
    }

    private func matchesSearch(_ node: TaxonomyNode) -> Bool {
        guard !searchText.isEmpty else { return true }
        if node.name.localizedStandardContains(searchText) { return true }
        return node.aliases.contains { $0.localizedStandardContains(searchText) }
    }

    /// `catalog.browseSections` narrowed by "stocked only" and the search
    /// text; a section with no matching rows is dropped.
    private var filteredSections: [Catalog.BrowseSection] {
        let stockedIds = stocked.nodeIds
        return catalog.browseSections.compactMap { section in
            let nodes = section.nodes.filter { node in
                (!showsStockedOnly || stockedIds.contains(node.id)) && matchesSearch(node)
            }
            return nodes.isEmpty ? nil : Catalog.BrowseSection(root: section.root, nodes: nodes)
        }
    }
}
