# Punch Drink Companion

## This file

AGENTS.md holds the rules for working in this repository and nothing else. It
is not a status report: no "current state", progress notes, or descriptions of
what anything does. That belongs in the application's README and in `docs/`.

## Files

- `data/` is gitignored. It holds only generated or cached files.
- Committed inputs (the ingredient tree, overrides, accepted
  classifications) live in `curated/`. Never add a committed file under
  `data/`.
- Scripts take paths from `scripts/lib/paths.ts`, not from literals.

## Communication

Be clear and concise in your communication and PR descriptions. Do not invent
terminology. Use ASD-STE100. Do not add code attribution to commits or PR
descriptions.
