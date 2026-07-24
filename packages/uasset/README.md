# `@ue-shed/uasset`

The platform-selecting `uasset` command for UE Shed's read-only saved-asset parser. Version
`0.1.0-rc.3` supports Windows x64 and installs the matching native artifact through an exact optional
dependency.

```powershell
pnpm add --save-exact @ue-shed/uasset@0.1.0-rc.3
pnpm exec uasset --version
pnpm exec uasset inspect ./Content/Example.uasset --format json
```

The launcher resolves only the executable contained in `@ue-shed/uasset-win32-x64`. It never builds
Cargo sources, searches a sibling checkout, probes `target`, or downloads an executable at runtime.
Unsupported platforms fail with `UnsupportedPlatformError`; a missing optional dependency fails with
`PlatformPackageUnavailableError` and reinstall guidance.

Node.js 22.14 or later is required. The package and native parser are MIT licensed.
