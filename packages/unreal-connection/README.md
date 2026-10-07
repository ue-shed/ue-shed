# `@ue-shed/unreal-connection`

Typed Remote Control connectivity, companion capability negotiation, reconnect behavior, and
bounded data-plane helpers for headless UE Shed hosts. It depends on protocol contracts, not domain
UIs or Workbench.

```sh
npm install --save-exact @ue-shed/unreal-connection @ue-shed/protocol effect@4.0.0-beta.98
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

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.

`inspectUnrealProducer(endpoint)` reads the Core capability manifest without requiring Authoring.
Optional `identity` includes engine version, process ID, a Core session identifier, and versions
and loaded modules for enabled UE Shed plugins. Versions describe loaded plugin descriptors;
capabilities remain authoritative for feature negotiation. `ue-shed doctor --endpoint <url>`
prints this evidence. Older producers may omit identity.
