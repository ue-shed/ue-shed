# `uasset-parser-wasm`

The Node/browser WebAssembly adapter for UE Shed's portable saved-package parser. The host supplies
bounded `.uasset` or `.umap` bytes; filesystem discovery, scanning, caching, and subprocess authority
remain outside the module.

Build a Node-consumable package from the repository root:

```powershell
pnpm run uasset:build:wasm
```

Run the binding tests, including byte-for-byte parity with native `uasset inspect`:

```powershell
pnpm run test:uasset-wasm
```

Run the native-process and long-lived WASM benchmark:

```powershell
pnpm run benchmark:uasset:wasm
```

The binding returns the same schema-versioned JSON inspection document as the native `inspect`
command. It deliberately accepts a display path separately from bytes; the path is provenance, not
filesystem authority.
