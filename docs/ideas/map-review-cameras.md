# Map review camera system

> Status: product vision with technical footholds

## Ambition

Give teams a durable visual memory of important buildings, spaces, and world features. Authors should
declare what deserves observation, generate useful viewpoints, art-direct exceptions, capture the
same intent repeatedly, and review change over time without filling shared maps with tooling actors.

This is not simply a scheduled screenshot command. It is a review language describing the subject,
purpose, framing, context, visibility policy, environment, and relationship to earlier captures.

## North star

A review camera is a durable statement of **visual intent**, not only a transform.

## Principles

### Definitions are independent from runtime presence

Camera definitions should normally live outside the map in a dedicated camera-set asset or portable
document. Transient camera actors and capture components realize that data for preview or capture.

A definition may include stable camera and subject identity, transform/projection/FOV, aspect and
framing policy, preset lineage, manual adjustments, pure/clear policy, visibility overrides, region,
owner, purpose, tags, streaming/warm-up requirements, and compatibility with live observation.

### Author spatially and preview immediately

The intended loop is:

1. select actors, components, or a region;
2. generate one or more views from a framing preset;
3. preview the actual capture result;
4. art-direct individual views;
5. persist refinements in the independent definition.

Bounds are only a starting signal. Good framing considers projected bounds, aspect ratio, margin,
near clip, orientation, multiple subjects, and the purpose of the view.

### Pair truth with legibility

Where useful, capture two images from the same pose:

- **Pure:** the ordinary rendered world with its real occlusion and context.
- **Clear:** an explicitly isolated or de-occluded view that makes the subject legible.

Never present Clear as untouched truth. Retain the pair and record which actors/components were hidden
and why. Automatic sweeps, show-only sets, manual overrides, and hybrid policies each have valid
tradeoffs; the decision must remain inspectable.

### Identity must survive world evolution honestly

Soft paths and labels alone are brittle. Resolve subjects through a layered identity: stable authored
ID when available, actor/instance GUID signals where valid, soft reference, semantic tags, diagnostic
label/path, and an explicit fallback query. Resolution failure is a visible capture result, not an
empty image counted as success.

### Collaboration isolation must be real

Independent camera-set data and transient realization are the default. Optional external spatial
authoring can be considered when persistent gizmos earn their package and source-control cost.

Avoid one global asset becoming a lock bottleneck. Partition definitions by region, purpose, owner,
or another composable boundary.

### Record the capture environment

Repeated transforms do not guarantee comparable images. Capture metadata should describe streaming
readiness, warm-up, LOD/HLOD state, exposure, weather/time, execution mode, resolution, aspect,
scalability, platform, render settings, and failures.

### Prefer visual history over automatic judgment

The first value is a navigable history. Image comparison can direct attention, but pixel difference
is not automatically a regression. Cluster by subject and view, pair Pure/Clear, expose environmental
changes, and retain review decisions so humans and agents can interpret evidence.

### Share a camera language with live observation

Scheduled review and sparse live feeds have different runtime constraints but compatible identity and
intent. Reuse definitions where sensible while allowing mode-specific overrides. Scenario markers and
actor incidents should reference the same camera IDs.

## Technical footholds to verify per supported engine version

| Need                       | Unreal surface                                 |
| -------------------------- | ---------------------------------------------- |
| Selection                  | editor selection APIs                          |
| Framing inputs             | actor/component bounds and transforms          |
| Camera realization         | camera actors and `USceneCaptureComponent2D`   |
| Explicit capture           | `CaptureScene()`                               |
| De-occlusion               | hidden/show-only actor and component lists     |
| Independent definitions    | DataAsset-style structs or portable documents  |
| External spatial authoring | External Data Layers where appropriate         |
| Comparison assistance      | screenshot comparison and image comparer tools |

## Tracer bullet

1. Select one meaningful generic fixture structure or region.
2. Generate several preset camera definitions into an independent set.
3. Preview transient cameras and persist one manual adjustment.
4. Capture paired Pure and Clear images.
5. Record subject resolution, visibility decisions, environment, and timing.
6. destroy transient actors and prove the map remains untouched.
7. Repeat from a fresh process and present the two runs as history.
8. Reuse one definition as a sparse live camera.

## Anti-goals

- Permanent map actors as the only camera database.
- Auto-framed captures with no preview or refinement.
- De-occluded images shown without their Pure counterpart.
- Actor labels as the only identity.
- One globally locked camera-set asset.
- Captures before streaming or temporal state settle.
- Empty or partial images silently counted as success.
- A pixel-diff approval gate defining the product.
- Separate incompatible camera systems for history and live observation.

## Decisions to earn

Camera-set schema and partitioning; stable subject resolution; framing presets; explainable occluder
discovery; readiness and environment policy; gallery/review workflow; shared live fields; and the
eventual scheduled runner topology.
