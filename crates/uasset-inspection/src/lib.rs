//! Portable projections over decoded Unreal Engine packages.
//!
//! The public surface is intentionally independent of filesystem access, process execution,
//! caches, and scheduling. These projections are the portable ownership boundary used by native
//! IO and the WebAssembly adapter.

pub mod generic;
pub mod projection;
pub mod saved_world;

pub use projection::{
    Evidence, EvidenceSource, EvidenceUnavailableReason, TEXTURE2D_CLASS, TextAssetProjection,
    TextCoverageGap, TextCoverageGapReason, TextEditCapability, TextIdentity, TextIdentityReason,
    TextLocation, TextOccurrence, TextureDimensions, TextureRecord, project_text_asset,
    project_texture_asset,
};
pub use saved_world::{
    SavedWorldActorPosition, SavedWorldPackageFragment, SavedWorldPosition,
    project_saved_world_package, resolve_saved_world_positions,
};
