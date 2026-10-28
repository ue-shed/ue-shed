# Unreal code text

`unreal-code` finds the text in an Unreal project's code (C++, config and String Table CSVs) the way Unreal's
`GatherTextFromSource` commandlet does: `LOCTEXT` and its family, `UI_COMMAND`, String Tables
declared in code and imported from CSV, localized log and error macros, `#define` wrappers around
them, and `NSLOCTEXT` in config files. Plan 060 introduces it; Game Text is its first consumer.

It is a port of the commandlet, not a C++ parser, and is never smarter than Unreal. It follows no
includes, evaluates no `#if`, and resolves no constants. A key Unreal would gather is a place here,
with the same namespace, key, text and location, and nothing else is.

## How it scans

- **Two tiers.** A file whose bytes hold none of the descriptors' tokens cannot produce text, so an
  Aho-Corasick pass skips it. The rest go through a port of `ParseSourceText` on UTF-16 code units:
  per-character token counters that never restart a partial match (`MYLOCTEXT(` gathers,
  `LLOCTEXT(` does not), the longest-token deferral, the comment and string state, and argument
  gathering that reads ahead into later lines without consuming them.
- **Wrappers.** `find_wrappers` is the 5.x prepass. Unreal runs it over `*.cpp` and `*.h` under the
  engine's and the project's `Source` and `Plugins`, whatever the target's scope; callers can keep
  the engine's part per engine build. A wrapper whose body holds `NSLOCTEXT` also registers as a
  `LOCTEXT` wrapper, and the two defer to each other forever; the scan reports those.
- **String Tables** are built from the calls in file order: per file on 5.x, across the project on
  4.27. The first registration, entry and metadata value win. CSVs go through a port of
  `FCsvParser`.
- **Engine lines.** `EngineLine::Ue4_27`, `Ue5_7` (5.0 to 5.7) and `Ue5_8` pick the descriptor
  table and the version differences: one-line arguments and a three-argument `UI_COMMAND` on 4.27;
  developer notes, `UE_DECLARE_ERROR` and dropping whitespace-only text on 5.8.

`CodePlace` records every gathered place with `editorOnly` and `gathered`, so text a target
leaves out stays visible as out of scope. `CodeDiagnostic` carries what Unreal would log.

## Conformance

`tests/conformance.rs` scans the fixture's `FixtureSource/UnrealSource` cases and compares them, row
for row, with the manifests Unreal 4.27, 5.7 and 5.8 wrote for the same recipes
(`fixtures/unreal-project/FixtureExpected/unreal-code`). Regenerate those with
`pnpm fixture:generate-unreal-code` (once per 5.x engine) and
`pnpm fixture:generate-unreal-code-427`.

Known approximations, none of them seen in the fixture:

- Invalid UTF-8 becomes `?` per byte; whitespace outside ASCII follows Rust's Unicode tables in
  place of the C runtime's `iswspace`.
- Case-insensitive comparisons fold ASCII only, as Unreal's string compare does.
- Where Unreal sorts unstably (wrapper pruning, parameter replacement order), this sorts stably.
- The manifest's own rules are left to the consumer: it keeps the first location of a repeated
  namespace and key, and skips keys already in a dependency manifest.
