//! Prepared native substring searches over unique folded strings, sources or translations,
//! including overlay additions. A persisted trigram index narrows terms of three or more bytes.
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::join_policy::{js_space, trim};
use crate::text_trigrams::{Trigrams, intersect};
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use memchr::memmem::Finder;
use std::sync::{Arc, atomic::AtomicBool};

pub(crate) struct TextArena {
    ids: Arc<[u32]>,
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
    trigrams: Option<Trigrams>,
    additions: Vec<(u32, Vec<u8>)>,
    dictionary_count: usize,
}

impl TextArena {
    /// The arena persisted under `prefix`, and the strings `references` names that it lacks: a
    /// retained arena may predate an incremental edit, so text added since is scanned.
    pub fn open(
        query: &EngineQuery,
        prefix: &str,
        references: impl Iterator<Item = u32>,
        cancelled: &AtomicBool,
    ) -> Result<Self> {
        let dictionary_count = query.reader.dictionary_count()?;
        let mut seen = vec![false; dictionary_count];
        let (ids, starts, bytes) = if query.reader.has_column(&format!("{prefix}.folded")) {
            let ids = query.reader.column(&format!("{prefix}.ids"))?;
            let starts = query.reader.column(&format!("{prefix}.starts"))?;
            let bytes = query.reader.bytes(&format!("{prefix}.folded"))?;
            require(
                starts.len() == ids.len() + 1
                    && starts.first() == Some(&0)
                    && starts
                        .last()
                        .is_some_and(|last| *last as usize <= bytes.len())
                    && starts.windows(2).all(|pair| pair[0] <= pair[1]),
                "Invalid persisted search ranges.",
            )?;
            for (row, id) in ids.iter().enumerate() {
                if row & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let slot = seen
                    .get_mut(*id as usize)
                    .ok_or("Search ID outside dictionary.")?;
                require(!*slot, "Duplicate search ID.")?;
                *slot = true;
            }
            (ids, starts, bytes)
        } else {
            (Arc::from([]), Arc::from([0u32]), Arc::from([]))
        };
        let trigrams = if query.reader.has_column(&format!("{prefix}.tri.keys")) {
            Some(Trigrams::new(
                query.reader.column(&format!("{prefix}.tri.keys"))?,
                query.reader.column(&format!("{prefix}.tri.offsets"))?,
                query.reader.bytes(&format!("{prefix}.tri.postings"))?,
            )?)
        } else {
            None
        };
        // Walk references once per reader; only strings absent from the arena need decoding.
        let mut additions = Vec::new();
        for (row, id) in references.enumerate() {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let slot = seen
                .get_mut(id as usize)
                .ok_or("Search ID outside dictionary.")?;
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
            trigrams,
            additions,
            dictionary_count,
        })
    }

    /// Each dictionary string's match: 1 when it holds every term, otherwise 2.
    pub fn matching(&self, query: &str, cancelled: &AtomicBool) -> Result<Arc<[u8]>> {
        let terms = FoldedTerms::new(query);
        let mut matches = vec![2; self.dictionary_count];
        let candidates = match &self.trigrams {
            Some(index) => terms.candidates(index, cancelled)?,
            None => None,
        };
        let rows = candidates.unwrap_or_else(|| (0..self.ids.len() as u32).collect());
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            let bytes = self
                .bytes
                .get(self.starts[row] as usize..self.starts[row + 1] as usize)
                .ok_or("Search range outside its bytes.")?;
            matches[self.ids[row] as usize] = if terms.matches(bytes)? { 1 } else { 2 };
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

    /// The arena positions that can hold every term: the intersection of the index's candidates
    /// for each term of three or more bytes. `None` scans: no such term, or a lone surrogate,
    /// which can match inside a supplementary scalar's bytes.
    fn candidates(&self, index: &Trigrams, cancelled: &AtomicBool) -> Result<Option<Vec<u32>>> {
        if self.units.is_some() {
            return Ok(None);
        }
        let mut result: Option<Vec<u32>> = None;
        for term in &self.bytes {
            if let Some(found) = index.candidates(term.needle(), cancelled)? {
                result = Some(match result {
                    Some(previous) => intersect(previous, &found),
                    None => found,
                });
            }
        }
        Ok(result)
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
        let sources = TextArena {
            ids: Arc::from([7, 0]),
            starts: Arc::from([0, 3, 7]),
            bytes: Arc::from(&b"abccafe"[..]),
            trigrams: None,
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
    fn the_trigram_index_narrows_without_changing_any_match() -> Result<()> {
        let texts = [
            "Mirava archive",
            "archive mirava",
            "Élan",
            "😀",
            "",
            "aba",
            "literal \u{f0001}",
            "\u{4f60}\u{597d}\u{4e16}\u{754c}",
            "ΟΔΟΣ ΣΟΦΙΑΣ",
        ];
        let mut bytes = Vec::new();
        let mut starts = vec![0];
        for text in texts {
            bytes.extend_from_slice(text.to_lowercase().as_bytes());
            starts.push(bytes.len() as u32);
        }
        let (keys, offsets, postings) = crate::text_trigrams::build(&starts, &bytes)?;
        let arena = |trigrams| TextArena {
            ids: (0..texts.len() as u32).collect(),
            starts: starts.clone().into(),
            bytes: bytes.clone().into(),
            trigrams,
            additions: vec![(9, "addition".as_bytes().to_vec())],
            dictionary_count: texts.len() + 1,
        };
        let indexed = arena(Some(Trigrams::new(
            keys.into(),
            offsets.into(),
            postings.into(),
        )?));
        let scanned = arena(None);
        let cancelled = AtomicBool::new(false);
        for query in [
            "",
            "mir",
            "archive mir",
            "élan",
            "😀",
            "\u{4f60}\u{597d}",
            "\u{597d}\u{4e16}",
            "\u{597d}",
            "οδος",
            "σοφιας",
            "ab",
            "aba aba",
            "\u{f0001}",
            "absent",
            "add",
        ] {
            let query = Wtf8Buf::from_utf8(query).to_view();
            assert_eq!(
                indexed.matching(&query, &cancelled)?,
                scanned.matching(&query, &cancelled)?,
                "{query:?}"
            );
        }
        Ok(())
    }

    /// Translation search tests each term against each string, where it once tested the strings
    /// joined by spaces. Terms hold no space, and lowercasing the joined string lowercases each
    /// part as it would alone, Greek final sigma included.
    #[test]
    fn a_joined_string_holds_a_term_exactly_when_one_of_its_parts_does() {
        let parts = ["ΟΔΟΣ", "ΣΟΦΙΑ", "Straße", "İstanbul", "A'Σ", "Σ"];
        let terms = [
            "οδος",
            "οδοσ",
            "σοφια",
            "ςσ",
            "ς",
            "σ",
            "strasse",
            "straße",
            "i̇stanbul",
            "istanbul",
            "'σ",
            "'ς",
            "a'",
        ];
        for left in parts {
            for right in parts {
                let joined = format!("{left} {right}").to_lowercase();
                let separate = [left.to_lowercase(), right.to_lowercase()];
                for term in terms {
                    assert_eq!(
                        joined.contains(term),
                        separate.iter().any(|part| part.contains(term)),
                        "{left} {right} {term}"
                    );
                }
            }
        }
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
