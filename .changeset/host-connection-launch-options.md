---
"@ue-shed/unreal-connection": minor
"@ue-shed/engine": minor
"@ue-shed/plugin-distribution": minor
---

Hosts can configure Remote Control access, editor launches and plugin sources without changing UE
Shed. All additions are optional; existing calls behave as before.

- `makeRemoteControlClient` accepts `passphrase`, sent as Unreal's Remote Control `Passphrase`
  header, and extra `headers` for every request. An editor's HTTP 401 now reports a refused
  passphrase, with `fix_input` guidance, instead of a generic refusal.
- A launch can add the host's own Remote Control classes to the UE 5.8 allowlist:
  `remoteControlAllowedClasses` on the `with_plugins` launch mode and on
  `SupervisedEditorSessionRequest`. `unrealRemoteControlPermissions(pluginIds, additionalClasses)`
  and the `RemoteControlAllowedClass` schema (`Module.Class`) are exported.
- `readEngineInstallation(root)` reads an engine root's version without the registry or a project.
- `EditorConnectionRequest.requestTimeout` bounds each manifest request.
- Test layers: `makeEditorWindowActivationTestLayer`, `makeEditorForegroundPermissionTestLayer`,
  `makeEditorForegroundResponsivenessTestLayer`, `makePluginDistributionTestLayer` and
  `makeCompiledPluginBuilderTestLayer`.
- `githubReleaseSourceLayer` accepts `assetNames`, so it serves bundles other than Map Review's.
