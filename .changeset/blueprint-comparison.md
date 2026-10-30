---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

Compare two saved revisions of a Blueprint without Unreal: `compareBlueprintRevisions` returns a
page of the nodes, wires, variables, components and class defaults a change added, removed or
changed, paired by saved identity so moved and renumbered nodes are counted rather than listed.
It needs the native reader's uasset-io v1.21 `compare_blueprints` request, and says what it did
not compare, such as a widget's layout.
