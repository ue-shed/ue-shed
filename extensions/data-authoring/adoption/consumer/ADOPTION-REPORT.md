# Data Authoring adoption report

- Source commit: `__SOURCE_COMMIT__`
- Target: `__TARGET__`

## Commands

Record the exact materialize command here.

```powershell
pnpm install --offline --ignore-scripts --frozen-lockfile=false
pnpm build:reader
pnpm verify -- --expected-accent=#ff6b6b
pnpm verify:host -- --project=<unreal-project-root> `
  --reader=<target>/target/release/uasset.exe
```

## Results

Replace this line with the install, build, UI verification, discovered DataTable count, opened real
object path, and functional host verification results.

## Ambiguities and workarounds

Replace this line with `None.` or a precise account of each ambiguity and workaround.

## Undeclared inputs

Replace this line with `None.` or every file/input used that was not declared by the manifest.
