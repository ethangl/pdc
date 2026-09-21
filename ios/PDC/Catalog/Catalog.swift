// Decodes the two bundled data files once and holds them for the app's
// lifetime: the recipes, the node table, the staple ids, and the browse
// sections for the Inventory screen. Immutable after load. See
// docs/APP.md "Architecture".

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
    /// One browse category: a root node and its whole subtree, for the
    /// Inventory screen. See docs/APP.md "Inventory".
    struct BrowseSection: Identifiable, Sendable {
        let root: TaxonomyNode
        /// The root and every descendant, sorted by name.
        let nodes: [TaxonomyNode]
        var id: String { root.id }
    }

    let recipes: [Recipe]
    let nodesById: [String: TaxonomyNode]
    let taxonomyVersion: Int
    let stapleIds: Set<String>
    /// Roots sorted by name, each with its subtree. Computed once here.
    let browseSections: [BrowseSection]

    init(recipes: [Recipe], nodes: [TaxonomyNode], taxonomyVersion: Int) {
        self.recipes = recipes
        self.taxonomyVersion = taxonomyVersion

        var nodesById: [String: TaxonomyNode] = [:]
        nodesById.reserveCapacity(nodes.count)
        var childrenByParent: [String: [String]] = [:]
        for node in nodes {
            nodesById[node.id] = node
            if let parent = node.parent {
                childrenByParent[parent, default: []].append(node.id)
            }
        }
        self.nodesById = nodesById
        self.stapleIds = Set(nodes.filter(\.staple).map(\.id))

        func subtree(of id: String) -> [String] {
            var result: [String] = [id]
            var stack = childrenByParent[id, default: []]
            while let nextId = stack.popLast() {
                result.append(nextId)
                stack.append(contentsOf: childrenByParent[nextId, default: []])
            }
            return result
        }

        self.browseSections = nodes
            .filter { $0.parent == nil }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            .map { root in
                let sectionNodes = subtree(of: root.id)
                    .compactMap { nodesById[$0] }
                    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                return BrowseSection(root: root, nodes: sectionNodes)
            }
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

        return Catalog(
            recipes: recipesFile.recipes,
            nodes: taxonomyFile.nodes,
            taxonomyVersion: taxonomyFile.version
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

    /// The node's name, or the id itself when the node is unknown.
    func name(of nodeId: String) -> String {
        nodesById[nodeId]?.name ?? nodeId
    }
}
