# 0005: Gate Peculiar Sheets and defer arbitrary custom authoring UI

## Status

Accepted on 2026-07-15. Amended on 2026-07-23 after the formula-free MIT core release.

## Context

The maintained Data Authoring extension needs spreadsheet interaction, virtualization, selection,
keyboard navigation, and batch editing. Electroswag demonstrates that Peculiar Sheets can provide
that interaction layer, but its renderer and session store are internal behavioral references rather
than code or architecture to copy.

The first reviewed release, `peculiar-sheets@0.9.1`, was GPL-3.0-only and depended transitively on
HyperFormula. The repository owner approved that exact dependency for development and distribution,
but its production graph remained incompatible with the intended MIT UE Shed boundary.

Registry metadata checked on 2026-07-23 now reports:

- package: `peculiar-sheets`
- pinned version: `0.11.0`
- source: `https://github.com/peculiarnewbie/spreadsheets`
- license: `MIT`
- production dependencies: `@tanstack/solid-virtual` and `better-result`
- formula dependencies: none

Peculiar Sheets also publishes a separately installed IronCalc adapter. Data Authoring does not need
formula evaluation, so that adapter and its WASM dependency are deliberately absent from UE Shed.
HyperFormula remains GPLv3/commercial and is not relicensed by either project.

The authoring roadmap also described arbitrary studio-authored and generated interfaces. That would
require grants, isolation, publishing, compatibility, and a security model that the maintained editor
does not need.

## Decision

- Pin the exact reviewed `peculiar-sheets@0.11.0` MIT core. Do not rely on a caret range while the
  library is on a pre-1.0 API.
- Enforce the production boundary in `pnpm license:check`: UE Shed must not acquire HyperFormula,
  `peculiar-sheets-ironcalc`, or `@ironcalc/wasm` through a production dependency path.
- Put all Peculiar runtime imports, branded row/column conversions, operation decoding, and vendor CSS
  behind one adapter in `extensions/data-authoring`.
- Expose UE Shed table/view models to the adapter and emit semantic authoring intents from it. The
  grid never owns drafts, validation, Apply, Save, or persistence.
- Use documented component props, operation types, and controller methods only. Do not query private
  `.se-*` DOM nodes or override private selectors.
- Do not add formulas unless a later product requirement and separate dependency review justify them.
- Defer arbitrary custom authoring UI hosting indefinitely. Continue to support the maintained
  first-party extension, CLI automation, and trusted hosts embedding the maintained interface.
- Keep `@ue-shed/authoring-sdk` as the browser-safe client contract used by that maintained interface.
  It is not an untrusted-extension SDK or capability sandbox.

## Consequences

The authoring domain remains usable without Workbench and replaceable without Peculiar Sheets. A
dependency rejection changes the grid implementation choice, not the session, protocol, CLI, or
product contracts. Deferring custom UI removes speculative security and platform work without
removing named views, row-detail surfaces, or purpose-built maintained extensions.

No source from Electroswag is copied. Its observable behavior may inform conformance cases.

UE Shed can use the MIT repository license without shipping HyperFormula. IronCalc remains available
to other Peculiar Sheets consumers without becoming an unused UE Shed dependency.

## Approval record

The repository owner stated that they own Peculiar Sheets and authorized the formula-free core under
MIT. The published `0.11.0` registry metadata and installed manifest are checked by the release gate.
This decision does not alter the licenses of HyperFormula, IronCalc, Unreal Engine, or any other
third-party dependency.

## Implementation evidence

`peculiar-sheets@0.11.0` is pinned exactly in the Data Authoring extension. The browser adapter uses
only `Sheet`, `rowId`, published types, and the published stylesheet. It does not instantiate a
formula engine, use private selectors, or transfer authoring authority into the grid.

The root MIT license, dependency-boundary gate, Data Authoring model/component tests, adoption test,
and full repository check prove the reviewed boundary.
