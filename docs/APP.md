# PDC iOS app

Design for the first version of the app. Product decisions are in
`DESIGN.md`; this file says how the app applies them. Decisions here marked
"revisable" are mine and can change without a product discussion.

## Purpose

The app keeps a home-bar inventory and lists every punchdrink.com recipe in
order of how close the user is to making it. A recipe opens as the
punchdrink.com page in an in-app web view. The app shows no recipe text of
its own.

## Decisions (settled 2026-09-20)

- The app lives in this repo under `ios/`. Xcode owns `ios/`; pnpm ignores it.
- The first version bundles `recipes.json` and `taxonomy.json` in the app.
  There is no backend, no account, and no network use except the web view.
  A data update is an app update. Convex may replace the bundle later for
  over-the-air data; the app's models must not need to change for that.
- New Xcode project. Reuse PD2's patterns (SwiftUI, a tab per screen,
  SwiftData for on-device state keyed by a string id). Do not reuse PD2's
  code: it is coupled to Convex and to a schema this project dropped.
- Nothing is hidden. Every recipe is in the list, ranked by makeability.

## Data contract

The app reads two files. Both are produced by this repo's pipeline. The app
must decode them as they are; the pipeline does not change shape for the
app.

`recipes.json` (from `pnpm mapping`):

```
{ generatedAt, taxonomyVersion, recipes: [Recipe] }

Recipe      { slug, name, url, requires: [Requirement],
              optional?: [Requirement], unresolved?: [UnresolvedLine] }
Requirement { nodes: [nodeId], houseMade: bool, raw: string, substitute?: bool }
UnresolvedLine { raw, core }
```

- `nodes` is a set of alternatives. Any one satisfies the requirement
  ("dry prosecco or cava" is `["prosecco", "cava"]`).
- `houseMade` means the recipe expects the user to make it. The node says
  what it is; the punchdrink.com page says how.
- `substitute` means the pipeline placed the line on a family fallback
  (simple syrup or aromatic bitters). The user stocking the fallback node
  satisfies it. The app shows the raw text so the user knows what the
  recipe really wants.
- `optional` lines never affect ranking. The app may show them in the
  detail view.
- `unresolved` lines are ingredients nothing could place. Each one counts as
  one unmet requirement that the inventory can never satisfy. The app shows
  the raw text.

`taxonomy.json` (from `curated/`):

```
{ version, notes, nodes: [Node] }
Node { id, name, parent?, aliases?: [string], staple?: bool, kind?, fallback? }
```

- 495 nodes, 21 roots, depth at most 3. Roots are the browse categories.
- `staple: true` (15 nodes) means stocked by default.
- `aliases` are for search. `kind` and `fallback` are pipeline fields; the
  app ignores them.
- Node ids are the contract between the data and the user's inventory. They
  must not be renamed casually. If a node disappears, the app ignores
  inventory rows that point at it.

### Bundling (revisable)

The raw cache exists only on one machine, so `recipes.json` cannot be
regenerated on a fresh clone. The app therefore commits a snapshot of both
files under `ios/PDC/Resources/`. A script, `pnpm app:data`, copies
`data/recipes.json` and `curated/taxonomy.json` there, minified. Run it after
`pnpm mapping`, and commit the result with the pipeline change that
produced it. Today that is about 1.5 MB for the recipes and 84 KB for the
tree, small enough to ship in the bundle. This is the one committed copy of a generated file, and it is
an app resource, not a data file; `data/` stays gitignored. Paths for the
script live in `scripts/lib/paths.ts`.

## Matching

A requirement is satisfied when the user stocks any node in `nodes`, or any
descendant of one. Stocking "london-dry-gin" satisfies a requirement for
"gin". Stocking "gin" does not satisfy a requirement for "old-tom-gin".

For each recipe:

- `unmet` = requirements with no satisfied node + number of unresolved lines.
- `unmetHouseMade` = the unmet requirements that are house-made, plus the
  unresolved lines.

## Makeability and ranking (first version, revisable)

The list is sorted by `unmet` ascending, then `unmetHouseMade` ascending,
then name. Section headers group the list: "Ready" (0 unmet), "Missing 1",
"Missing 2", "Missing 3 or more". Each row shows the recipe name and, when
not ready, what is missing in one line.

This is deliberately the simplest metric that respects the decision that
nothing is hidden. The open question in `DESIGN.md` (how to weigh a missing
bottle against a missing house-made syrup) is deferred until the list has
been used. The sort key is one function, so changing it later is cheap.

## Inventory

- The user stocks and unstocks taxonomy nodes. Stocked state is a SwiftData
  row per node id (`StockedNode(nodeId, createdAt)`); presence means stocked,
  as in PD2's `BarItem`.
- On first launch the app stocks the 15 staples. After that the user owns
  the list; unstocking a staple sticks.
- The inventory screen is a searchable list grouped by root category.
  Search matches name and aliases. A toggle shows stocked only.
- The user may stock any node, including a category node such as "gin".
  This is allowed and follows the matching rule above.

## Screens

Two tabs, like PD2.

1. **Recipes.** The ranked, sectioned list. Search by name. Tap a row for
   the detail.
2. **Inventory.** The stocked list described above.

**Recipe detail.** Name; a button that opens `url` in
`SFSafariViewController`; the requirement list with each line's raw text,
its state (stocked, missing, house-made, substitute, unresolved), and the
node name it resolved to; the optional lines, marked optional. Tapping a
missing requirement may stock it directly (revisable; cheap and useful).

No favorites, notes, ratings, or sharing in the first version.

## Architecture

- `Catalog`: decodes both files once at launch and holds the recipes, the
  node table, and a parent map. Immutable after load.
- `Matcher`: a pure function from (`Catalog`, stocked node id set) to a
  per-recipe result (`unmet`, `unmetHouseMade`, per-requirement state).
  No SwiftUI, no SwiftData. This is where the unit tests go.
- Views read `@Query` for stocked rows and call `Matcher` to derive the
  list. 3187 recipes and about 14,000 requirements is small enough to
  recompute on every inventory change on the main actor. Measure before
  optimizing.
- Minimum iOS 18, so the `Tab` API is available. Swift 6 language mode.

## Testing

- Unit tests for `Matcher`: alternatives, descendant matching, a category
  node stocked, substitutes, unresolved lines, staples only.
- A cross-check against the pipeline: a TypeScript reference,
  `scripts/makeability.ts`, computes the same per-recipe `unmet` for a
  given stocked set, and a test fixture with the expected counts for
  "staples only" is committed under `ios/PDCTests/`. The Swift matcher must
  reproduce it exactly. This catches a matching-rule drift between the
  pipeline's understanding and the app's.
- Decode test: both bundled files decode with no unknown-key failures.
- Build and run on an arm64 simulator. Verify each screen with a screenshot.

## Work plan

Three phases, each reviewed before the next starts. Each brief carries the
standing rules: no git state changes, `data/source/` and `curated/`
untouched, `pnpm typecheck` and `pnpm test` green.

1. **Data and scaffold.** `pnpm app:data` script and paths; Xcode project
   `ios/PDC`; `Catalog` with `Decodable` models; decode test; the
   TypeScript reference and fixture.
2. **Matcher.** `Matcher` and its unit tests, including the fixture
   cross-check.
3. **Screens.** Recipes list, detail with web view, inventory with staple
   seeding. Simulator screenshots of each.

## Not in the first version

- Favorites and notes (PD2 had them; nothing here needs them yet).
- Any weighting in the makeability metric beyond the two counts.
- Over-the-air data. When Convex returns, it replaces the bundle behind
  `Catalog`.
- Refetching edited recipes (a pipeline item, see `DESIGN.md`).
