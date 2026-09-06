//! Page-local string sharing for protocol v1.3; Catalog and public query models stay independent.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{ProjectIndexItem, ProjectIndexPage};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ProjectIndexDictionaryItem {
    #[serde(rename = "map")]
    Map {
        #[serde(rename = "mapPath")]
        map_path: String,
        #[serde(rename = "packageName")]
        package_name: String,
    },
    #[serde(rename = "header")]
    Header {
        classes: Vec<u32>,
        #[serde(rename = "packageName")]
        package_name: String,
        #[serde(rename = "packagePath")]
        package_path: String,
        #[serde(rename = "serializedNames")]
        serialized_names: Vec<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProjectIndexDictionaryPage {
    pub generation: u64,
    pub items: Vec<ProjectIndexDictionaryItem>,
    #[serde(
        default,
        rename = "nextCursor",
        skip_serializing_if = "Option::is_none"
    )]
    pub next_cursor: Option<String>,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub strings: Vec<String>,
}

impl From<ProjectIndexPage> for ProjectIndexDictionaryPage {
    fn from(page: ProjectIndexPage) -> Self {
        let mut strings = Vec::new();
        let mut ids = HashMap::new();
        let mut intern = |values: Vec<String>| {
            values
                .into_iter()
                .map(|value| {
                    *ids.entry(value).or_insert_with_key(|value| {
                        let id = u32::try_from(strings.len()).expect("bounded Project Index page");
                        strings.push(value.clone());
                        id
                    })
                })
                .collect()
        };
        let items = page
            .items
            .into_iter()
            .map(|item| match item {
                ProjectIndexItem::Map {
                    map_path,
                    package_name,
                } => ProjectIndexDictionaryItem::Map {
                    map_path,
                    package_name,
                },
                ProjectIndexItem::Header {
                    classes,
                    package_name,
                    package_path,
                    serialized_names,
                } => ProjectIndexDictionaryItem::Header {
                    classes: intern(classes),
                    package_name,
                    package_path,
                    serialized_names: intern(serialized_names),
                },
            })
            .collect();
        Self {
            generation: page.generation,
            items,
            next_cursor: page.next_cursor,
            project_id: page.project_id,
            strings,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Event, decode_event, decode_request};
    use crate::protocol_result::ResultFrame;

    #[test]
    fn dictionary_matches_shared_plain_fixture_and_rejects_invalid_references() {
        let plain = include_bytes!(
            "../../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-page-result-event.json"
        );
        let compact = include_bytes!(
            "../../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-dictionary-page-result-event.json"
        );
        let Event::Result { result, .. } = decode_event(plain).unwrap() else {
            panic!("plain page");
        };
        let ResultFrame::ProjectIndexPage { page } = *result else {
            panic!("plain payload");
        };
        let Event::Result { result, .. } = decode_event(compact).unwrap() else {
            panic!("dictionary page");
        };
        let ResultFrame::ProjectIndexDictionaryPage { page: expected } = *result else {
            panic!("dictionary payload");
        };
        assert_eq!(ProjectIndexDictionaryPage::from(page), expected);
        decode_request(include_bytes!("../../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-dictionary-query-request.json")).unwrap();
        assert!(decode_event(include_bytes!("../../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/project-index-dictionary-page-negative-index.json")).is_err());
        let mut event: serde_json::Value = serde_json::from_slice(compact).unwrap();
        event["result"]["page"]["strings"] = serde_json::json!([]);
        assert!(decode_event(&serde_json::to_vec(&event).unwrap()).is_err());
    }

    #[test]
    fn dictionary_preserves_order_duplicates_and_unicode_across_fields() {
        let page = ProjectIndexPage {
            generation: 2,
            project_id: "fixture".into(),
            next_cursor: Some("next".into()),
            items: (0..1024)
                .map(|i| ProjectIndexItem::Header {
                    package_name: format!("/Game/A{i}"),
                    package_path: format!("Content/A{i}.uasset"),
                    classes: vec!["名前".into(), "Café".into(), "名前".into()],
                    serialized_names: vec!["Café".into(), format!("Unique{i}")],
                })
                .collect(),
        };
        let compact = ProjectIndexDictionaryPage::from(page.clone());
        assert_eq!(compact.strings.len(), 1026);
        assert_eq!(compact.next_cursor, page.next_cursor);
        for (original, item) in page.items.iter().zip(&compact.items) {
            let ProjectIndexItem::Header {
                classes,
                serialized_names,
                package_name,
                package_path,
            } = original
            else {
                panic!("header");
            };
            let ProjectIndexDictionaryItem::Header {
                classes: c,
                serialized_names: n,
                package_name: name,
                package_path: path,
            } = item
            else {
                panic!("header");
            };
            assert_eq!(
                classes,
                &c.iter()
                    .map(|id| compact.strings[*id as usize].clone())
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                serialized_names,
                &n.iter()
                    .map(|id| compact.strings[*id as usize].clone())
                    .collect::<Vec<_>>()
            );
            assert_eq!((package_name, package_path), (name, path));
        }
    }
}
