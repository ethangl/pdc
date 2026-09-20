// Section grouping and sort order for the ranked recipe list. See
// docs/APP.md "Makeability and ranking".

import Foundation

enum MakeabilityBucket: Int, CaseIterable, Sendable, Hashable {
    case ready
    case missingOne
    case missingTwo
    case missingThreeOrMore

    init(unmet: Int) {
        switch unmet {
        case 0: self = .ready
        case 1: self = .missingOne
        case 2: self = .missingTwo
        default: self = .missingThreeOrMore
        }
    }

    var title: String {
        switch self {
        case .ready: return "Ready"
        case .missingOne: return "Missing 1"
        case .missingTwo: return "Missing 2"
        case .missingThreeOrMore: return "Missing 3 or more"
        }
    }
}

extension Array where Element == RecipeResult {
    /// Sorted by unmet ascending, then unmetHouseMade ascending, then name,
    /// then slug as the final tiebreak so the order is total.
    func ranked() -> [RecipeResult] {
        sorted { lhs, rhs in
            if lhs.unmet != rhs.unmet { return lhs.unmet < rhs.unmet }
            if lhs.unmetHouseMade != rhs.unmetHouseMade { return lhs.unmetHouseMade < rhs.unmetHouseMade }
            let nameOrder = lhs.recipe.name.localizedStandardCompare(rhs.recipe.name)
            if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
            return lhs.recipe.slug < rhs.recipe.slug
        }
    }
}
