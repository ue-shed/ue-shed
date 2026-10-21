# `@ue-shed/enhanced-input`

Read-only projection of Enhanced Input `InputAction`, `InputMappingContext` and
`PlayerMappableInputConfig` assets from saved packages, and the analysis built on it: the key
atlas, co-activation sets, conflict classes, usage and platform views. Builds on
`@ue-shed/unreal-assets` inspect output; missing serialized fields stay `unavailable` rather than
inventing CDO defaults. The product contract is [Input Atlas](../../docs/products/input-atlas.md).

```ts
import { EnhancedInputService, EnhancedInputServiceLive } from "@ue-shed/enhanced-input";
import { AssetReaderLive } from "@ue-shed/unreal-assets";
import { Effect, Layer } from "effect";

const report = await Effect.runPromise(
	Effect.flatMap(EnhancedInputService, (service) =>
		service.inspectPath("Content/Fixture/Input/IMC_Fixture.uasset")
	).pipe(Effect.provide(EnhancedInputServiceLive), Effect.provide(AssetReaderLive))
);
```

`scan` accepts optional `paths` to scope enumeration to roots beneath the project, so a single
directory can be inspected without walking all of `Content`.

Every step is a separate export a host can compose or replace: the projectors
(`inputActionFromInspection`, `mappingContextFromInspection`,
`playerMappableConfigFromInspection`), `buildInputAtlas`, the co-activation resolvers, the
`classifyInputConflicts` classifier, `inputActionUsage`, the platform helpers, and the effectful
sources (`resolveDefaultContextsFromConfig`, `readCoActivationDocument`,
`scanBlueprintInputActionUses`, `resolvePlatformViews`). `./browser` exports only the schemas and
pure derivations.

CLI: `ue-shed input inspect|atlas|conflicts|unused|platforms|export`. For unfiltered package
listings across any path, see `ue-shed assets scan`.
