# Adopt Game Text into an existing host

This guide is for the coding agent integrating the headless Game Text Module into an established
trusted host. Read [`adoption.manifest.json`](adoption.manifest.json) first. Do not inspect or copy
Workbench unless a named verification failure leaves the public package contract insufficient.

## Fast path

1. Inspect the target's package manifest, Node version, Effect version, selected-project model, and
   saved-asset reader configuration.
2. Install the exact `@ue-shed/game-text` version. Reuse a compatible existing
   `@ue-shed/unreal-assets` and `@ue-shed/uasset` installation when present.
3. In the target's trusted Node process, compose one scoped `AssetReader` layer and
   `TextCorpusServiceLive`. Do not create a sidecar server or a reader layer per asset.
4. Adapt the host's explicit project root or existing project index to `scan` or
   `scanFromProjectIndex`.
5. Keep the complete corpus and `textCorpusQuery` model in the trusted host. Add schema-validated
   host operations for progress, summary, bounded search, and bounded focus using the target's
   existing transport conventions.
6. Add an adopter-owned view only if the host needs one. This bundle contains no maintained UI and
   requires no Solid, StyleX, Electron, or Workbench package.
7. Prove the acceptance journey below and record the exact package versions, reader provider, target
   files, project input, and verification commands in the host repository.

## Ownership

- UE Shed owns the installed package and its schemas.
- The adopting host owns project selection, runtime composition, transport Adapter, caching policy,
  route, presentation, and navigation.
- Browser code receives only bounded schema-validated results. It must not receive the corpus,
  filesystem paths beyond returned evidence, process authority, or the reader executable.
- Do not import `apps/workbench`, `extensions/game-text`, or Workbench transport modules.
- Do not add `@ue-shed/uasset` as a hidden dependency of Game Text. The host deliberately selects
  the default launcher or an explicit compatible executable.

## Required and optional capabilities

The core audit requires saved project packages and a configured reader. It does not require a
running editor, Perforce, `UEShedCore`, or any other UE Shed Unreal plugin.

“Locate in Unreal” is an optional host enhancement. Keep it outside the audit Module and expose an
honest unavailable state when the host has no compatible editor-selection capability.

## Acceptance journey

The integration is complete only when the target host can:

1. Select an explicit project root without relying on ambient UI state.
2. Scan its saved packages with visible progress and cancellation owned by the host.
3. Return a summary that includes scan coverage and diagnostics.
4. Search with the public maximum page size enforced.
5. Focus a selected text-unit ID and return bounded occurrence evidence.
6. Run with Unreal offline and report unsupported or partial evidence without claiming complete
   project coverage.
7. Build and run from the target's packaged application, resolving the configured reader there.

UE Shed's source release gate runs `pnpm test:release:packages`. The adopter must add a target-owned
command that proves the same scan → search → focus journey through its real host transport. A direct
package call is useful diagnosis but is not evidence that the host Adapter works.
