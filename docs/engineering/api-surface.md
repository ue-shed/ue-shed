# API surface of the host-facing packages

Plan 058 D13 repeats the `game-text` API review (D1) for the other packages hosts use. The first
step is a measurement, so cuts are made from evidence rather than taste.

## How it is measured

`node scripts/measure-package-exports.ts [--json] [package ...]` reads each package's `exports` map,
asks the TypeScript checker for every name each entry point exports, and scans `apps/`,
`packages/`, `extensions/` and `scripts/` for imports and re-exports of those names by entry point.

- A namespace import, `export *`, or literal dynamic/type import counts all names of that entry point as potentially used. Dynamic imports are found recursively, including inside Effect callbacks; computed module paths cannot be attributed.
- These are conservative upper bounds on used names, rather than member-level usage counts. The JSON field `wholeEntryPointImported` identifies rows where all names are retained conservatively.
- Uses inside the package itself are not counted.
- Uses in other repositories are invisible here. That includes downstream hosts, which matter most for published packages.
- "Unused" means "neither imported by name nor covered by a whole-entry-point import in this repository". It does not mean safe to delete. Many such names are types that appear in the signatures of used exports, error classes callers match on, or test layers documented for hosts.

Run with `--json` for the full lists of unused names per entry point.

## Measurement (2026-10-17, integrated with `main` through #120)

| Package                      | Entry point             | Potentially used / exported | Whole entry point retained |
| ---------------------------- | ----------------------- | --------------------------- | -------------------------- |
| `@ue-shed/protocol`          | `.`                     | 260 / 260                   | yes                        |
| `@ue-shed/unreal-connection` | `.`                     | 21 / 21                     | yes                        |
| `@ue-shed/localization`      | `.`                     | 145 / 145                   | yes                        |
| `@ue-shed/localization`      | `./browser`             | 38 / 124                    | no                         |
| `@ue-shed/unreal-assets`     | `.`                     | 74 / 169                    | no                         |
| `@ue-shed/unreal-assets`     | `./investigation`       | 8 / 9                       | no                         |
| `@ue-shed/unreal-assets`     | `./text-extraction`     | 1 / 1                       | no                         |
| `@ue-shed/unreal-assets`     | `./investigation-files` | 2 / 2                       | no                         |
| `@ue-shed/unreal-assets`     | `./saved-review`        | 7 / 11                      | no                         |
| `@ue-shed/engine`            | `.`                     | 83 / 83                     | yes                        |
| `@ue-shed/cameras`           | `.`                     | 485 / 485                   | yes                        |
| `@ue-shed/cameras`           | `./review-contracts`    | 31 / 40                     | no                         |
| `@ue-shed/cameras`           | `./map-tiles`           | 18 / 59                     | no                         |
| `@ue-shed/cameras`           | `./browser`             | 25 / 279                    | no                         |
| `@ue-shed/host`              | `.`                     | 13 / 13                     | no                         |

Namespace and dynamic consumers retain the complete protocol, connection, localization, engine
and cameras root entry points. In particular, the CLI dynamically imports and calls camera
readiness and selection APIs; these must not appear as unused cut candidates.

The largest remaining gaps are the cameras browser entry (254 of 279 names without a visible
consumer) and the localization browser entry (86 of 124). These numbers exclude downstream
hosts and do not prove a name is safe to remove.

Several published entry points use `export *`, so newly exported module members can become
public without an explicit entry-point decision.

## Cuts

- **`@ue-shed/host`**: a private package with one consumer (decision 9). Its entry point now
  lists its 13 used names; the other 13 (configuration value types, the file-picker layer, the
  saved-table index layer and test layer, the sessions layer) are private.
- **`unreal-connection`, `unreal-assets` and `cameras`**: measurement only. Their published
  export lists and entry points remain unchanged; any cut needs a separate compatibility review.
- **`protocol`, `localization` and `engine`**: published packages with downstream hosts
  whose imports are not visible here. Their unused names are candidates, not cuts. The next step
  for each is the D1 pattern:
    - named-export entry points instead of `export *`;
    - checked against the downstream host's actual imports;
    - private schemas and helpers dropped in the same release.
