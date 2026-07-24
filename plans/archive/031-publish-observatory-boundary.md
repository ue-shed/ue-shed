# Plan 031: Publish the headless Observatory package boundary

> **Executor instructions**: Package the existing bounded Observatory host without importing
> Workbench, extension UI, or Electroswag source. Do not tag, push, publish, or dispatch workflows.
> Preserve exact candidate pins and protected OIDC publication.

## Status

- **Status**: DONE on 2026-07-24 — `0.1.0-rc.3` artifacts packed and full portable gate passed
- **Depends on**: Plans 019, 024, 026, and 030
- **Category**: release

## Goal

Make the headless Observatory service consumable by a downstream Node host through an exact
candidate tuple. The public closure is `@ue-shed/observability` → `@ue-shed/observatory`, with
`@ue-shed/unreal-connection` and `@ue-shed/protocol`; the matching Unreal selection is
`UEShedObservatory` only.

## Done criteria

- [x] Observatory and Observability pack from `dist` with MIT metadata and no local protocols.
- [x] Candidate construction and protected publish lists contain the exact dependency-safe order.
- [x] Offline consumer imports health, stream decoder, and browser-safe presentation exports and
      decodes a USOT packet.
- [x] The Observatory-only plugin bundle excludes Workbench and extension UI.
- [x] `pnpm test:release`, `pnpm test:release:packages`, `pnpm fixture:build`, and `pnpm check`
      pass.
- [x] Publication instructions name the exact package and plugin order.

## STOP conditions

- The package leaks a Workbench/UI dependency.
- An export cannot be packed without an unpublished workspace dependency.
- Publication would require replacing protected OIDC with a token path.
