# `@ue-shed/authoring-sdk`

Browser-safe client contracts for the maintained first-party Data Authoring interface. The package
exposes scoped session reads and semantic draft intents without importing Workbench or granting
filesystem, process, or raw Unreal access to a renderer. Apply and Save are explicit session actions
whose authority remains in the host service.

Trusted hosts may implement this client to embed the maintained extension. This package is not an
untrusted-extension SDK, capability sandbox, custom-UI registry, or generated-interface platform.

The implemented boundary exposes runtime-validated session views, recent-session summaries,
open/discard operations, complete Session Review models, and atomic
cell/add/duplicate/remove/rename/reorder intents. The Workbench preload transports only these scoped
values: the renderer receives no session paths, filesystem access, or raw Unreal calls.
