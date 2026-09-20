// The Recipes tab: the ranked, sectioned list. See docs/APP.md "Screens"
// and "Makeability and ranking". The ranking is recomputed when the stocked
// set changes and held in state, so typing in the search field filters the
// held list instead of re-evaluating the catalog on every keystroke.
// FixtureTests bounds the cost of one recomputation.

import SwiftUI
import SwiftData

struct RecipeListView: View {
    @Environment(\.catalog) private var catalog
    @Query private var stocked: [StockedNode]
    @Binding var selectedTab: ContentView.AppTab
    @State private var searchText = ""
    @State private var rankedResults: [RecipeResult] = []

    var body: some View {
        NavigationStack {
            List {
                if showsFirstLaunchHint {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Stock your bar to see what you can make")
                            Button("Go to Inventory") {
                                selectedTab = .inventory
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                ForEach(sections, id: \.bucket) { section in
                    Section {
                        ForEach(section.results) { result in
                            NavigationLink(value: result.recipe) {
                                RecipeRow(result: result)
                            }
                        }
                    } header: {
                        Text("\(section.bucket.title) (\(section.results.count))")
                    }
                }
            }
            .navigationTitle("Recipes")
            .searchable(text: $searchText)
            .navigationDestination(for: Recipe.self) { recipe in
                RecipeDetailView(recipe: recipe)
            }
        }
        .onChange(of: stocked.nodeIds, initial: true) { _, stockedIds in
            let inventory = Inventory(catalog: catalog, stocked: stockedIds)
            rankedResults = Matcher.evaluate(catalog, inventory: inventory).ranked()
        }
    }

    /// True until the user stocks anything beyond the seeded staples.
    private var showsFirstLaunchHint: Bool {
        stocked.nodeIds.isSubset(of: catalog.stapleIds)
    }

    private var filteredResults: [RecipeResult] {
        guard !searchText.isEmpty else { return rankedResults }
        return rankedResults.filter { $0.recipe.name.localizedStandardContains(searchText) }
    }

    private struct BucketSection {
        let bucket: MakeabilityBucket
        let results: [RecipeResult]
    }

    private var sections: [BucketSection] {
        let filtered = filteredResults
        let grouped = Dictionary(grouping: filtered) { MakeabilityBucket(unmet: $0.unmet) }
        return MakeabilityBucket.allCases.compactMap { bucket in
            grouped[bucket].map { BucketSection(bucket: bucket, results: $0) }
        }
    }
}
