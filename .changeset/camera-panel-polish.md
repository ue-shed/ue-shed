---
"@ue-shed/cameras": minor
---

Polish the native Unreal camera panel for level designers. It opens from **Window → Cameras (UE
Shed)** in the Level Editor section (menu search finds "camera" or "UE Shed") as a short
**Cameras** tab with an icon and tooltip. **Select** frames the camera with its subject, or switches
the pilot while piloting. **Save views** is the primary action and the footer says how many views
are not saved yet. Numbers and the Visibility page use plain wording ("Distance (1 = fits
subject)", "Margin (% per side)", "What saved shots show") instead of raw values. Every preview tile
and camera-list row says whether its shot shows the subject (visible, partly hidden, blocked, not in
the shot or didn't render), measured with the review capture's depth comparison, and the summary
counts only shots that show it. Previews honour `renderer.editorPreviews`, which the Capture tab can
now turn on. Camera-list rows show thumbnails from the same preview renders.
