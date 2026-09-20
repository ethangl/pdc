// The Recipes tab: the ranked, sectioned list. See docs/APP.md "Screens"
// and "Makeability and ranking". Recomputing the ranking in `body` costs
// about 8ms over the full catalog (measured in FixtureTests); no caching
// here per docs/APP.md "Architecture".

import SwiftUI
import SwiftData

struct RecipeListView: View {
    @Environment(\.catalog) private var catalog
    @Query private var stocked: [StockedNode]
    @Binding var selectedTab: ContentView.AppTab
    @State private var searchText = ""

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
    }

    /// True until the user stocks anything beyond the seeded staples.
    private var showsFirstLaunchHint: Bool {
        stocked.nodeIds.isSubset(of: catalog.stapleIds)
    }

    private var rankedResults: [RecipeResult] {
        let inventory = Inventory(catalog: catalog, stocked: stocked.nodeIds)
        return Matcher.evaluate(catalog, inventory: inventory).ranked()
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
            guard let results = grouped[bucket], !results.isEmpty else { return nil }
            return BucketSection(bucket: bucket, results: results)
        }
    }
}
