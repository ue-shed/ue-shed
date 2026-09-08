---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Add scoped and one-shot editor-world camera rendering with explicit viewport and SceneCapture
policies, preparation, native ownership, restoration, progress and artifact evidence. Adopt the
shared lifecycle in Review previews/final captures and all existing map modes. Fixed Review cameras
no longer depend on live subject resolution. Requires the matching UEShedCore/UEShedCameras bundle
advertising cameras.render-session.v1; existing Review documents retain their legacy policy.
