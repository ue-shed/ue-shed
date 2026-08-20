# Adopt plugin distribution into a trusted host

Read [`adoption.manifest.json`](adoption.manifest.json) first. Install one exact synchronized UE Shed
suite version and compose the package only in a trusted Node process.

1. Choose a caller-owned absolute cache root and its retention policy.
2. Provide one source layer: local artifacts, direct immutable HTTP assets, or the GitHub Release
   adapter.
3. Provide `pluginStoreLayer({ cacheRoot })` and `pluginDistributionLayer()` once for the host
   runtime.
4. Acquire an exact release and requested plugin IDs inside the same Effect scope as the supervised
   Unreal editor session. Pass the returned absolute descriptor paths to `@ue-shed/engine`.
5. Keep runtime capability requirements separate. Negotiate them after Unreal is ready through
   `@ue-shed/engine` / `@ue-shed/unreal-connection`.
6. Surface `PluginAcquisitionProgress` and tagged errors without parsing messages. Support an
   explicit cache-only policy and explicit pruning.

The adopting host owns cache location, update policy, user presentation, and mapping product
capabilities to UE Shed plugin IDs. Do not copy Workbench code, install into `<Project>/Plugins`, use
floating releases, or release the acquisition scope while Unreal still uses a descriptor.

Verify the packed consumer with `pnpm test:release:packages`, then prove acquisition and supervised
launch through the adopting host's real packaged transport.
