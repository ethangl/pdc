// App entry point. Decodes the Catalog once and puts it in the SwiftUI
// environment. A missing bundled resource is a build defect, so the
// failure path is a plain error screen, not something to recover from at
// runtime. See docs/APP.md "Architecture".

import SwiftUI
import SwiftData

@main
struct PDCApp: App {
    private let catalogResult: Result<Catalog, Error>

    init() {
        catalogResult = Result { try Catalog.load(from: .main) }
    }

    var body: some Scene {
        WindowGroup {
            switch catalogResult {
            case .success(let catalog):
                ContentView()
                    .environment(\.catalog, catalog)
            case .failure(let error):
                Text("Failed to load catalog: \(error)")
                    .padding()
            }
        }
        .modelContainer(for: StockedNode.self)
    }
}

private struct CatalogKey: EnvironmentKey {
    static let defaultValue = Catalog(recipes: [], nodes: [], taxonomyVersion: 0)
}

extension EnvironmentValues {
    var catalog: Catalog {
        get { self[CatalogKey.self] }
        set { self[CatalogKey.self] = newValue }
    }
}
