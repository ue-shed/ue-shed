# Agent-ready workflows and adoption

UE Shed is designed for people and coding agents to use the same public capabilities. A workflow is
not agent-ready merely because an agent can click through Workbench, inspect implementation code, or
guess a sequence of CLI commands. The usable contract must be explicit, durable, and verifiable.

Apply this guide whenever designing or extending a maintained user-facing workflow, CLI surface,
extension, trusted host, or Unreal integration. Read the focused product contract as well.

## Two distinct stories

Do not conflate these outcomes.

### Agent operation

An agent works inside an existing project: it discovers state, makes a bounded proposal, obtains the
required approval, performs a mutation, and returns durable evidence. This is a domain and CLI/API
contract.

An operational workflow must provide:

1. Versioned, schema-validated commands and output, with branded identifiers rather than labels or
   incidental file paths.
2. Explicit target selection. Do not require an agent to rely on ambient UI state when a stable
   project, map, asset, actor, session, or candidate identifier can be supplied.
3. A durable session or proposal for meaningful multi-step work. The artifact records intent,
   diagnostics, selected inputs, lifecycle, and recovery guidance.
4. A visible review boundary before a consequential mutation. Never silently choose the first
   candidate, accept a default, or replay an indeterminate mutation on an agent's behalf.
5. Honest capability, authority, and recovery states. Missing Unreal capabilities, stale state,
   conflicts, and partial results remain typed output instead of being hidden by a shell.
6. Machine-readable evidence after the operation: what changed, what did not, and how to resume or
   inspect it.

The normal shape is:

```text
discover or target → create durable proposal → inspect/review → explicit approve → execute → evidence
```

Small read-only commands may skip the session. A workflow that can alter Unreal state, durable
definitions, source-controlled content, or external systems should not.

### Agent adoption

A coding agent brings a maintained UE Shed workflow into another trusted host or project without
copying Workbench. This is an integration and distribution contract, not an operational CLI story.

When a maintained UI slice is claimed to be adoptable, it must ship:

1. A short `ADOPTING.md` addressed directly to the adopter agent. It states the fast path,
   ownership boundary, forbidden shell-specific dependencies, configuration, and exact verification
   commands.
2. A machine-readable adoption manifest that declares the copied closure, kernel dependencies,
   toolchain wiring, provenance, and conformance requirements.
3. A deterministic materializer or equivalent scripted process. Do not make an agent hand-copy a
   file list from prose.
4. A direct trusted-host/client seam independent of Workbench IPC. Browser code must not gain raw
   filesystem, process, Electron, or Unreal authority merely to make the slice work.
5. A fresh-workspace conformance gate that materializes the slice, builds it, rejects Workbench
   dependencies, and proves one functional journey against a generic project or fixture.

The Data Authoring slice is the reference implementation:
[`extensions/data-authoring/ADOPTING.md`](../../extensions/data-authoring/ADOPTING.md),
[`adoption.manifest.json`](../../extensions/data-authoring/adoption.manifest.json), and
`pnpm test:adoption:data-authoring`.

### Package-mode existing-host adoption

A headless feature adopted into an established host should not use the standalone source-copying
materializer merely to resemble Data Authoring. Its equivalent deterministic process is an exact
package closure plus a machine-readable host-integration manifest:

1. Publish a built domain package with no Workbench or presentation dependency.
2. State normal dependencies, host-owned peers, and separately selected runtime providers
   independently. Do not hide a native executable inside an unrelated JavaScript package.
3. Give the adopter agent a short guide naming required host Seams, forbidden imports, capability
   tiers, and the functional journey the target must prove.
4. Keep project selection, runtime composition, transport Adapters, presentation, and navigation
   owned by the adopting host.
5. Test the packed tarball from a clean consumer, including one real domain journey and native
   provider resolution when applicable.
6. Require the adopting repository to record exact versions and prove the journey through its real
   transport and packaged runtime.

Game Text is the reference package-mode bundle:
[`packages/game-text/ADOPTING.md`](../../packages/game-text/ADOPTING.md) and
[`adoption.manifest.json`](../../packages/game-text/adoption.manifest.json). Its release conformance
is part of `pnpm test:release:packages`.

Package adoption metadata does not select or version a release. A consumer-facing package change
must include a Changeset created with `pnpm changeset`; Changesets owns package selection, internal
dependency propagation, changelogs, and publication order.

## Design checklist

Before declaring a new workflow agent-ready, answer these questions in its product document or
implementation plan:

- What stable identifiers let an agent choose the project, target, and candidate without guessing?
- What durable artifact represents a proposed change or in-progress session?
- Which action is merely preparation, and which action commits a mutation?
- What explicit approval input prevents an unsafe default from being committed?
- What typed output lets an agent distinguish ready, unavailable, stale, blocked, partial, and
  completed states?
- What evidence proves the workflow against a fresh generic fixture or project?
- If a maintained UI is adoptable, where are its agent guide, manifest, materializer, and
  fresh-workspace verifier?

If any answer requires "inspect Workbench" or "infer it from source," the public adoption or
operational contract is incomplete. Add the missing surface before treating the workflow as a
supported agent story.

## Scope discipline

Not every domain package needs an adoption manifest. Read-only libraries, internal helpers, and
unmaintained experimental interfaces may expose ordinary documentation and typed APIs only. The
manifest requirement begins when UE Shed presents a maintained UI or host slice as something another
project should copy and own.

Every user-facing domain should still meet the operational requirements proportionately: explicit
inputs, typed outcomes, and no hidden mutation defaults. A future Map Review agent flow, for
example, needs explicit actor/candidate selection, reviewable previews and diagnostics, a durable
proposal, and a named approval before it may create or alter a Review Set.
