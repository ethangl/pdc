// One row of the Inventory tab. See docs/APP.md "Inventory".

import SwiftUI

struct InventoryRow: View {
    let node: TaxonomyNode
    let isStocked: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack {
                Text(node.name)
                    .foregroundStyle(.primary)
                Spacer()
                if isStocked {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
