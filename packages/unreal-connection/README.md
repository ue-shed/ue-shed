# `@ue-shed/unreal-connection`

The application must provide `effect@^4.0.0` as a peer dependency. Reuse one compatible
Effect installation across the application and UE Shed libraries.

Typed Remote Control connectivity, companion capability negotiation, reconnect behavior, and
bounded data-plane helpers for headless UE Shed hosts. It depends on protocol contracts, not domain
UIs or Workbench.

```sh
npm install --save-exact @ue-shed/unreal-connection @ue-shed/protocol "effect@^4.0.0"
```

Node.js 22.14 or newer is required. The package exposes one stable entry point:

```ts
import {
	RemoteControlClient,
	RemoteControlClientLive,
	connectUnrealAuthoring
} from "@ue-shed/unreal-connection";
```

The first implemented adapter negotiates `UEShedCore` over Remote Control HTTP and exposes authoring
snapshot, Apply, operation lookup, and Save capabilities as typed Effect operations. Every HTTP
envelope and nested companion JSON result is runtime-validated. Calls have explicit timeouts, typed
retry guidance, and structured spans.

Map Review hosts use the same `RemoteControlClient` surface for camera and review editor calls.
This package does not install Unreal plugins, launch Workbench, or own review schemas.

Trusted hosts can also use `findUnrealActorsReferencingRow` for bounded, world-scoped DataTable
row-reference scans and `connectUnrealAutomation` for explicit local-player discovery, one-shot
Enhanced Input injection, and CSV capture control. These optional capabilities negotiate
independently of the authoring mutation suite and work without Workbench. Mutation failures are
never marked safe for automatic replay.

See [ADOPTING.md](ADOPTING.md) for native installation, contract translation, and the real host
verification journey.

## Open or locate an editor asset

`locateUnrealAsset({ endpoint, objectPath, bringToFront })` reveals/selects an asset in the Content
Browser using `editor.asset-navigation.v1`; it does not open an asset editor.
`openUnrealAsset({ endpoint, objectPath, bringToFront })` separately negotiates
`editor.asset-open.v1` before calling `OpenAsset` on the manifest's `assetNavigationObjectPath`.
It requires only the Core plugin's editor module, without Authoring or Workbench.

```ts
import { Effect } from "effect";
import { openUnrealAsset, RemoteControlClientLive } from "@ue-shed/unreal-connection";

const request = openUnrealAsset({
	endpoint: "http://127.0.0.1:30010",
	objectPath: "/Game/Folder/Asset.Asset",
	bringToFront: true
}).pipe(Effect.provide(RemoteControlClientLive));
```

The result is `EditorAssetOpenResult` from `@ue-shed/protocol`: `status: "ok"` when Unreal accepts
the request, or `status: "unavailable"` with `reason`, `message`, `recovery`, and `retrySafe`.
Missing assets and editor refusals are unavailable values; transport, malformed replies and missing
capabilities remain `UnrealConnectionError | UnrealCapabilityError`. A plugin supporting locate
alone cannot open assets. Project, engine and plugin content roots are supported; use a top-level
object path, not a package-only path or subobject.

`bringToFront` requests focus of an existing asset editor; a newly opened editor follows Unreal's
normal focus behavior even when false. Success does not confirm OS foreground activation. Hosts
choose when to open and how to present results. The open call is never automatically retried.
Unreal asset types retain their normal behavior, including map opening. See the
[wire contract](../protocol/contracts/editor-asset-open/v1/README.md) for exact semantics.

UE 5.8 Remote Control permissions must allow
`/Script/UEShedCoreEditor.UEShedEditorAssetNavigationLibrary`. The engine package's
`unrealRemoteControlPermissions(["UEShedCore"])` already includes that exact class for both methods.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.

`inspectUnrealProducer(endpoint)` reads the Core capability manifest without requiring Authoring.
Optional `identity` includes engine version, process ID, a Core session identifier, and versions
and loaded modules for enabled UE Shed plugins. Versions describe loaded plugin descriptors;
capabilities remain authoritative for feature negotiation. `ue-shed doctor --endpoint <url>`
prints this evidence. Older producers may omit identity.

## Remote call recovery

`RemoteControlClient.request` never retries a call automatically. Set `idempotent: true` only when
the caller knows repeating the read or operation has no new side effects. It defaults to false.
A lost response, timeout or server failure can follow an applied mutation; those failures return
`retrySafe: false` and `nextStep: "reconcile"`. Inspect editor state before sending the mutation
again. An explicitly idempotent read can return `nextStep: "retry"` for transient transport errors.
Permanent refusals and malformed producer responses retain correction/escalation guidance;
replay safety alone does not make another identical call useful.
