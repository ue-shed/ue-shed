---
"@ue-shed/cameras": patch
"@ue-shed/plugin-distribution": patch
---

Authored visibility leaves out more kinds of actor. A hidden actor is now left out with every
component it draws and the child actors its components spawned: static, instanced and skeletal
meshes with opaque, masked or translucent materials. Components that draw nothing, such as a
collision shape or an editor icon, no longer make an actor unsupported, so most Blueprint actors and
trees with masked leaves can be hidden. Nanite meshes and terrain are still refused, and an actor
that draws nothing is refused because there is nothing to leave out; each refusal's diagnostic says
which. The `authoredVisibility.geometry` capability keeps its value for strict clients; ask
preflight about a particular actor.
