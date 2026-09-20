// One row of the ranked recipe list. See docs/APP.md "Makeability and
// ranking": ready rows show no subtitle.

import SwiftUI

struct RecipeRow: View {
    let result: RecipeResult

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(result.recipe.name)
            if let missing = missingSummary {
                Text(missing)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    /// The raw text of each missing requirement and each unresolved line,
    /// joined for a one-line summary. Nil for a ready recipe.
    private var missingSummary: String? {
        guard result.unmet > 0 else { return nil }
        var parts = result.requirements
            .filter { $0.status == .missing }
            .map(\.requirement.raw)
        parts.append(contentsOf: result.recipe.unresolved.map(\.raw))
        return parts.joined(separator: ", ")
    }
}
