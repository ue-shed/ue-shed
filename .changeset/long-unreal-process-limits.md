---
"@ue-shed/engine": minor
"@ue-shed/game-text": minor
"@ue-shed/localization": minor
"@ue-shed/niagara": minor
"@ue-shed/unreal-connection": minor
---

Long Unreal work on big projects no longer has to fail at a limit the host can't raise.

- A Game Text localization step that runs past 30 minutes no longer has to time out: set
  `timeoutSeconds` on the host passed to `makeGameTextOperations`. The timeout's recovery names it.
- A verbose gather whose commandlet log passes 256 MiB no longer has to stop: raise it with
  `makeLocalizationOperationsLayer({ logLimits: { maxBytes } })`. The failure now names
  `logLimits.maxBytes`. `defaultLocalizationLogLimits` and `defaultLocalizationTimeoutSeconds` are
  exported.
- A Niagara preview whose cold shader compile takes over 30 minutes no longer has to time out: pass
  `commandletTimeoutMs`, or `sessionTimeoutMs` for a host-owned session, to `runNiagaraPreview`.
  A session that returns no result in time now fails with `process_timeout` naming the option,
  instead of a generic "session failed or was cancelled".
- A supervised editor's first open with an empty DDC no longer fails validation when given more
  than an hour: `readinessTimeoutMs`, `readinessPollIntervalMs` and `terminationTimeoutMs` accept up
  to 24 hours. A readiness timeout now names `readinessTimeoutMs`.
- Remote Control calls in `@ue-shed/unreal-connection` send stable operation names (for example
  `unreal.authoring.apply`, `unreal.authoring.save`, `unreal.authoring.actor_references`) instead of
  `remote_control.<Function>`, so a host can give one slow call more time. Both READMEs list the
  names. An `UnrealConnectionError` from a failed call carries the new name in `operation`.
