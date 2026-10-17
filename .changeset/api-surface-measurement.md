---
---

Measure the public surface of the host-facing packages (Plan 058 D13). `node scripts/measure-package-exports.ts` lists, for every entry point of `protocol`, `unreal-connection`, `localization`, `unreal-assets`, `engine`, `cameras` and `host`, how many exported names are imported elsewhere in the repository and which are not. The numbers are in `docs/engineering/api-surface.md`. The private `@ue-shed/host` package now exports only the 13 names its consumers use. No published package changes in this step.

Literal dynamic imports are found recursively, including inside Effect callbacks. Namespace,
dynamic and type imports retain the whole entry point conservatively; the reported usage counts
are upper bounds and do not prove other exports are safe to remove.
