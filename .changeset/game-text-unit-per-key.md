---
"@ue-shed/game-text": minor
---

One saved unit per key Unreal translates. Units key resolved text by the namespace without its
package marker (`unreal:<gathered namespace>:<key>`), as gathered text does; String Table entries
and references keep theirs. Text saved under one key in several packages is one unit with all its
places, and its `shared` signal no longer shows on a unit with one place. Occurrences keep the full
saved namespace. Unit IDs of such text change, so joined caches rebuild once (`joined-native-v3`);
saved selections by unit ID of multi-package keys need their new ID.
