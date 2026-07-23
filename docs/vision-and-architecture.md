# UE Shed: vision, architecture, and sequencing

## The short version

UE Shed is a suite of external tools for Unreal Engine development. The name deliberately evokes a
place full of tools that are not needed every day but are crucial at the right moment. It also
captures the architectural idea: capabilities extend outward from Unreal and a game project instead
of forcing every workflow to live inside the editor.

The repository slug and CLI command are both `ue-shed`, TypeScript packages use `@ue-shed/*`, Unreal
plugins use the `UEShed*` prefix, and the optional showcase desktop app is **UE Shed Workbench**.
“UE Shed” is the working product name. Public naming and trademark wording must be reviewed before a
release; Unreal Engine is used descriptively and no affiliation should be implied.

This is a clean implementation. Existing internal Swag tooling is valuable product research and a
behavioral reference, but it was created under different assumptions. We will not transplant its
architecture or copy implementation opportunistically. We will re-derive each public capability
from its actual contract, tests, and user outcome.

## Product boundary

The core product is not an Electron app. It is the combination of:

1. Small Unreal companion plugins that expose capabilities Unreal cannot provide generically.
2. Versioned, language-neutral control and data protocols.
3. TypeScript libraries that implement discovery, connection, sessions, and domain workflows.
4. An optional local host process for shared connections, lifecycle, and bounded streams.
5. A CLI for automation, diagnosis, and complete headless access.
6. First-party product extensions, reference extensions, and the Workbench showcase.

The deletion test is an architectural acceptance criterion: if `apps/workbench` disappears, every
capability must remain usable and testable through public libraries or the CLI. The Workbench gets no
private transport, privileged endpoint, or direct project knowledge.

Workbench launch is demand-driven. Opening the showcase must not start Unreal; a feature requests a
separately enabled live capability when the user enters that workflow or explicitly launches it.
Saved-package operations remain available while live capabilities are absent.

```text
                     optional clients
          CLI       Workbench       another trusted host
            \           |                /
             +------ public host APIs --+
                         |
        discovery + sessions + evidence + domains
                         |
             versioned control/data protocols
                         |
      stock Unreal APIs + separately enabled plugins
```

## Technology choices

- **TypeScript** is the public library, host, CLI, extension, and UI language.
- **Effect** is the default application runtime for service composition, resource safety, structured
  concurrency, cancellation, retries, bounded streams, configuration, typed errors, and telemetry.
- **SolidJS** is the maintained first-party UI framework for Workbench and product extensions.
- **StyleX** is the styling system for shared themes and primitives plus locally owned extension
  styles. It provides deterministic composition and typed style contracts across package boundaries.
- **Electron** packages the showcase Workbench; it is not a domain or protocol dependency.
- **Rust** implements native, read-only saved-package parsing behind a versioned CLI JSON boundary.
- **C++ Unreal plugins** expose the smallest engine-side capabilities that supported stock APIs cannot
  provide safely.

UE 5.7 is the current development and source-verification baseline. The public support window remains
a separate compatibility decision; product code must not depend on one local installation path.

The intended shape is functional programming with Effect as the application core. Public workflows,
stateful modules, services, configuration, concurrency, resources, typed failures, and telemetry
compose in Effect. Folding command logs, diffing snapshots, compatibility checks, and other
deterministic transformations remain ordinary pure functions over immutable values inside those
workflows; they are building blocks, not a separate runtime or policy layer. Hot-path exemptions
require a benchmark and a documented boundary. The camera frame decode/presentation loop is a
candidate for measurement, not a pre-approved exception.
Solid components adapt public service state into signals; they do not become domain authorities.
StyleX keeps styles co-located with those components while `@ue-shed/ui-theme` and `@ue-shed/ui`
provide shared variables, themes, and primitives. Extensions do not coordinate through selector
specificity, global class names, or import order.

Effect Schema is the source of truth for most TypeScript-owned data models and process boundaries.
Types and schema variants are inferred or derived from base schemas instead of duplicated. Shared
TypeScript/C++ wire contracts still require a language-neutral authority, with the Effect Schema
representation kept conformant to it.

Focused guidance lives under [`engineering/`](engineering/README.md).

## Repository shape

```text
apps/
  cli/                         # Headless entry point (`ue-shed`)
  site/                        # Public showcase website (Cloudflare Workers static assets)
  workbench/                   # Showcase and dogfood desktop app
crates/
  uasset-parser/               # Native read-only UAsset library and `uasset` CLI
packages/
  protocol/                    # Wire primitives, runtime schemas, compatibility
  observability/               # Shared telemetry policy, metrics, and public health
  host/                        # Lifecycle and static extension composition
  unreal-connection/           # Remote Control and companion transports
  engine-discovery/            # Installed engines, projects, processes, sessions
  unreal-assets/               # Versioned read-only saved-package inspection
  ui-theme/                    # StyleX variables and suite themes
  ui/                          # Shared SolidJS + StyleX primitives
  authoring/                   # Data-authoring domain services
  authoring-sdk/               # Trusted client contract for the maintained authoring UI
  evidence/                    # Artifacts, logs, captures, provenance
  observatory/                 # Actor discovery and live state
  cameras/                     # Camera definitions, observation, and review
  scenarios/                   # Interactive scenario execution
extensions/
  rc-explorer/                 # Stock Remote Control inspection
  data-authoring/              # First-party authoring product
  actor-observatory/           # First real-time observability UI
  camera-observation/          # Sparse live camera feeds
  camera-review/               # Camera definition and review workflow
  scenarios/                   # Scenario runner UI
unreal/Plugins/
  UEShedCore/                  # Capability manifest, identity, health, selection
  UEShedAuthoring/             # Authoring-only editor capabilities
  UEShedObservatory/           # Actor registry and bounded live state
  UEShedCameras/               # Camera capture and review capabilities
  UEShedScenarios/             # Scenario definitions and execution
fixtures/unreal-project/       # Generic, reproducible integration fixture
docs/                          # Product, protocol, architecture, and contribution docs
```

Ownership directories become executable when a vertical slice exercises them. Data Authoring, Texture
Audit, Game Text, Camera Load Lab, and Map Review already own real packages, extensions, CLI
surfaces, and Unreal capabilities. Remaining roadmap directories still record dependency direction
without pretending every API is frozen.

## Dependency direction

- Domain packages depend on protocol primitives and narrow connection interfaces, not on a UI.
- Saved-package parsing is isolated behind `@ue-shed/unreal-assets`; domain packages consume
  normalized results rather than parser implementation details. The native parser lives in this
  repository so its fixture and wire-contract changes can be tested atomically.
- Extensions depend on public domain packages and host extension contracts.
- The CLI and Workbench compose extensions; they do not own domain behavior.
- Unreal feature plugins depend on `UEShedCore` where shared identity or transport is required, not
  on a desktop client.
- Studio distributions can compose public extensions with private ones without changing public
  packages.

## Runtime service graph

Headless domain services depend on protocol, saved-asset, and Unreal connection services. The CLI
provides those layers plus its console boundary and the shared observability layer at one root.
Workbench main provides the same domain layers through Electron adapters and exposes only validated
IPC contracts. The renderer owns a separate browser runtime whose Effect-native clients adapt the
Promise-shaped preload boundary once. Solid components receive public client services and use the
shared owner-scoped lifetime adapter; they do not own transport or persistence.

Both process roots install `@ue-shed/observability`. Its health service is the authority used by
headless `doctor` output and Workbench readiness. OpenTelemetry export is optional for local use;
configuration and degradation remain visible without making a remote backend a startup dependency.

Static composition is the default. A checked-in registry or build-time imports are observable,
type-safe, and easy to package. Runtime loading of arbitrary third-party JavaScript would introduce
security, compatibility, and support commitments before a demonstrated need exists.

## Batteries included without prescribing a shell

Headless-first does not mean primitives-only. UE Shed should ship complete workflows where a generic
workflow has broad value. DataTable authoring is the clearest case: users should be able to discover a
table, edit it safely, review changes, apply them to Unreal, and save the asset without assembling a
product from low-level packages.

The first-party Data Authoring extension is therefore a supported product, not a sample. Its domain
logic lives in `@ue-shed/authoring`; its host-neutral UI and integration contract live behind public
packages; Workbench ships it as the canonical showcase. Another desktop host or browser surface can
embed the same extension without inheriting Workbench itself.

This preserves the deletion test: deleting Workbench removes one distribution surface, not the
authoring engine, CLI access, or reusable authoring UI. See
[`products/data-authoring.md`](products/data-authoring.md) for the product contract.

## Connection and protocol model

UE Shed starts with stock Unreal Remote Control for request/response operations and uses the existing
`unreal-rc` package as an independent dependency. `UEShedCore` adds only the generic capabilities the
stock surface cannot express cleanly: a capability manifest, stable producer/session identity,
health, selection/focus actions, and negotiation for optional transports.

Hardcoded Unreal object paths are not a public API. A client asks the producer for a versioned
capability manifest and enables features from what is actually available.

The protocol has two conceptual planes:

- **Control plane:** low-volume commands, capability negotiation, session lifecycle, queries, and
  explicit errors. Remote Control is the first baseline.
- **Data plane:** bounded, resumable, backpressure-aware streams for actor state, logs, and media. A
  local named pipe is the first proving transport, beginning with hello and health messages before
  domain payloads.

Wire messages must have a language-neutral schema, runtime validation at every process boundary, a
declared compatibility policy, and discriminated lifecycle states. TypeScript interfaces alone are
not a wire contract. Identifiers for producers, sessions, worlds, capabilities, actors, and artifacts
must not be accidentally interchangeable.

## The Unreal plugin suite

One plugin containing every feature would recreate the coupling this repository is meant to avoid.
The suite is therefore separately enabled:

| Plugin              | Responsibility                                                                   |
| ------------------- | -------------------------------------------------------------------------------- |
| `UEShedCore`        | Capability discovery, identity, health, shared transport, editor selection/focus |
| `UEShedAuthoring`   | Generic authoring operations that stock APIs cannot supply                       |
| `UEShedObservatory` | Actor registration, stable actor identity, subscriptions, bounded snapshots      |
| `UEShedCameras`     | Camera definition metadata, capture, and review artifacts                        |
| `UEShedScenarios`   | Scenario discovery, parameterization, execution, and results                     |

Saved-package authoring, `UEShedCore`, `UEShedAuthoring`, `UEShedObservatory`, and `UEShedCameras`
are already exercised by shipped workflows. `UEShedScenarios` remains a roadmap boundary until a
scenario slice earns it. Features expose their actual authority and capabilities rather than hiding
missing behavior.

## Generic fixture policy

The fixture is part of the product contract, not a dumping ground for internal test content. It must:

- open against a normal supported Unreal installation;
- use generic names, generated/basic geometry, and content under `/Game/Fixture`;
- contain no studio paths, assets, schemas, source-control assumptions, or private dependencies;
- bootstrap deterministically from documented steps or scripts;
- be small enough to clone independently and suitable for CI later;
- make its capability and fixture-contract versions inspectable without launching the editor.

Source-control integrations, including `p4client-ts`, belong in optional adapters or extensions.
They are not fixture prerequisites.

## Proven spine and next sequencing

The first public spine is proven:

1. Discover the generic fixture project and its saved DataTable packages.
2. Inspect those packages through the versioned asset-reader contract and load authority-tagged typed
   snapshots without launching Unreal.
3. Expose the same authoring operations from TypeScript libraries and the CLI.
4. Discover a supported installed Unreal editor, then launch or attach without hardcoded paths.
5. Query the `UEShedCore` capability manifest and distinguish saved package state from live editor
   state.
6. Carry drafts through review, live Apply, and Save through `UEShedAuthoring`.
7. Embed the maintained Data Authoring UI in a trusted non-Workbench host through the adoption seam.

Live and review workflows have also earned their place on the same architecture:

- Texture Asset Audit scans a saved corpus and optionally previews live texture authority.
- Game Text searches player-facing language across saved packages without flattening identity.
- Camera Load Lab measures a bounded live camera data plane.
- Map Review authors Review Views, captures immutable runs, and uses Live World Scout
  (`UEShedObservatory` snapshots) as the entry into spatial authoring.

What remains sequenced, not assumed:

1. Close Map Review Slice 2 trust and recovery under plan 017, then Slice 3 capture-profile and
   readiness work.
2. Grow Data Authoring through remaining Plan 007 work (conflicts, rich types, composites, views)
   on the Effect-native services and adoption seam.
3. Prove a dedicated named-pipe hello/health path before the full actor-observatory time-indexed
   projection accumulates special cases. Remote Control plus bounded polling is enough for the
   current Live World Scout; the richer observatory MVP below still needs the shared data plane.
4. Keep sparse camera observation and interactive scenarios as separately enabled domains rather
   than folding them into Map Review or Observatory.

## Actor observatory direction

The durable observatory product remains a **queryable, time-indexed projection of the running
world**. Live World Scout is a deliberately smaller foothold: bounded editor-world actor snapshots,
an aspect-preserving XY canvas, search/filter/selection, and Focus / Follow actions that hand off to
Map Review framing. It is not yet the full observatory MVP.

The fuller direction still needs:

### Fixture content

- A dedicated observatory map under `/Game/Fixture/Observatory`.
- Three actor classes with clearly different data and deterministic movement patterns: an orbit, a
  ping-pong path, and a seeded wander within bounds.
- A small mix of shared and class-specific observable properties.
- Configurable populations from a fixed seed, with stable logical IDs independent of spawn order.
- Enough actors to demonstrate filtering and update behavior without turning the demo into a stress
  benchmark.

### Engine capabilities

- `UEShedCore` advertises versions, project/world identity, health, and editor selection/focus.
- `UEShedObservatory` advertises actor discovery and subscription capabilities beyond snapshot
  polling.
- Actor records carry stable identity, class/type, display label, world, transform, selected
  properties, lifecycle, and observation timestamp.
- Updates are subscriptions with requested cadence, bounded queues, coalescing, staleness, and
  explicit actor-added/updated/removed events. They are not an unbounded firehose.
- Reconnect behavior produces a new snapshot or a documented resume result; silent gaps are not
  accepted.

### Headless and showcase behavior

- The library and CLI can list worlds, list actors, inspect one actor, and request focus.
- Workbench shows connection/session health, actor counts, search/filtering, type, transform,
  selected data, update age, and stale/disconnected states.
- A **Focus in Unreal** action brings the corresponding editor forward and selects the actor.
- Workbench uses the exact same public operations as the CLI.
- Continuous camera preview remains outside the observatory product boundary; Map Review and Camera
  Load Lab own visual evidence.

The focus implementation must be chosen by inspecting supported editor APIs; the public contract is
the result (`focused`, `not-found`, `not-supported`, or an explicit error), not a guessed engine
call.

### Acceptance for the fuller MVP

The fuller observatory is demo-ready when a clean machine can follow the documented setup, launch the
fixture, connect, observe all three moving actor families live, filter and inspect them, focus a
selected actor in Unreal, survive an editor reconnect without a stuck UI, and produce useful
diagnostics when a capability is missing. The same core flow must be scriptable without Workbench.

## Roadmap domains

The wider suite still contains these connected running-world ideas:

1. **Actor observatory:** live discovery and inspection of actors and their changing state, beyond
   the Live World Scout foothold.
2. **Map review:** durable Review Views, captures, annotations, and review artifacts.
3. **Sparse camera observation:** intentionally sampled live feeds where continuous video is
   unnecessary or too expensive.
4. **Interactive scenarios:** discoverable, parameterized workflows that run in Unreal and emit
   structured results and evidence.

They share producer/world/session discovery, capability negotiation, stable identity, bounded data
streams, and an evidence model. Those shared concepts belong below the domains; actor-, camera-, and
scenario-specific models should not be forced into one universal event type.

Data Authoring remains the flagship authored-content product: a first-party, end-to-end track with a
maintained default interface. Texture Audit and Game Text are additional saved-package proving
slices. Trusted hosts may embed the authoring interface, but arbitrary custom authoring UI hosting is
deferred. Remote Control exploration remains a useful suite extension. Existing independent packages
such as `unreal-rc`, `p4client-ts`, and `peculiar-sheets` remain independently versioned dependencies
rather than being absorbed into the monorepo.

UTrace parsing is a separate product boundary from saved-package parsing. Its volume, capture
lifecycle, analysis model, and UI concerns do not belong in the foundational UAsset crate and are
deliberately excluded from this repository for now.

## Relationship to internal Swag tooling

The healthy relationship is downstream composition, not a long-lived fork:

- UE Shed owns generic contracts, plugins, fixture, libraries, CLI, and reference extensions.
- A Swag distribution may compose those with internal adapters, policy, branding, and private tools.
- Generic fixes flow into UE Shed first; private behavior remains downstream.
- Existing internal behavior can become a conformance case after its provenance and generality are
  understood.

This keeps the public project honest while avoiding two diverging copies of every useful feature.

## Clean-room and open-source gates

“From scratch” means more than moving files into a new repository:

- Write public requirements and tests from observable behavior and generic use cases.
- Do not copy internal project names, paths, assets, schemas, comments, fixtures, or generated data.
- Track the origin and license of every dependency, snippet, asset, and protocol decision.
- Keep engine-source investigation separate from copying engine implementation.
- Review contributor ownership, dependency licenses, trademark language, security posture, and the
  final repository history before publication.
- Keep packages `private` until their package-specific publication boundaries are ready. Repository
  source is MIT licensed; third-party dependencies and Unreal Engine retain their own licenses.

The Workbench must not become the accidental source of truth for protocols or domain behavior. Public
libraries and executable conformance tests are the reusable product.

## Deferred decisions

These choices matter but should be made with evidence from shipped workflows rather than guessed:

- exact supported Unreal versions and compatibility window;
- JSON Schema, Protobuf, or another language-neutral schema authority;
- named-pipe framing and whether a second cross-platform data transport is required;
- process topology for the local host and multi-editor arbitration;
- package-by-package release cadence and publication metadata;
- whether third-party runtime extensions are ever worth the security and support cost.

The architecture leaves seams for all of them without making every workflow pay their full
complexity.
