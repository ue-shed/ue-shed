---
"@ue-shed/game-text": patch
"@ue-shed/uasset": patch
---

Index native Game Text occurrence, source-value and String Table dependencies separately. Stable
text edits locate affected groups and duplicate-source dependencies through native reverse indexes;
reference and identity changes retain their structural rebuild path. Retained-base undo reuses the
immutable base without rebuilding it. Dependency transactions are tied to the published revision
and dictionary generation, and interrupted updates roll back or reconstruct the disposable graph.
Package byte-size changes retain their updated evidence without forcing a membership rebuild.
