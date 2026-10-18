//! Prepared native substring searches over unique folded sources, including overlay additions.
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::join_policy::{js_space, trim};
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use memchr::memmem::Finder;
use std::sync::{Arc, atomic::AtomicBool};

pub(crate) struct SourceSearch {
    ids: Arc<[u32]>,
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
    additions: Vec<(u32, Vec<u8>)>,
    dictionary_count: usize,
}

impl SourceSearch {
    pub fn open(query: &mut EngineQuery, cancelled: &AtomicBool) -> Result<Self> {
        let dictionary_count = query.reader.dictionary_count()?;
        let mut seen = vec![false; dictionary_count];
        let (ids, starts, bytes) = if query.reader.has_column("query.source.folded") {
            let ids = query.reader.column("query.source.ids")?;
            let starts = query.reader.column("query.source.starts")?;
            let bytes = query.reader.bytes("query.source.folded")?;
            require(
                starts.len() == ids.len() + 1
                    && starts.first() == Some(&0)
                    && starts
                        .last()
                        .is_some_and(|last| *last as usize <= bytes.len())
                    && starts.windows(2).all(|pair| pair[0] <= pair[1]),
                "Invalid persisted source search ranges.",
            )?;
            for (row, id) in ids.iter().enumerate() {
                if row & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let slot = seen
                    .get_mut(*id as usize)
                    .ok_or("Source ID outside dictionary.")?;
                require(!*slot, "Duplicate source search ID.")?;
                *slot = true;
            }
            (ids, starts, bytes)
        } else {
            (Arc::from([]), Arc::from([0u32]), Arc::from([]))
        };
        // Walk references once per reader. Retained arenas may contain obsolete values; only
        // sources absent from the base need decoding after an incremental text edit.
        let lines = query.reader.column("line.source")?;
        let raw = query.column("raw", "sources")?;
        let mut additions = Vec::new();
        for (row, id) in lines.iter().chain(raw.iter()).copied().enumerate() {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let slot = seen
                .get_mut(id as usize)
                .ok_or("Source ID outside dictionary.")?;
            if !*slot {
                *slot = true;
                additions.push((
                    id,
                    Wtf8Buf::from_view(&query.reader.string(id)?.to_lowercase()).into_bytes(),
                ));
            }
        }
        checkpoint(cancelled)?;
        Ok(Self {
            ids,
            starts,
            bytes,
            additions,
            dictionary_count,
        })
    }

    pub fn matching(&self, query: &str, cancelled: &AtomicBool) -> Result<Arc<[u8]>> {
        let terms = FoldedTerms::new(query);
        let mut matches = vec![2; self.dictionary_count];
        for (row, id) in self.ids.iter().enumerate() {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let bytes = &self.bytes[self.starts[row] as usize..self.starts[row + 1] as usize];
            matches[*id as usize] = if terms.matches(bytes)? { 1 } else { 2 };
        }
        for (row, (id, bytes)) in self.additions.iter().enumerate() {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            matches[*id as usize] = if terms.matches(bytes)? { 1 } else { 2 };
        }
        checkpoint(cancelled)?;
        Ok(matches.into())
    }
}

struct FoldedTerms {
    bytes: Vec<Finder<'static>>,
    units: Option<Vec<Vec<u16>>>,
}

impl FoldedTerms {
    fn new(query: &str) -> Self {
        let lowered = query.to_lowercase();
        let terms = trim(&lowered)
            .split(js_space)
            .filter(|term| !term.is_empty())
            .map(Wtf8Buf::from_view)
            .collect::<Vec<_>>();
        let units = terms
            .iter()
            .any(|term| std::str::from_utf8(term.as_bytes()).is_err())
            .then(|| terms.iter().map(Wtf8Buf::to_utf16).collect());
        Self {
            bytes: terms
                .iter()
                .map(|term| Finder::new(term.as_bytes()).into_owned())
                .collect(),
            units,
        }
    }

    fn matches(&self, bytes: &[u8]) -> Result<bool> {
        if let Some(terms) = &self.units {
            // A lone UTF-16 unit can match inside a supplementary scalar. A byte-only
            // search would incorrectly lose that existing JavaScript substring behavior.
            let units = Wtf8Buf::from_bytes(bytes.to_vec())?.to_utf16();
            Ok(terms
                .iter()
                .all(|term| units.windows(term.len()).any(|value| value == term)))
        } else {
            Ok(self.bytes.iter().all(|term| term.find(bytes).is_some()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ranges_additions_and_cancellation_preserve_exact_membership() -> Result<()> {
        let sources = SourceSearch {
            ids: Arc::from([7, 0]),
            starts: Arc::from([0, 3, 7]),
            bytes: Arc::from(&b"abccafe"[..]),
            additions: vec![(2, b"delta".to_vec())],
            dictionary_count: 8,
        };
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            &*sources.matching("abc", &cancelled)?,
            &[2, 2, 2, 2, 2, 2, 2, 1]
        );
        assert_eq!(
            &*sources.matching("delta", &cancelled)?,
            &[2, 2, 1, 2, 2, 2, 2, 2]
        );
        assert_eq!(&*sources.matching("cc", &cancelled)?, &[2; 8]);
        assert_eq!(
            &*sources.matching("ca fe", &cancelled)?,
            &[1, 2, 2, 2, 2, 2, 2, 2]
        );
        assert_eq!(
            sources
                .matching("abc", &AtomicBool::new(true))
                .err()
                .ok_or("expected cancellation")?
                .code,
            crate::ErrorCode::Cancelled
        );
        Ok(())
    }

    #[test]
    fn matches_substrings_and_all_terms_without_changing_utf16_semantics() -> Result<()> {
        let sources = [
            "Mirava archive",
            "archive mirava",
            "Élan",
            "😀",
            "",
            "aba",
            "literal \u{f0001}",
        ];
        let queries = [
            "",
            " ",
            "mir",
            "archive mir",
            "mir mir",
            "é",
            "😀",
            "absent",
            "aba aba",
            "\u{f0001}",
        ];
        for source in sources {
            let folded = source.to_lowercase();
            for query in queries {
                let expected = query
                    .to_lowercase()
                    .split(js_space)
                    .filter(|term| !term.is_empty())
                    .all(|term| folded.contains(term));
                assert_eq!(
                    FoldedTerms::new(&Wtf8Buf::from_utf8(query).to_view())
                        .matches(folded.as_bytes())?,
                    expected,
                    "{source:?} {query:?}"
                );
            }
        }
        let emoji = Wtf8Buf::from_utf8("😀");
        for units in [&[0xd83d][..], &[0xde00], &[0xd83d, 0xde00]] {
            let query = Wtf8Buf::from_utf16(units).to_view();
            assert!(FoldedTerms::new(&query).matches(emoji.as_bytes())?);
        }
        let unrelated = Wtf8Buf::from_utf16(&[0xd800]).to_view();
        assert!(!FoldedTerms::new(&unrelated).matches(emoji.as_bytes())?);
        Ok(())
    }
}
