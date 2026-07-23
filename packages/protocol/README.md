# `@ue-shed/protocol`

Runtime schemas, branded identifiers, compatibility values, and versioned wire contracts shared by
UE Shed clients and Unreal companion plugins.

```sh
npm install @ue-shed/protocol@0.1.0-rc.2 effect@4.0.0-beta.98
```

The package supports Node.js 22.14 or newer and exposes one stable JavaScript entry point:

```ts
import {
	CURRENT_PROTOCOL_VERSION,
	CapabilityManifest,
	decodeCapabilityManifest
} from "@ue-shed/protocol";
```

The root entry point includes the core capability and connection schemas plus the authoring, camera,
companion, and editor play-session contracts. Internal source modules are not public subpaths.

The `contracts/` directory in the package contains the language-neutral JSON Schema authorities and
conformance fixtures. These files are shipped for protocol implementors, but JavaScript consumers
should use the runtime schemas exported from the package root.

The current core protocol version is `0.1`. Individual domain contracts carry their own versions;
consumers must validate untrusted wire input instead of casting it to an exported TypeScript type.

This package does not connect to Unreal Engine, launch processes, or depend on the UE Shed Workbench.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
