---
"@ue-shed/protocol": minor
"@ue-shed/unreal-connection": minor
"@ue-shed/engine": patch
---

Expose initialized live DataTable defaults and bounded actor/component row-reference lookup.
Add an optional Unreal automation provider with explicit local-player input injection and owned
CSV capture control, typed headless clients, shared contracts, and an authoring/automation source
bundle. Existing hosts adopt the versioned UE Shed contracts without legacy native endpoints.

Text values now carry their localization identity (snapshot 2.3, Apply 1.2): localized namespace and
key, string-table entry, culture-invariant, or generated. Apply writes text from that identity,
mints keys in the table package on request, and keeps identity for Apply 1.1 clients that rewrite an
unchanged display string. Producer refusals are typed `UnrealConnectionError` codes. A new
`editor-host` plugin bundle combines camera authoring with DataTable authoring.
