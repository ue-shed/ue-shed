# Saved graph pin text regressions

These are disposable UE Shed fixture Blueprints saved by Unreal 4.27.2, 5.6.1, 5.7.4 and 5.8.3
during Game Text key-repair/source-edit acceptance (2026-10-19/20). No studio assets are included.
Each `expected.json` contains the three `graph_pin` places from that run's independent,
fresh-editor `source-reload.json`: split, regenerate and adopt. The packages are the final
source-edit saves, not the earlier key-only phase. Stable package namespaces are preserved;
the expectations use Unreal's gathered namespace without its package marker.

Original evidence directory basenames, retained outside the repository:

- 4.27: `ueshed-427-acceptance-06`
- 5.6: `ueshed-427-round3-56-acceptance-01`
- 5.7: `ueshed-427-round2-57-acceptance-03`
- 5.8: `ueshed-427-round2-58-acceptance-03`

In each directory the source is `project/Content/KeyRepairs/BP_Keys.uasset`.
The producer is the Game Text fixture/commandlet used by the UE 4.27 compatibility acceptance
reports; the final UE 5.6 acceptance records candidate `778c74c9`.
Regeneration requires that acceptance producer and the corresponding engine; existing fixture saves are
sufficient for all committed regressions. Never overwrite the native reload expectations with
reader output.

SHA-256 of the saved package bytes:

```text
4.27 509a549a269801ee55bc7a379a3e32d9325bb7ddf3ead7618c01f421f373e3cc
5.6  2ff8ace9a6754a22cd218fd9ad5ef05ded5b1928766328c9cf1582fc6e203f07
5.7  f5141640d68b59a308e05907034ea85c7eff966ab332d14613b24f7ec6a2f26f
5.8  035756196fca9d57bb1c99626aa52d1210d9dd47c172adfcffca0a6aa7214194
```

`cargo test -p uasset-inspection --test graph_pin_text` checks all three identities, sources and
pin indices on every engine. Native protocol and WASM adapter regressions also damage one node
stream while preserving the package gather table: it must report partial coverage with a named
`Pins` gap. UE 4.27 retains unrelated legacy native/property coverage gaps in the intact package.
