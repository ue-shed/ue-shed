# Game Text rule engine: Phase 6 specification

Plan 059 Phase 6: Electroswag runs the published Game Text workspace. It deletes its forked
workspace and its vendored oracle, takes its rules from the project's file only, and checks its
answers against the same generated corpus as UE Shed.

## 1. Where Electroswag is

Surveyed at Electroswag `0e6f470e` (UE Shed 0.21.0) against UE Shed `bf2dc2c3` (Phase 5).

- **The fork.** `src/main/services/game-text-workspace/showcase/` is the workspace adapted from
  UE Shed 0.14–0.16: `game-text.ts` (1,363 lines), `game-text-localization.ts` (1,085),
  `game-text-operations.ts` (523) and `investigation-files.ts` (98). Against 0.21.0's
  `workspace*.ts` it differs by 2,320, 1,861, 808 and 123 changed lines. What it adds over UE Shed
  (each marked `Electroswag:` in the source):
    1. scan progress as "step N of M";
    2. a polling-safe operation state (`operationStateTarget`), so a status poll never waits for a
       scan's lock (`e5443c93`);
    3. Perforce: every PO file an edit replaces is checked out before any is written, and the review
       file is checked out before it is replaced;
    4. recovery text that names Electroswag;
    5. bounded waits: Quality requests answer `checking`, with progress, after 5 s
       (`quality-answer.ts`, in the RPC layer, not the fork);
    6. the renderer previews the rules it remembers each time the page loads, and the fork keeps the
       published document when they are equal;
    7. an Electroswag 1.2 rules file (`Config/Electroswag/GameTextRules.json`) stands in for a missing
       UE Shed one.
- **The oracle.** `src/shared/game-text-workspace/ue-shed-oracle/` is eight `*.test-support.ts`
  files (1,809 lines) copied from UE Shed's reference queries, which UE Shed deleted in Phase 3
  (`46a857cb`). Nine test files import it.
- **Host policy in code.**
    - `default-checks.ts` disables `missing_translator_notes`, `duplicate_source` and
      `rich_text_tag_case`, on the server and in the Quality page.
    - The Browse page adds `audience is_not editor` to a filter without an audience clause
      (`DEFAULT_AUDIENCE_CLAUSE`).
    - The translation grid tokenizes text in the renderer (`game-text-tokens.ts`): placeholders, rich
      text tags, and `//` as a page separator. It is a TypeScript copy of three engine checks.
    - Browse preferences store a rules document in `localStorage`.
- **Its fixture.** `e2e/fixtures/game-text-workspace` is localization evidence copied from UE
  Shed 0.12.0. The integration tests scan it with an empty asset folder.
- **Against UE Shed `bf2dc2c3`**, `tsgo -p tsconfig.json` reports 116 errors, all in Game Text: the
  rules file format (rule editor, rule state, preferences, the oracle), signals that became
  findings (`shared`, `long`, `duplicate_source`), `lens`, and the new `finding` and `fact` fields
  and `string_table_entry_missing` reason.

## 2. Decisions

1. **No host overlay.** The plan put Electroswag's three disabled checks, its audience default and
   its separator in a host overlay. The rules file reset in Phase 2 (plan decision 18) changed
   what each of them is:
    - Without a rules file nothing runs, so a check is on only because the project's file lists
      it. An overlay that turned it off would override the project's own choice, and the app
      would disagree with `ue-shed loc check` on the same project: the disagreement this plan
      exists to remove.
    - **The three checks** go into **Electroswag's starter file**, listed with `enabled: false`.
      The rule editor shows them, off, and a project can turn them on. Electroswag's reasons
      (from `default-checks.ts`) move to the starter's source.
    - **The separator** is `segment_separator`'s `separator` param. Electroswag's starter lists
      `segment_separator` with `"//"`.
    - **The audience default** is a Browse filter, not a rule. It stays the Browse page's default
      filter in Electroswag.
    - `applyRuleOverlay` and `GameTextRuleOverlay` are deleted. No host uses them, and no release
      shipped them.
2. **A host's starter.** `GameTextWorkspaceHost.starterRules?: GameTextRuleDocument` is what
   **Create rules file** writes. It defaults to `STARTER_GAME_TEXT_RULES`.
3. **Electroswag's starter** is UE Shed's starter checks, plus `shared` and `long` (Browse's chips
   today), `segment_separator` with `"//"`, and the three checks with `enabled: false`. It has no
   example roles or rules.
4. **Polling-safe operation state moves to UE Shed.**
    - The workspace gains `operationStateTarget`, which reads the target from the published
      discovery only, never through `consistentIndex` or `targets()`.
    - `operations.state` uses it. A target the published discovery doesn't list yet reads as
      not selected, as the fork's does.
5. **Writes are prepared up front.**
    - `GameTextWorkspaceHost.prepareWrites?: (paths: readonly string[]) => Effect<void,
GameTextWorkspaceHostFailure>` is called with every absolute path a localization edit or
      review write will replace, before the first byte is written.
    - A failure returns `file_unwritable` with the host's message and recovery, and nothing is
      written.
    - Electroswag checks the files out in Perforce there. The per-file `localizationFiles` layer
      stays: it checks each file again as it writes.
6. **Recovery text names the host.** `GameTextOperationsHost.appName?: string` replaces "the host"
   in the two engine-launch recoveries. It defaults to `"the host"`.
7. **Scan progress counts steps.** `GameTextWorkspaceProgress` gains optional `step` and `steps`:
    - the steps are the host's project scan, then each scan phase in run order;
    - a step a scan skips still counts;
    - the Workbench shows them as the fork does.
8. **Bounded waits stay in Electroswag's RPC layer.** `answerWhileChecking` wraps the published
   methods and reads progress from the published `progress()`. The fork's `rulesProgress` and
   `localizationQualityProgress` are deleted, with their RPC methods.
9. **Rules come from the file.** The renderer stops storing and previewing a rules document:
    - preferences drop their rules field and ignore it when they decode old values;
    - the page loads the project's file through `reloadQualityRules`;
    - the rule editor previews and saves through the workspace as UE Shed's does.

    The Electroswag 1.2 rules file fallback is deleted (no project uses a rules file, 2026-10-24).

10. **No renderer tokenizer.**
    - `game-text-tokens.ts` is deleted.
    - The translation grid marks a culture's cell with that line's findings from the engine:
      `format_arguments`, `rich_text_tags` and `segment_separator` with their evidence.
    - Without those rules in the file, the grid marks nothing.
11. **The renderer follows UE Shed's extension.**
    - Electroswag's `src/mainview/features/game-text/showcase/` files started as copies of
      `extensions/game-text/src/`.
    - Each file takes the extension's `v0.21.0..main` change as a three-way merge, then
      Electroswag's own changes are kept.
    - The rule editor, filter model, display menu, row signals and line callout follow it whole.
12. **Tests use planted answers.**
    - Renderer tests that drew rows from the oracle use canned answers, as UE Shed's do since
      `46a857cb`.
    - Electroswag keeps a copy of `game-text-canned-search.test-support.ts` as test code. It is a
      fixture builder, not an implementation.
    - Host tests that asked the oracle for an index use the native index on the committed fixture.
13. **The fixture runs on the same generator.**
    - UE Shed publishes `@ue-shed/game-text-corpus`: the corpus plan's decoder, the answer
      format, the known defects, the localization writer and the comparison.
    - The comparison takes the host's index layers. Electroswag runs it through its own
      composition: its Project Index, cache root and index steps.
    - Electroswag's `game-text-corpus.integration.test.ts` runs when `UE_SHED_GAME_TEXT_CORPUS` is
      set and skips otherwise, as UE Shed's does.
    - The generator (the plan's drawing code and the Unreal commandlet) stays in UE Shed's
      scripts.
    - The committed fixture stays for Electroswag's write paths (PO edits, review files, rules
      files, reports), which no corpus answer covers.

## 3. UE Shed changes

| Where                                     | Change                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `game-text/src/workspace-host.ts`         | `starterRules`, `prepareWrites`; `step` and `steps` on `GameTextWorkspaceProgress`                                         |
| `game-text/src/workspace.ts`              | `createStarterRules` writes the host's starter; progress counts steps; `operationStateTarget`                              |
| `game-text/src/workspace-localization.ts` | `prepareWrites` before edits and review writes; `operationStateTarget` from the published discovery only                   |
| `game-text/src/workspace-operations.ts`   | `state` uses `operationStateTarget`; `appName` on its host for the recoveries                                              |
| `game-text/src/game-text-rules.ts`        | delete `GameTextRuleOverlay`, `GameTextRulePatch`, `applyRuleOverlay`, `invalid_overlay`, their exports and README section |
| `packages/game-text-corpus` (new)         | the plan's types and decoder, answer format, defects, localization writer and comparison, from `scripts/`                  |
| `scripts/`                                | the generator, fuzzer and compare CLI import the package; nothing is duplicated                                            |
| Workbench                                 | shows `step` of `steps`                                                                                                    |

The corpus package depends on `@ue-shed/game-text`, `@ue-shed/localization`,
`@ue-shed/unreal-assets` and Effect only.

```ts
compareGameTextCorpus(corpusRoot: string, options?: {
	layer?: Layer<GameTextIndexRefresh>; // defaults to UE Shed's own composition
	changedFiles?: readonly string[];
})
```

It returns the same report as today's script.

## 4. Electroswag changes

- **Runtime.**
    - `runtime.ts` builds `makeGameTextWorkspace` and the published operations and ID repairs
      with Electroswag's host:
        - its project layer;
        - its dialogs and local files as `files`, with Perforce checkout in `writeFile` and
          `prepareWrites`;
        - `CheckoutLocalizationFileAccessLive` as `localizationFiles`;
        - its starter, its reviewer and its change author, and `appName: "Electroswag"` for the
          operations.
    - Its own ID-repair wrapper (Perforce before a repair is claimed) stays host code on top of
      the published ID repairs.
- **RPC.** The methods keep their names and shapes where the workspace's are unchanged. Removed:
  `rulesProgress`. Added: `related` and `searchRows`, as the published workspace has them.
- **Deleted.**
    - `showcase/game-text.ts`, `game-text-localization.ts`, `game-text-operations.ts`,
      `investigation-files.ts`, their `*.test-support.ts` and the tests that only exercised the
      fork;
    - `ue-shed-oracle/`;
    - `default-checks.ts`;
    - `rules-location.ts`'s legacy path and `legacy-rules.integration.test.ts`;
    - `game-text-tokens.ts`;
    - the rules field in preferences;
    - `docs/ue-shed-adoption.md`'s oracle sections.
- **Versions.** `@ue-shed/*` move to the release with Phases 1–6.

## 5. Order of work

1. **UE Shed, the workspace hooks** (§3), with tests: starter, `prepareWrites` refusing before any
   write, polling state during a held scan, progress steps.
2. **UE Shed, the overlay deletion.**
3. **UE Shed, `@ue-shed/game-text-corpus`**, with the scripts moved onto it. Then the corpus
   comparison is run once on the canonical corpus, unchanged.
4. **UE Shed release** with Phases 1–6. Publishing needs the owner's approval.
5. **Electroswag, the runtime and RPC** on the published workspace; the fork is deleted.
6. **Electroswag, the renderer** (decisions 9–11), screen by screen.
7. **Electroswag, the tests**: canned answers, the oracle deleted, the corpus comparison.

## 6. Verification

- **UE Shed:**
    - `game-text` unit and workspace tests;
    - the corpus comparison on the canonical corpus through the package, with no unexpected or
      stale entries;
    - typecheck and lint.
- **Electroswag:**
    - typecheck, lint and format;
    - the Game Text unit, component and integration suites;
    - the corpus comparison through Electroswag's composition on the canonical corpus;
    - `test:e2e:fullstack:game-text`, run alone under the Unreal lock.
- **Measured.** Electroswag's `scripts/measure-game-text-scan.ts` on the released project:
    - cold scan, second scan and remount, with Quality's first page;
    - head against Electroswag `main` (0.21.0 and the fork), interleaved in one session.
- **Owner review** in the app: Browse, Quality, the rule editor with Electroswag's starter, the
  translation grid, and an edit with Perforce checkout.

## 7. STOP conditions

- The corpus comparison through Electroswag's composition disagrees with UE Shed's.
- A fork behaviour in §1 that neither a hook here nor Electroswag host code can keep.
- A regression in the measured paths against Electroswag `main`. Record it and reassess.
