# UEShedNiagara

Separately enabled Editor-only Niagara preview capture. The plugin accepts a versioned request:

```text
-run=UEShedNiagaraPreview -Request=<absolute-json-path> -AllowCommandletRendering
```

It loads one saved Niagara System, applies its Baker camera and timing plus bounded request
overrides, advances desired age inside an isolated preview scene, and stages sRGB PNGs plus
`producer-receipt.json` beneath:

```text
<Project>/Saved/UEShed/NiagaraPreviewStaging/<run-id>/
```

The request contains no destination path. `@ue-shed/niagara` validates, hashes, and publishes the
portable run. A rendering-capable RHI is required; do not use `-NullRHI`.

Version 1.1 adds opaque scene rendering, fixed exposure, neutral lighting, a ground-impact floor,
and camera fitting across the requested animation. Transparent capture and the saved Baker camera
remain the defaults when no presentation settings are supplied. Requests may use contract 1.0 or
1.1 or 1.2; receipts use 1.2. Rebuild the plugin when upgrading the host to 1.2 requests.

Version 1.2 adds plain dark/light backgrounds with the floor mesh removed, independent of the
lighting cubemap, and an explicit perspective camera override for sharing framing across variants.
The host verifies that the recorded camera matches the override.

See [the product contract](../../../docs/products/niagara-preview.md) for profiles, timing and poster
selection, video encoding, and the limits of an isolated scene.
