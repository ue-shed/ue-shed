# Saved actor and component native serialization

Status: DONE on 2026-09-30. Started after the next-five Blueprint/Sequencer batch.

Decode the small inherited actor/component records currently reported as opaque bytes. Keep saved
construction-script member references and serialization flags distinct from tagged properties.
Preserve arbitrary subclass suffixes and never execute construction scripts or infer effective defaults.

- [x] Source-check UObject footer, Actor cooked-label flag, ActorComponent modified-member array,
      SceneComponent conditional bounds flag and custom-version gates on UE 5.7 and UE 5.8.
- [x] Decode bounded native records through shared generated layouts; retain unknown subclass data.
- [x] Expose generic native evidence and Blueprint saved-object evidence; include decoded references
      in navigation, comparison and Sequencer reference inventory.
- [x] Generate empty/nonempty member lists and conditional scene records; reload independently in
      each engine and compare Unreal APIs with native/WASM/public readers.
- [x] Cover malformed records, version branches and unknown suffixes, run both-engine matrix and
      complete pnpm check; document the final supported boundary.

Scope is classic uncooked versioned packages. Cooked payloads, generated Blueprint class/function
payloads, editing, compilation and evaluated playback remain separate work.

## Delivered behavior

The engine model includes Actor, Pawn, Character, ActorComponent, SceneComponent, MovementComponent,
RotatingMovementComponent, CameraActor and CameraComponent ancestry. Checked source recipes establish
record order, custom-version GUIDs and thresholds, and class-default-object save dispatch. Shared
generated layouts decode the Actor cooked-label marker, ActorComponent construction-script modified
member references and SceneComponent conditional bounds marker after the UObject GUID footer.

Class default objects use Unreal's separate SerializeDefaultObject path; they do not consume instance
footers or records. Instance ancestry comes from source-owned classes or actual saved
BlueprintGeneratedClass superclass exports, with bounded traversal. Native project class ancestry is
not guessed. SceneComponent's bounds marker requires an explicitly saved true
bComputeBoundsOnceForGame value. An omitted value can depend on an inherited default, so additional
bytes remain opaque. Older custom versions omit records according to their checked gates.

Generic inspection and Blueprint saved objects expose optional native_data alongside tagged properties.
Native process readers, protocol schemas, WASM, public readers, comparisons, reference navigation and
the offline Blueprint inspector preserve the same evidence. Native member-parent references also enter
the Sequencer reference inventory. The WASM projection budget includes nested native record items.
Unknown subclass suffixes retain their spans; compiled Blueprint class/function data remains opaque.

The fresh saved-sequence fixture includes a spawnable camera actor, two modified camera-component
members and an explicit scene bounds flag. Independent Unreal reloads compare GetUCSModifiedProperties
and scene values against Rust, WASM and public-reader output. All three inherited fixture tails decode
fully, removing their Sequencer reference gaps. The basic Blueprint graph fixture also loses its final
component-tail gap and now reports a complete saved-graph projection.

## Verification evidence

- UE 5.7.4: passed source/struct/native-layout checks, fresh generation, independent Unreal reload,
  native oracle comparison and native/WASM/public-reader conformance.
- UE 5.8.2: passed the same checks independently. Combined results:
  out/uasset-engine-matrix-zOjN6r/results.json; command log:
  out/actor-component-tails/engine-matrix-final.log.
- Five native-object decoder tests cover truncation, invalid counts/names/object indexes, GUID bit
  preservation, custom versions, explicit/omitted scene conditions, CDO framing and unknown suffixes.
  Source-generation tests reject changed member order, version gates and CDO dispatch. Focused native,
  inspection, IO, public comparison, viewer and WASM budget checks passed.
- Full pnpm check passed: Rust/WASM/IO, 18 packed packages, isolated Data Authoring adoption,
  type/lint/format/architecture/contracts and 1,306 tests across 220 files. Standard unrelated live
  integration gates skipped 50 tests across 14 files; required parser Unreal conformance ran on both
  engines above. Evidence: out/actor-component-tails/full-check2.log.
- Eight offline Workbench journeys passed against the freshly built application, including native
  component evidence and checks that no Unreal process launched:
  out/actor-component-tails/e2e-final2.log. The initial run exposed an incorrectly scoped test locator
  and a stale partial-coverage expectation; both assertions were corrected before the successful run.

The full gate also caught a published JSON-schema root-shape mismatch and a stale packed-consumer
status assertion. Both were fixed before the successful full rerun. The engine matrix caught native
process adapters dropping optional native_data; both adapters now preserve it and the full matrix
passed again on both engines. No product execution, editing or compilation was added.
