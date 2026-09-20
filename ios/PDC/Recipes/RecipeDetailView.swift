// The recipe detail screen. See docs/APP.md "Screens". Takes the
// RecipeResult from the list so it does not re-evaluate the whole catalog,
// but recomputes this one recipe's requirement results from the current
// inventory so stocking from this screen updates its own rows.

import SwiftUI
import SwiftData

struct RecipeDetailView: View {
    let result: RecipeResult

    @Environment(\.catalog) private var catalog
    @Environment(\.modelContext) private var modelContext
    @Query private var stocked: [StockedNode]
    @State private var isShowingSafari = false

    var body: some View {
        List {
            Section {
                Text(result.recipe.name)
                    .font(.title2.bold())

                Button {
                    isShowingSafari = true
                } label: {
                    Text("Open on punchdrink.com")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .listRowInsets(EdgeInsets())
                .padding(8)
            }

            Section("Ingredients") {
                ForEach(Array(requirementResults.enumerated()), id: \.offset) { _, requirementResult in
                    ingredientRow(requirementResult)
                }
            }

            if let unresolved = result.recipe.unresolved, !unresolved.isEmpty {
                Section("Not in the ingredient list") {
                    ForEach(Array(unresolved.enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line.raw)
                            Text("See the recipe page")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let optional = result.recipe.optional, !optional.isEmpty {
                Section("Optional") {
                    ForEach(Array(optional.enumerated()), id: \.offset) { _, requirement in
                        Text(requirement.raw)
                    }
                }
            }
        }
        .navigationTitle(result.recipe.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $isShowingSafari) {
            if let url = URL(string: result.recipe.url) {
                SafariView(url: url)
            }
        }
    }

    /// This recipe's requirements re-evaluated against the current
    /// inventory, so a stock/unstock from this screen is reflected here.
    /// Delegates to Matcher's single-recipe evaluate, the one copy of the
    /// matching rule, rather than re-running it over the whole catalog.
    private var requirementResults: [RequirementResult] {
        let inventory = Inventory(catalog: catalog, stocked: Set(stocked.map(\.nodeId)))
        return Matcher.evaluate(result.recipe, inventory: inventory).requirements
    }

    @ViewBuilder
    private func ingredientRow(_ requirementResult: RequirementResult) -> some View {
        switch requirementResult.status {
        case .stocked(let providerId):
            VStack(alignment: .leading, spacing: 2) {
                Text(requirementResult.requirement.raw)
                Text("Have: \(nodeName(providerId))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .missing:
            missingRow(requirementResult.requirement)
        }
    }

    @ViewBuilder
    private func missingRow(_ requirement: Requirement) -> some View {
        let label = VStack(alignment: .leading, spacing: 2) {
            Text(requirement.raw)
            Text(missingSubtitle(requirement))
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if requirement.nodes.count == 1 {
            Button {
                Stock.toggle(requirement.nodes[0], in: modelContext)
            } label: {
                label
            }
            .buttonStyle(.plain)
        } else {
            Menu {
                ForEach(requirement.nodes, id: \.self) { nodeId in
                    Button(nodeName(nodeId)) {
                        Stock.toggle(nodeId, in: modelContext)
                    }
                }
            } label: {
                label
            }
        }
    }

    private func missingSubtitle(_ requirement: Requirement) -> String {
        var parts = ["Missing"]
        if requirement.houseMade { parts.append("house-made") }
        if requirement.substitute == true, let first = requirement.nodes.first {
            parts.append("any \(nodeName(first)) works")
        }
        return parts.joined(separator: " · ")
    }

    private func nodeName(_ nodeId: String) -> String {
        catalog.nodesById[nodeId]?.name ?? nodeId
    }
}
