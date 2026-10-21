---
"@ue-shed/protocol": patch
"@ue-shed/game-text": patch
---

Fix Game Text key and source fixes on DataTable cells whose row struct is a User Defined Struct.
The saved reader names such a cell by the member's FName (`DisplayName_2_<guid>`), but live rows use
its authored name (`DisplayName`), so every fix failed with "The live cell no longer holds the
source and key you reviewed." Authoring snapshot 2.4 field descriptors carry `propertyName`, the
FName, and the UEShedAuthoring plugin reports it. Table fixes bind the reviewed cell through it and
send `set_cell` the FName. A column missing from the live row now fails with its own
`TextIdTableColumnError`, which says when the editor's plugin predates property names.
