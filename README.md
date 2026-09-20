# Punch Drink Companion (PDC)

PDC is an iOS app that keeps a home-bar inventory and matches it against
punchdrink.com recipes. Recipes open in a web view; this project only
maintains an ingredient tree and the mapping from each recipe to the tree.
Design and decisions are in `docs/DESIGN.md`.

## Commands

- `pnpm install` — install dependencies.
- `pnpm typecheck` — type-check the scripts.
- `pnpm test` — run the preprocessing and line-resolution test cases.
- `pnpm crawl` — add recipes that are missing from the raw cache. Discovers
  new slugs from the Algolia index (needs `ALGOLIA_APP_ID` and
  `ALGOLIA_API_KEY` in `.env.local`), or from the recipe sitemaps with
  `--sitemap`. Flags: `--limit N`, `--dry-run`. Run the curation loop after.
- `pnpm extract` — read the cached recipes and write
  `data/ingredients-raw.json` and `data/ingredients-preprocessed.json`.
- `pnpm taxonomy:check` — validate `curated/taxonomy.json` and print the tree.
- `pnpm coverage` — report how many ingredient lines the tree's aliases
  resolve, and list the strings they do not.
- `pnpm classify` — classify unresolved strings with Jev (needs
  `TYPESAFE_API_KEY` in `.env.local`). Cached under `data/cache/jev/`.
  Flags: `--limit N`, `--min-count N`, `--only-review`, `--refresh`,
  `--dry-run`.
- `pnpm mapping` — write `data/recipes.json`, the app-facing file.

Curation loop after a change to the tree, the preprocessor, or the overrides:

```bash
pnpm extract && pnpm coverage && pnpm classify && pnpm mapping
```

## Data

- `curated/taxonomy.json` — the ingredient tree. Hand-edited.
- `curated/overrides.json` — hand-edited string to node corrections. Win over
  the classifier. `null` means "not an ingredient".
- `curated/classifications.json` — classifier output, committed.
- `data/` — generated, gitignored: `data/source/` (raw cache),
  `data/cache/` (Jev responses, review lists), `data/ingredients-raw.json`,
  `data/ingredients-preprocessed.json`, and `data/recipes.json` (the mapping
  the app ships). A taxonomy family node's `fallback` gives a classifier hit
  that lands in the family but not at a specific node a stand-in node
  instead of leaving it unresolved; the requirement is then marked
  `substitute` so the app can say so.

## Cache policy

`data/source/punchdrink/` is the durable raw cache: one `<slug>.json` file per
recipe, holding the page's `dataLayer_content` plus `recipeName`. It is
gitignored and copied in from the prior project. A future crawl step only
adds slugs that are missing; it never refetches or overwrites what is already
cached.
