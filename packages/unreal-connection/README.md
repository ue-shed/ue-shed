# `@ue-shed/unreal-connection`

Typed Remote Control connectivity, companion capability negotiation, reconnect behavior, and
bounded data-plane helpers for headless UE Shed hosts. It depends on protocol contracts, not domain
UIs or Workbench.

```sh
npm install @ue-shed/unreal-connection@0.1.0-rc.3 @ue-shed/protocol@0.1.0-rc.3 effect@4.0.0-beta.98
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

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
