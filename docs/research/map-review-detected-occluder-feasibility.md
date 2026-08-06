# Detected-occluder intervention feasibility

**Decision date:** 2026-08-06

**Plan:** 032, Step 6

**Outcome:** `hide_detected_occluders` is unsupported and deferred.

## Question

Can Map Review safely turn visibility assessment into an automatic Clear intervention that hides
the actors it believes obscure a Review View?

The dependable path already captures Pure first and can then isolate the actor subject or hide an
explicit bounded actor list. Automatic intervention would additionally need render-truthful actor
attribution, confidence that survives richer scenes, subject self-protection, bounded environment
guardrails, and explainable failure behavior.

## Evidence

The UE 5.7 fixture proves two deliberately different assessment methods:

- `depth_compare` is render-truthful for depth-writing actor pixels and distinguishes unoccluded,
  partial, fully occluded, missing, offscreen, and unsupported translucent cases. Its result contains
  no actor attribution: `occluders` is always empty because the bounded depth images prove coverage,
  not which actor produced every winning depth sample.
- `ray_samples` can name actors hit by a bounded set of collision rays. That attribution is explicitly
  diagnostic. Collision response, coarse bounds samples, foliage instances, translucent materials,
  non-colliding render geometry, compound subjects, and large environment actors can disagree with
  the pixels that actually obscure the subject.

The richer generic camera fixture reinforces the boundary rather than closing it. It contains
multiple ordinary actors, attached/compound geometry, a deterministic blocker, translucent or
non-depth-writing material coverage, and surrounding level geometry. The render-truthful method
measures those cases without identifying blockers; the identifying method does not prove rendered
occlusion. Combining the two would infer that a collision hit caused a depth deficit without
evidence that joins the hit to the obscured pixels.

## Failure analysis

| Case                                       | Current evidence                                  | Automatic-hide risk                                                 |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| Opaque deterministic blocker               | Depth proves occlusion; rays may name the actor   | Correlation is plausible but not proven per pixel                   |
| Foliage or instancing                      | Depth may prove reduced coverage                  | Actor-level hiding may remove a broad environment object            |
| Translucency or non-depth-writing material | Depth returns `subject_depth_unavailable`         | No trustworthy render measurement to authorize intervention         |
| Compound or attached subject               | Rays self-protect the subject and attached actors | Component ownership and partial self-occlusion remain ambiguous     |
| Large environment actor                    | Rays may return one broad actor                   | Hiding it could alter most of the scene despite a small obstruction |
| Collision/render disagreement              | Rays and depth observe different representations  | False positives and false negatives cannot be bounded honestly      |

## Decision

Do not add `hide_detected_occluders` to the executable `VisibilityOutput` union, wire contract, CLI,
or maintained UI. The current schema therefore fails closed: documents containing that strategy do
not decode, and connected clients cannot advertise it as supported.

Keep raw diagnostic `OccluderEvidence` from explicit ray sampling available to consumers. It may
support a suggestion such as “inspect this likely blocker and add it to Hide in Clear,” but it never
grants mutation authority. The supported Clear strategies remain:

- `isolate_target`; and
- `hide_explicit` with a bounded author-selected list.

A future plan may revisit automatic intervention only after a render-truthful attribution method
joins obscured pixels to bounded actor/component identities and is proven against foliage,
translucency, compound subjects, and large environment actors. That work must earn guardrails before
the strategy enters any decodable contract.
