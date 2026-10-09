---
"@ue-shed/localization": patch
"@ue-shed/game-text": patch
---

Match saved text carrying Unreal package namespaces to gathered localization identities, so
translations, key changes, review fingerprints and gates use the same namespace and key as Unreal.
Preserve full saved namespaces for asset inspection and detect shared identities and source
conflicts across packages without false duplicate-source findings.
