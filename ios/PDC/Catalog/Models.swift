// Decodable models for the two bundled data files. Field names and
// optionality match docs/APP.md's data contract, checked against the real
// data/recipes.json and curated/taxonomy.json. See Catalog.swift for
// loading and CatalogTests.swift for the decode checks.

import Foundation

// MARK: - recipes.json

struct Requirement: Decodable, Sendable, Hashable {
    let nodes: [String]
    let houseMade: Bool
    let raw: String
    let substitute: Bool?
}

struct UnresolvedLine: Decodable, Sendable, Hashable {
    let raw: String
    let core: String
}

struct Recipe: Decodable, Sendable, Identifiable, Hashable {
    let slug: String
    let name: String
    let url: String
    let requires: [Requirement]
    let optional: [Requirement]?
    let unresolved: [UnresolvedLine]?

    var id: String { slug }
}

struct RecipesFile: Decodable, Sendable {
    let generatedAt: String
    let taxonomyVersion: Int
    let recipes: [Recipe]
}

// MARK: - taxonomy.json

struct TaxonomyNode: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let parent: String?
    let aliases: [String]?
    let staple: Bool?
    /// Pipeline field ("category" or absent); the app ignores its value but
    /// decodes it so an unknown-key concern never arises.
    let kind: String?
    /// Pipeline field, the family fallback target; the app ignores it.
    let fallback: String?
}

struct TaxonomyFile: Decodable, Sendable {
    let version: Int
    let notes: [String]
    let nodes: [TaxonomyNode]
}
