# Game Text test corpus

`pnpm corpus:generate` writes a deterministic Game Text corpus into an Unreal project. Use it to
check scan speed, the interface at scale, and the saved-package reader on real project content.
It is a development tool and is not part of any release.

```sh
pnpm corpus:generate --project D:/Projects/MyGame/MyGame.uproject --lines 10000 --seed 1
```

| Option          | Default                                  | Meaning                                           |
| --------------- | ---------------------------------------- | ------------------------------------------------- |
| `--project`     | required                                 | The `.uproject` to write into.                    |
| `--lines`       | `10000`                                  | Text lines to author, 1 to 1,000,000.             |
| `--seed`        | `1`                                      | Seed for every random choice.                     |
| `--root`        | `/Game/Developers/<user>/GameTextCorpus` | Output folder, at least two levels below `/Game`. |
| `--engine-root` | the project's `EngineAssociation`        | Engine to build the plugin for and run.           |
| `--clean`       | off                                      | Replace an earlier corpus in `--root`.            |

The runner does three things:

1. It builds `tools/unreal/UEShedCorpusGenerator` with `RunUAT BuildPlugin`. The build goes into
   `out/game-text-corpus-plugin/<version>/<hash>/`. The hash covers the plugin sources, the engine
   path and the engine's editor `BuildId`, so the plugin only rebuilds when one of them changes.
2. It runs `<Editor>-Cmd.exe <project> -run=UEShedGameTextCorpus` with `-PLUGIN=<built .uplugin>`,
   `-unattended`, `-nullrhi`, `-nosplash` and `-nop4`. Logs go to `out/game-text-corpus-runs/`.
3. It prints a summary from the manifest.

The plugin is loaded only through `-PLUGIN=`. Nothing is installed in the project, and the project's
`.uproject`, `Config` and existing content are not changed. The commandlet only writes into an empty
or missing `--root` folder. `--clean` deletes that folder only when it holds the generator's manifest
and nothing besides `.uasset` packages. A run that fails before it writes the manifest leaves a
folder `--clean` will not touch; delete that folder yourself. Like any editor run, Unreal still
updates the project's usual `Saved`, `Intermediate` and Derived Data Cache folders. The commandlet
runs no source control, so new packages are not added to Perforce or any other source control.

## What it writes

About 40% of the lines go into String Tables, 30% into DataTables, and 10% each into Blueprint
variables, Blueprint graph pins and Widget Blueprint text blocks. With 10,000 lines this makes about
740 packages, so the cost of reading each package shows in the timings.

| Folder          | Packages                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StringTables/` | 20 to 60 entries each, plus one table of 400. Tables in the same area share a namespace. About 10% of entries have a `Comment`.                                                            |
| `DataTables/`   | 8 to 25 rows of `FUEShedCorpusTextRow`, each row with a `DisplayName` and a `Description` text cell.                                                                                       |
| `Blueprints/`   | Actor Blueprints with 1 to 4 `FText` variables set in the class defaults. They also have 1 to 4 text pin defaults: Print Text nodes wired from BeginPlay, and unwired pure To Upper nodes. |
| `Widgets/`      | Widget Blueprints with 3 to 10 `UTextBlock`s under a vertical box.                                                                                                                         |

Asset text is keyed the way the editor keys typed text: the package namespace `[<32 hex>]` and a
32-hex key. String Table entries use `Corpus.<Area>` and `<Area>_<n>`. The text includes format
arguments, `<Em>` rich-text tags, line breaks, accented and CJK words, and long descriptions.

These cases are deliberate:

- **Shared source.** About 4% of lines are common UI phrases such as "Back" or "Cancel", repeated
  under different keys.
- **Key conflicts.** About 1.5% of entries reuse an earlier key with different source text. String
  Tables do this across tables that share a namespace; DataTables do it within one table.
- **Empty and whitespace.** About 0.5% of lines are empty, and about 0.5% hold only whitespace.

The DataTable row struct lives in the generator plugin. To open those DataTables in the editor, load
the plugin, for example with `-PLUGIN=<built .uplugin>`. Without it, Unreal reports a missing struct.
The saved-package reader does not need the plugin.

## Manifest

`UEShedGameTextCorpus.json` sits beside the packages. It records:

- the format version, seed, line count, root and `FEngineVersion`;
- line counts per text kind and the duplicate counts;
- every package, and every text in it with its kind, field, namespace, key, source and notes.

`scripts/game-text-corpus.ts` decodes the manifest and prints the summary.

## Determinism

The plan is drawn from one seeded `FRandomStream` before any asset is created, and the manifest is
written only from that plan. For the same seed, line count and engine version, the manifest is
byte-identical.

The packages are byte-identical too, on the same engine build. The commandlet replaces every random
id the editor would assign with one derived from the seed:

- the package localization namespace and persistent GUID;
- the Blueprint GUID, Simple Construction Script variable GUIDs and member variable GUIDs;
- graph, node and pin GUIDs;
- the Widget Blueprint's widget variable GUIDs.

Byte identity was checked with two consecutive runs of the 10,000-line corpus on UE 5.7. A
different engine version or editor build may serialize the packages differently, though the
manifest's text content stays the same.

## Reading it back

The saved-package reader's text projection reads the whole corpus:

```sh
cargo build --locked -p uasset-io
target/debug/uasset scan <project dir> --path Content/Developers/<user>/GameTextCorpus --projection text
```

Each `text_occurrence` line has the namespace, key, source and location of one text. Unreal does
not save empty text in every place, so expect some differences from the manifest:

- An empty Blueprint variable or widget text equals the class default, so it is not saved.
- An empty DataTable cell is saved without a key.
- A wired Print Text pin is also compiled into script bytecode, and widget text also appears in the
  generated class's widget tree. Each of these is a second occurrence of the same text.
- The editor adds its own text: each variable's "Default" category, each call node's "Target" pin
  name, and each actor Blueprint's Simple Construction Script category.

On UE 5.7, the reader finds every non-empty line at its authored place, with the namespace, key and
source the manifest records.

## On another machine

The other machine needs:

- Windows, with an Unreal Engine 5 installation that includes the C++ toolchain, so `BuildPlugin`
  can compile the plugin;
- the target project's own editor modules already built;
- Node.js 26 and pnpm, a clone of this repository, and `pnpm install --frozen-lockfile`;
- Rust 1.89 or newer, if you want to read the corpus back with `uasset`.

The runner finds the engine from the project's `EngineAssociation`: a launcher install such as
`5.7`, or a registered source build. Pass `--engine-root` for anything else.

## Not yet included: translations

TODO: the corpus has no culture translations. Unreal and UE Shed only find a localization target
through the project's configuration: `GameTargetsSettings` in `Config/DefaultEditor.ini`, or a
gather recipe in `Config/Localization/*.ini`. For translations to show, a corpus target would need
a new recipe file in the project's `Config/Localization/` folder, next to its archives under
`Content/Localization/<Target>/`. That writes outside the corpus folder, into tracked configuration.

One possible future option is `-Cultures=fr,de,ja`. It would write the recipe and the archives,
leave some lines missing or stale on purpose, and remove them again with `--clean`. It should only
run on projects where writing to configuration is acceptable.
