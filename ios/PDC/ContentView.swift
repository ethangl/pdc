// App shell: two tabs, per docs/APP.md "Screens". Owns the selected tab so
// the Recipes tab's first-launch hint can switch to Inventory.

import SwiftUI
import SwiftData

struct ContentView: View {
    enum AppTab: Hashable {
        case recipes
        case inventory
    }

    @Environment(\.catalog) private var catalog
    @Environment(\.modelContext) private var modelContext
    @State private var selectedTab: AppTab = .recipes

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("Recipes", systemImage: "wineglass", value: .recipes) {
                RecipeListView(selectedTab: $selectedTab)
            }
            Tab("Inventory", systemImage: "cabinet", value: .inventory) {
                InventoryView()
            }
        }
        .task {
            Stock.seedStaplesIfNeeded(catalog: catalog, context: modelContext)
        }
    }
}
