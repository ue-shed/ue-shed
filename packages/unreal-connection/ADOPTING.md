# Adopt Unreal authoring and automation in an existing host

Use [adoption.manifest.json](adoption.manifest.json) as the machine-readable package closure,
native-provider, host-boundary, and conformance contract. Pin the package release declared by its
`package.json`; this guide does not select a release version.

Install exact releases of `@ue-shed/unreal-connection`, `@ue-shed/protocol`, and the Effect
version declared by those packages. Use `@ue-shed/authoring` when the host needs UE Shed's draft,
conflict, and Apply planning rather than only the wire clients. Preserve your host's project
selection, endpoint configuration, transport boundary, UI, and navigation. Do not import Workbench
IPC, `window.ueShed`, Electron, or renderer implementation files.

## Configure the native producer

Obtain the matching `authoring-automation` plugin source bundle and verify its manifest digest,
source provenance, descriptor versions, and engine range before installation. Build the selected
plugins for the engine used by the consuming project. The bundle contains Core, Authoring, and
Automation; the latter depends on the engine's Enhanced Input plugin. For a runtime-only build,
select Core and Automation. Authoring is editor-only. These capabilities are optional and are not
enabled merely by installing the JavaScript packages.

Configure the host with an explicit Remote Control endpoint. Compose `RemoteControlClientLive` in
the trusted host, or supply a conforming `RemoteControlClient` adapter. Negotiate through
`inspectUnrealProducer(endpoint)` and the connection helpers rather than caching native CDO paths.
Use the advertised capabilities and endpoints; producer identity is useful evidence but does not
replace feature negotiation. A missing plugin or unsupported build is a typed capability failure.

## Replace existing host contracts

Use UE Shed's public data model as the upstream contract. Translate at one host adapter instead of
introducing old endpoint names or a second native transaction protocol:

1. `connectUnrealAuthoring(endpoint)` provides table discovery, typed snapshots, Apply, Apply-result
   lookup, and explicit Save. Consume live schema defaults from the snapshot. Preserve unknown or
   unsupported values rather than guessing defaults from presentation types.
2. Record a reviewed command plan and table fingerprints. Submit one Apply request with a stable
   operation identifier. The producer owns the editor transaction and rollback. Convert returned
   typed results into your existing host status/error model and refresh snapshots after mutation.
3. `findUnrealActorsReferencingRow({ endpoint, request })` selects the editor world, table, row, and
   `maxActors`/`maxResults`. Show partial/truncated evidence as partial; loaded-world results are not
   a project-wide saved-asset inventory.
4. `connectUnrealAutomation(endpoint)` exposes `listPlayers(request)`, `injectInput(request)`, and
   `csvProfiler(request)`. Choose a controller from explicit world-scoped discovery, then select an
   InputAction and typed value. Injection happens once. Keep sustained input scheduling in the host.
5. Coordinate process-wide profiler control between connected hosts. The plugin recognizes its
   generated capture filename and refuses to stop an external capture; the protocol does not carry
   per-host capture identities. Poll the typed status through asynchronous starting/stopping
   transitions and retain output evidence.

Keep consequential operation intent and evidence in a host-owned durable record. User-facing review
and approval remain host responsibilities. Raw Unreal access belongs behind the host's API, outside
browser code. A transport failure after a mutation may mean the producer already acted. Never
automatically retry Apply, Save, input injection, or capture mutations. Apply has operation lookup;
other operations require state/ownership inspection and an explicit host recovery decision.

Serialization/arithmetic test probes should live in your generic fixture project. Do not require
production plugins to expose fixture-specific hooks. Existing game Blueprint references must be
updated by the consuming project when its previous plugin is retired.

## Verify

Release maintainers build the focused source preset from an attested candidate:

```powershell
pnpm release:plugins:authoring-automation `
  --candidate-manifest <candidate-manifest.json> `
  --commit <full-source-sha> --ref <release-ref>
```

The output under `out/releases/<version>/plugins-authoring-automation` contains the source archive
and its manifest. The full plugin bundle also includes Automation; camera and map presets retain
their existing dependency graphs.

From the UE Shed source checkout, run the focused portable bundle tests:

```powershell
node --test scripts/plugin-bundle.test.ts
```

Build and execute the native gate twice, with discovered or explicitly configured engine roots and
different fresh evidence directories:

```powershell
$env:UE_SHED_UNREAL_ENGINE_ROOT = "<ue-5.7-root>"
pnpm test:unreal-plugins <new-5.7-evidence-directory>
$env:UE_SHED_UNREAL_ENGINE_ROOT = "<ue-5.8-root>"
pnpm test:unreal-plugins <new-5.8-evidence-directory>
```

The gate requires the Defaults, ActorReferences, Input, and Profiling tests described by the
[product contract](../../docs/products/unreal-automation.md), together with the existing plugin
checks. Report each engine's build and automation result separately; record unavailable engines or
checks as gaps.

In the consuming repository, pin the exact package and plugin release versions and prove these
journeys through its real host transport against a generic fixture:

- Discover and open a table, add a row from known live defaults, Apply, Save, reopen, and verify it.
- Submit a conflicting Apply and a failing plan, verify rollback, and inspect an operation result
  after a deliberately lost response without submitting the mutation again.
- Scan a selected loaded world containing actor/component row handles in nested containers; verify
  matches and bounded partial results.
- Discover the chosen local controller and inject an explicit action/value during PIE or a
  supported runtime session. Invalid controller/world/action selections must fail visibly.
- Start a plugin-owned CSV capture, inspect state, stop, and verify output evidence. A capture
  started outside UE Shed must reject stop without affecting that capture.
- Disable each optional provider and verify that the host reports missing support without fallback
  mutations or a hidden editor launch.

These target journeys establish adoption; building the source repository alone does not.
