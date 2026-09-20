// Decodes the two bundled data files once and holds them for the app's
// lifetime. Immutable after load. See docs/APP.md "Architecture": the
// matching rule itself (`satisfies`) lives in Phase 2's Matcher, not here.

import Foundation

enum CatalogError: Error, CustomStringConvertible {
    case missingResource(String)
    case taxonomyVersionMismatch(recipesVersion: Int, taxonomyVersion: Int)

    var description: String {
        switch self {
        case .missingResource(let name):
            return "Missing bundled resource: \(name)"
        case .taxonomyVersionMismatch(let recipesVersion, let taxonomyVersion):
            return "recipes.json taxonomyVersion (\(recipesVersion)) does not match taxonomy.json version (\(taxonomyVersion))"
        }
    }
}

struct Catalog: Sendable {
    let recipes: [Recipe]
    let nodesById: [String: TaxonomyNode]
    let taxonomyVersion: Int
    let stapleIds: Set<String>
    /// Node id -> its children's ids. Derived once here, from `nodesById`,
    /// so `descendants(of:)` can walk it instead of rescanning every node.
    private let childrenByParent: [String: [String]]

    init(recipes: [Recipe], nodesById: [String: TaxonomyNode], taxonomyVersion: Int, stapleIds: Set<String>) {
        self.recipes = recipes
        self.nodesById = nodesById
        self.taxonomyVersion = taxonomyVersion
        self.stapleIds = stapleIds

        var childrenByParent: [String: [String]] = [:]
        for node in nodesById.values {
            guard let parent = node.parent else { continue }
            childrenByParent[parent, default: []].append(node.id)
        }
        self.childrenByParent = childrenByParent
    }

    static func load(from bundle: Bundle) throws -> Catalog {
        guard let recipesURL = bundle.url(forResource: "recipes", withExtension: "json") else {
            throw CatalogError.missingResource("recipes.json")
        }
        guard let taxonomyURL = bundle.url(forResource: "taxonomy", withExtension: "json") else {
            throw CatalogError.missingResource("taxonomy.json")
        }

        let decoder = JSONDecoder()
        let recipesFile = try decoder.decode(RecipesFile.self, from: Data(contentsOf: recipesURL))
        let taxonomyFile = try decoder.decode(TaxonomyFile.self, from: Data(contentsOf: taxonomyURL))

        guard recipesFile.taxonomyVersion == taxonomyFile.version else {
            throw CatalogError.taxonomyVersionMismatch(
                recipesVersion: recipesFile.taxonomyVersion,
                taxonomyVersion: taxonomyFile.version
            )
        }

        var nodesById: [String: TaxonomyNode] = [:]
        nodesById.reserveCapacity(taxonomyFile.nodes.count)
        for node in taxonomyFile.nodes {
            nodesById[node.id] = node
        }
        let stapleIds = Set(taxonomyFile.nodes.filter { $0.staple == true }.map(\.id))

        return Catalog(
            recipes: recipesFile.recipes,
            nodesById: nodesById,
            taxonomyVersion: taxonomyFile.version,
            stapleIds: stapleIds
        )
    }

    /// Parent, grandparent, ... up to the root, nearest first. Empty for a
    /// root node or an unknown id. Guards a malformed cycle by stopping once
    /// an id repeats.
    func ancestors(of id: String) -> [String] {
        var result: [String] = []
        var seen: Set<String> = [id]
        var cursor = id
        while let node = nodesById[cursor], let parent = node.parent {
            if seen.contains(parent) { break } // guards a malformed cycle
            result.append(parent)
            seen.insert(parent)
            cursor = parent
        }
        return result
    }

    /// Every node with no parent (the browse categories), sorted by name.
    var roots: [TaxonomyNode] {
        nodesById.values
            .filter { $0.parent == nil }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Every descendant of `id` at any depth, not including `id` itself.
    /// Order is not significant. Used by the Inventory screen to list a
    /// root's subtree; see docs/APP.md "Inventory".
    func descendants(of id: String) -> [String] {
        var result: [String] = []
        var stack = childrenByParent[id] ?? []
        while let nextId = stack.popLast() {
            result.append(nextId)
            stack.append(contentsOf: childrenByParent[nextId] ?? [])
        }
        return result
    }
}
