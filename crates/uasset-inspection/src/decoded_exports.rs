//! Exports decoded at most once across several inspections of one parsed package.

use std::cell::OnceCell;
use std::ops::Deref;

use uasset_parser::asset::{AssetDecodeContext, AssetError, DecodedAsset, decode_export};
use uasset_parser::package::Export;

/// One export's decode result.
pub type ExportDecode = Result<Option<DecodedAsset>, AssetError>;

/// Keeps each export's decode from the first inspection that reads it, so inspections of one
/// package share decodes without decoding exports none of them reads. An empty cache holds one
/// pointer per export.
///
/// Every read of one cache must use the same decode context: the package the cache was created
/// for, no property filter, and one schema provider.
pub struct DecodedExports {
    cells: Vec<OnceCell<Box<ExportDecode>>>,
}

impl DecodedExports {
    /// An empty cache for a package with `export_count` exports.
    #[must_use]
    pub fn new(export_count: usize) -> Self {
        Self {
            cells: std::iter::repeat_with(OnceCell::new)
                .take(export_count)
                .collect(),
        }
    }

    /// How many exports the cache has decoded so far.
    #[must_use]
    pub fn decoded_count(&self) -> usize {
        self.cells
            .iter()
            .filter(|cell| cell.get().is_some())
            .count()
    }

    /// The decode of `export`, the package's export at `index`. With a cache it is decoded on
    /// first use and kept; without one it is decoded for this read only, so a single inspection
    /// never holds exports it has moved past.
    pub fn decode<'a>(
        cache: Option<&'a Self>,
        index: usize,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Decoded<'a> {
        match cache.and_then(|cache| cache.cells.get(index)) {
            Some(cell) => {
                Decoded::Kept(cell.get_or_init(|| Box::new(decode_export(export, context))))
            }
            None => Decoded::Once(decode_export(export, context)),
        }
    }
}

/// An export's decode, borrowed from a cache or owned by one read.
pub enum Decoded<'a> {
    Kept(&'a ExportDecode),
    Once(ExportDecode),
}

impl Decoded<'_> {
    /// The decoded asset, moved out of a one-time decode or cloned from a kept one.
    #[must_use]
    pub fn into_asset(self) -> Option<DecodedAsset> {
        match self {
            Self::Kept(Ok(asset)) => asset.clone(),
            Self::Once(Ok(asset)) => asset,
            Self::Kept(Err(_)) | Self::Once(Err(_)) => None,
        }
    }
}

impl Deref for Decoded<'_> {
    type Target = ExportDecode;

    fn deref(&self) -> &ExportDecode {
        match self {
            Self::Kept(decode) => decode,
            Self::Once(decode) => decode,
        }
    }
}
