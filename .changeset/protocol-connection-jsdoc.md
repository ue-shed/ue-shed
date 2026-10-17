---
"@ue-shed/protocol": patch
"@ue-shed/unreal-connection": patch
---

Add public-export documentation across `@ue-shed/protocol` and `@ue-shed/unreal-connection` (Plan 058 D11). The documented schemas, decoders and services explain wire or Unreal meaning, units and bounds, contract or protocol versions, and decoding failures. Failures are described in prose, not as `@throws`.

A new lint rule, `anti-slop/require-jsdoc-on-exports`, covers both packages with explicit exceptions. Re-exports are covered at their declaration, and a type or interface named after a documented schema constant shares its documentation. Four files remain outside this lint scope: `protocol/src/index.ts`, `protocol/src/error-guidance.ts`, `unreal-connection/src/index.ts` and `unreal-connection/src/remote-control-client.ts`. D11 remains in progress for those boundaries and the remaining packages.

No API changes.
