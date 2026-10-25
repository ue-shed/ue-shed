use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result};
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale::Locale;
use icu_provider::{DataIdentifierBorrowed, DataProvider, DataRequest};
use std::cmp::Ordering;

pub struct HostCollator {
    inner: CollatorBorrowed<'static>,
    pub locale: String,
}

impl HostCollator {
    pub fn new(locale: &str) -> Result<Self> {
        let requested = locale.parse::<Locale>().ok().filter(|parsed| {
            let data_locale = parsed.id.clone().into();
            let response = <icu_collator::provider::Baked as DataProvider<
                icu_collator::provider::CollationMetadataV1,
            >>::load(
                &icu_collator::provider::Baked,
                DataRequest {
                    id: DataIdentifierBorrowed::for_locale(&data_locale),
                    ..Default::default()
                },
            );
            response.is_ok_and(|response| {
                !response
                    .metadata
                    .locale
                    .is_some_and(|used| used.is_unknown())
            })
        });
        let (inner, locale) = match requested {
            Some(parsed) => match Collator::try_new(parsed.into(), Default::default()) {
                Ok(collator) => (collator, locale.to_owned()),
                Err(_) => (
                    Collator::try_new(Default::default(), Default::default())
                        .map_err(|cause| Error::new(ErrorCode::Unavailable, cause.to_string()))?,
                    "und".to_owned(),
                ),
            },
            None => (
                Collator::try_new(Default::default(), Default::default())
                    .map_err(|cause| Error::new(ErrorCode::Unavailable, cause.to_string()))?,
                "und".to_owned(),
            ),
        };
        Ok(Self { inner, locale })
    }

    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        // A view without the escape lead byte is plain UTF-8, which collates exactly as its UTF-16
        // does, without converting either.
        if !a.as_bytes().contains(&0xf3) && !b.as_bytes().contains(&0xf3) {
            return self.inner.compare(a, b);
        }
        self.inner.compare_utf16(
            &Wtf8Buf::from_view(a).to_utf16(),
            &Wtf8Buf::from_view(b).to_utf16(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::require;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    fn reports_root_for_unsupported_locales() -> Result<()> {
        assert_eq!(HostCollator::new("zz-ZZ")?.locale, "und");
        assert_eq!(HostCollator::new("not a locale")?.locale, "und");
        assert_eq!(HostCollator::new("sv")?.locale, "sv");
        Ok(())
    }

    #[test]
    fn host_collation_matches_node_en_and_sv() -> Result<()> {
        let values = [
            "a", "A", "á", "ä", "å", "z", "Z", "ö", "é", "e\u{301}", "_", "-", ".", " ", "!", "中",
            "日", "😀", "𐀀", "", "a-b", "a_b", "a.b", "10", "2",
        ];
        for locale in ["en", "sv"] {
            let mut child = Command::new("node")
                .args(["-e", "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{const {values,locale}=JSON.parse(s);process.stdout.write(JSON.stringify(values.flatMap(a=>values.map(b=>Math.sign(a.localeCompare(b,locale))))));});"])
                .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
            child.stdin.take().ok_or("Missing Node stdin.")?.write_all(
                serde_json::to_string(&serde_json::json!({"values": values, "locale": locale}))?
                    .as_bytes(),
            )?;
            let output = child.wait_with_output()?;
            require(output.status.success(), "Node collation pin failed.")?;
            let expected: Vec<i32> = serde_json::from_slice(&output.stdout)?;
            let collator = HostCollator::new(locale)?;
            for (index, (a, b)) in values
                .iter()
                .flat_map(|a| values.iter().map(move |b| (a, b)))
                .enumerate()
            {
                assert_eq!(
                    collator.compare(a, b) as i32,
                    expected[index],
                    "{locale}: {a:?}, {b:?}"
                );
            }
        }
        Ok(())
    }
}
