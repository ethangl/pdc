# Punch Drink Companion design

Status: decisions settled 2026-09-20, implementation starting.

## Purpose

Answer one question: "What drinks can I make?"

The user keeps a home-bar inventory in an iOS app. The app matches the
inventory against punchdrink.com recipes and lists the recipes the user can
make. The app shows a recipe in a web view of the punchdrink.com page. The
app does not store or display recipe text.

## What this project maintains

1. An ingredient tree: canonical ingredients, each with an optional parent.
2. A mapping from each punchdrink.com recipe slug to the set of ingredient
   ids the recipe requires.

Nothing else. No recipe steps, amounts, units, garnish text, or brand data.

## Decisions

### Ingredients

- The tree is generic. Nodes are styles, not brands: "rye whiskey", not
  "Rittenhouse".
- Exception: a product becomes a node when it has no generic style name and
  bartenders call for it by name (Campari, Aperol, Cynar, Suze, Green
  Chartreuse, Bénédictine, Cocchi Americano). These sit flat under their
  category. "Amaro CioCiaro" has parent "amaro", not a sub-style of amaro.
- The tree gets more specific downward. A node satisfies its ancestors.
  "London dry gin" in stock satisfies a "gin" requirement. It does not satisfy
  "old tom gin".
- Every node can be stocked and every node can be required.
- Staples (citrus juice, sugar, simple syrup, salt, water, soda water, egg)
  are ordinary nodes with a `staple` flag. The app stocks them by default.
- Brand recommendations in a recipe ("preferably Dolin") are discarded after
  they help classify the generic ingredient.
- Infusions and washes are modifiers, not ingredients. "Chamomile-infused
  rye" requires "rye whiskey".

### Prepared and house-made ingredients

Most house-made ingredients resolve to a canonical node. "Vanilla syrup (see
editor's note)" maps to a syrup node. The app tells the user the recipe needs
it; the punchdrink.com page tells them how to make it.

Family fallbacks (decided 2026-09-20): when the classifier is confident
about the family but finds no specific node, two families resolve to a
substitute. Syrups resolve to simple syrup. Bitters resolve to aromatic
bitters. The requirement carries `substitute: true` and the original text,
so the app can say "make black tea syrup, recipe on the page" or "any
aromatic bitters will do". The fallback target is declared on the root node
in the tree (`fallback`). Other families have none; their unplaceable
strings stay unresolved and block the recipe.

### Matching

- A recipe is makeable when every required ingredient is satisfied.
- A requirement is satisfied when the user stocks the node or any descendant.
- Alternatives ("manzanilla or fino sherry") are satisfied by either.
- Optional ingredients (", to top", "(optional)", floats, rinses) and garnish
  are ignored for matching.

### Data and persistence

- No backend for now. The tree and the recipe mapping ship as data files in
  the app. Convex is deferred until a shared correction UI or over-the-air
  data updates are needed.
- The raw punchdrink.com cache (`data/source/punchdrink/<slug>.json`, one
  file per recipe, the page's `dataLayer_content`) is the durable source.
  Crawling only adds slugs that are missing from the cache. Discovery uses
  the Algolia index first and the recipe sitemaps as a full fallback, as in
  PD1 and PD2.
- Rebuilds read the cache. They never re-crawl.

### Classification

The classifier runs on the developer's machine during curation. The app
never classifies. Inventory entry in the app is a picker over the tree.

Pipeline for each distinct raw ingredient string:

1. Deterministic preprocessing. Strip HTML, brand recommendations, "see
   editor's note", optional markers, ratios, infusion prefixes, proof and age
   qualifiers, and leading modifiers. Split alternatives. Record flags:
   `houseMade`, `optional`, `infused`, `garnishLike`.
2. Classification with Jev (typesafe.ai) on the cleaned string. Two Choice
   questions in sequence: root category, then node within that category's
   subtree (the category itself is an option, meaning "generic"). Jev
   documents Choice as reliable to about 240 options; the second level stays
   well under that. Yes/no Noul questions ride along in the same request
   where useful (is this a brand, is this a preparation).
3. Subtree collapse. Low confidence on the second question is usually
   probability split between a node and its ancestor ("gin" 0.51 versus
   "London dry gin" 0.47 for a brand name that states no style). The
   classifier sums probability over each candidate's subtree and picks the
   most specific node whose subtree mass is at least 0.9. A brand with no
   stated style therefore resolves to the generic node, which is the correct
   answer under the matching rules.
4. Confidence gating. Accept at or above 0.9. Queue the rest for manual
   review. Results are cached by (string, tree version, prompt version) in
   `data/cache/jev/` and summarized in `data/classifications.json`.
5. Manual overrides in `data/overrides.json` win over the classifier.

Why Jev: the problem is a closed-set decision with a need for calibrated
confidence, which is what Jev is built for. The first live run (60 strings,
2026-09-20) had 24 accepted, all correct, and 27 in review that were mostly
right at the generic level. Brand knowledge is good for spirits and weaker
for obscure amari and one-off products. Input costs $0.042 per million
tokens with free output, so classifying the whole tail costs well under a
dollar and can be repeated freely after tree or prompt changes.

## Data files

Rule: everything under `data/` is generated or cached and is gitignored.
Anything committed lives in `curated/`.

Committed, in `curated/`:

- `taxonomy.json`: the ingredient tree. Hand-edited.
- `overrides.json`: hand-edited. Maps a preprocessed string to a node id, or
  to null to mean "not an ingredient, drop the line". Wins over the
  classifier.
- `classifications.json`: written by `pnpm classify`. One record per
  preprocessed string the tree does not alias, with the chosen node, both
  confidences, and a status of accepted, fallback, review, none, or
  override. Committed because Jev is not deterministic: this file is the
  record of which answers were accepted, like a lockfile. Regenerate it on
  purpose, not as a side effect.

Generated, in `data/`, never committed:

- `source/punchdrink/`: the raw cache, one file per recipe slug. The only
  copy is local; it needs a backup outside git.
- `cache/`: raw Jev responses and review lists.
- `ingredients-raw.json`, `ingredients-preprocessed.json`: from
  `pnpm extract`. Distinct ingredient strings with counts, before and after
  preprocessing. Inputs to curation.
- `recipes.json`: from `pnpm mapping`. The app-facing file. One entry per
  recipe: slug, name, punchdrink.com URL, `requires` (each a set of node ids
  where any one satisfies, with `houseMade` and `substitute` flags),
  `optional` (garnish, toppings, floats), and `unresolved` (lines nothing
  could place). How the app obtains it (bundled at build or served by
  Convex) is decided when the app exists.

Resolution order for one ingredient line: preprocess, then override, then
tree alias, then accepted classification. A line whose flags mark it
optional or garnish-like never blocks a recipe.

## Operating model

Design and review happen in the expensive model. Code is written by a cheaper
model from a written brief. Design notes live in `docs/`.

## App behavior settled

- The app shows near-miss recipes: those missing exactly one requirement.

## Open questions

- Substitutes for unplaceable strings outside the syrup and bitters families
  (house mixes, one-off liqueurs).
- When Convex comes back: shared review UI, or over-the-air data only.
