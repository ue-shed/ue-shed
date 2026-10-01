---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Add opt-in `renderer.editorPreviews` to camera render policies. When true, viewport and
SceneCapture renders show child actors that ChildActorComponents spawn for editor-only owners,
such as spawn-volume previews, while the owners and other editor-only content stay hidden. The
plugin restores the original editor-only flags when the session ends, fails or its world is
cleaned up, and saves never write the changed flag. Renderers report `editorPreviews` support
in their capabilities; frame evidence records how many child actors were shown. Older plugins
reject the field, so the renderer reports `unsupported_capability` before opening a session.
