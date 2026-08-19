//! Portable projections over decoded Unreal Engine packages.
//!
//! The public surface is intentionally independent of filesystem access, process execution,
//! caches, and scheduling. These projections are the portable ownership boundary used by native
//! IO and the WebAssembly adapter.

pub mod generic;
pub mod level_sequence;
pub mod projection;
pub mod saved_world;

pub use level_sequence::{
    LEVEL_SEQUENCE_CLASS, LevelSequenceProjection, SequenceBinding, SequenceCoverageGap,
    SequenceCoverageGapReason, SequenceFrameBound, SequenceFrameBoundKind, SequenceFrameRange,
    SequenceFrameRate, SequenceReference, SequenceReferenceCoverageGap,
    SequenceReferenceCoverageGapReason, SequenceReferenceKind, SequenceReferenceScope,
    SequenceSection, SequenceTextIdentity, SequenceTextKey, SequenceTrack, SequenceTrackContent,
    project_level_sequence,
};
pub use projection::{
    Evidence, EvidenceSource, EvidenceUnavailableReason, TEXTURE2D_CLASS, TextAssetProjection,
    TextCoverageGap, TextCoverageGapReason, TextEditCapability, TextIdentity, TextIdentityReason,
    TextLocation, TextOccurrence, TextureDimensions, TextureRecord, project_text_asset,
    project_texture_asset,
};
pub use saved_world::{
    SavedWorldActorEvidence, SavedWorldAttachment, SavedWorldPackageFragment, SavedWorldQuaternion,
    SavedWorldTransform, project_saved_world_package, resolve_saved_world_actors,
};
