// Decodable models for the two bundled data files. Field names match
// docs/APP.md's data contract, checked against the real data/recipes.json
// and curated/taxonomy.json. A field the contract marks optional decodes to
// a default instead of an optional, so callers never handle absence twice.
// See Catalog.swift for loading and CatalogTests.swift for the decode
// checks.

import Foundation

// MARK: - recipes.json

struct Requirement: Decodable, Sendable, Hashable {
    let nodes: [String]
    let houseMade: Bool
    let raw: String
    let substitute: Bool

    init(nodes: [String], houseMade: Bool, raw: String, substitute: Bool = false) {
        self.nodes = nodes
        self.houseMade = houseMade
        self.raw = raw
        self.substitute = substitute
    }

    private enum CodingKeys: String, CodingKey {
        case nodes, houseMade, raw, substitute
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        nodes = try container.decode([String].self, forKey: .nodes)
        houseMade = try container.decode(Bool.self, forKey: .houseMade)
        raw = try container.decode(String.self, forKey: .raw)
        substitute = try container.decodeIfPresent(Bool.self, forKey: .substitute) ?? false
    }
}

struct UnresolvedLine: Decodable, Sendable, Hashable {
    let raw: String
    let core: String
}

struct Recipe: Decodable, Sendable, Identifiable, Hashable {
    let slug: String
    let name: String
    let url: URL
    let requires: [Requirement]
    let optional: [Requirement]
    let unresolved: [UnresolvedLine]

    var id: String { slug }

    init(
        slug: String,
        name: String,
        url: URL,
        requires: [Requirement],
        optional: [Requirement] = [],
        unresolved: [UnresolvedLine] = []
    ) {
        self.slug = slug
        self.name = name
        self.url = url
        self.requires = requires
        self.optional = optional
        self.unresolved = unresolved
    }

    private enum CodingKeys: String, CodingKey {
        case slug, name, url, requires, optional, unresolved
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        slug = try container.decode(String.self, forKey: .slug)
        name = try container.decode(String.self, forKey: .name)
        url = try container.decode(URL.self, forKey: .url)
        requires = try container.decode([Requirement].self, forKey: .requires)
        optional = try container.decodeIfPresent([Requirement].self, forKey: .optional) ?? []
        unresolved = try container.decodeIfPresent([UnresolvedLine].self, forKey: .unresolved) ?? []
    }
}

struct RecipesFile: Decodable, Sendable {
    let taxonomyVersion: Int
    let recipes: [Recipe]
}

// MARK: - taxonomy.json

struct TaxonomyNode: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let parent: String?
    let aliases: [String]
    let staple: Bool

    init(id: String, name: String, parent: String? = nil, aliases: [String] = [], staple: Bool = false) {
        self.id = id
        self.name = name
        self.parent = parent
        self.aliases = aliases
        self.staple = staple
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, parent, aliases, staple
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        parent = try container.decodeIfPresent(String.self, forKey: .parent)
        aliases = try container.decodeIfPresent([String].self, forKey: .aliases) ?? []
        staple = try container.decodeIfPresent(Bool.self, forKey: .staple) ?? false
    }
}

struct TaxonomyFile: Decodable, Sendable {
    let version: Int
    let nodes: [TaxonomyNode]
}
