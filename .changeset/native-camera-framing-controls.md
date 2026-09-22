---
"@ue-shed/cameras": patch
---

Use smaller native camera drag ranges with exact typed values and explicit units. Disable
fitted framing and aim controls when the scope includes manually positioned cameras, keep FOV
available, and expose Restore fitted position next to the disabled controls.

Scale height, aim, dolly, and world-Z dragging to the subject's size so large scenes get useful
movement while small props retain precision, including when an existing offset is large.

Replace fitted controls with live world position, rotation, and FOV for manually positioned
cameras. Read native observations while draft saves are pending, and clarify the publication
action as Save views to Review Set with an explanation of its capture-ready snapshot behavior.

Keep fitted controls available in mixed manual/fitted scopes and switch checkbox selection to
Selected cameras, so manually positioning one camera cannot block editing the others.
