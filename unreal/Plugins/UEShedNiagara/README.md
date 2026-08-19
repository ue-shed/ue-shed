# UEShedNiagara

Separately enabled Editor-only Niagara preview capture. The plugin accepts a versioned request:

```text
-run=UEShedNiagaraPreview -Request=<absolute-json-path> -AllowCommandletRendering
```

It loads one saved Niagara System, applies its Baker camera and timing plus bounded request
overrides, advances desired age inside an isolated preview scene, and stages straight-alpha sRGB
PNGs plus `producer-receipt.json` beneath:

```text
<Project>/Saved/UEShed/NiagaraPreviewStaging/<run-id>/
```

The request contains no destination path. `@ue-shed/niagara` validates, hashes, and publishes the
portable run. A rendering-capable RHI is required; do not use `-NullRHI`.
