//! Bounded query requests. The native boundary validates requests independently of its TS client.
use crate::join_policy::characters;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};

pub const MAX_PAGE: usize = 50;
pub const MAX_GROUPS: usize = 200;
/// Values in one `source` clause, and the UTF-16 length of each: the bound on a stored ID, so a
/// source group's key can always be opened again.
pub const MAX_SOURCE_VALUES: usize = 50;
pub const MAX_SOURCE_LENGTH: u32 = 32767;
pub const STATES: [&str; 10] = [
    "translated",
    "not_translated",
    "needs_update",
    "not_synced",
    "not_gathered",
    "changed_since_gather",
    "not_found",
    "gathered_only",
    "outside_target",
    "unknown",
];
pub const REASONS: [&str; 18] = [
    "missing_manifest",
    "missing_archive",
    "missing_po",
    "duplicate_manifest_identity",
    "duplicate_archive_identity",
    "duplicate_po_identity",
    "package_partial",
    "package_failed",
    "package_not_scanned",
    "unresolved_identity",
    "string_table_namespace_unavailable",
    "conflicting_source",
    "gather_settings_unavailable",
    "class_hierarchy_unavailable",
    "asset_class_unavailable",
    "path_not_project_relative",
    "ambiguous_po_identity",
    "string_table_entry_missing",
];
pub const SIGNALS: [&str; 7] = [
    "shared",
    "duplicate_source",
    "long",
    "unresolved",
    "conflicting",
    "evidence_only",
    "compiled_copy_differs",
];
pub(crate) use crate::text_problem::PROBLEMS;
pub const ORIGINS: [&str; 5] = ["string_table", "data_table", "asset", "cpp", "other_source"];
pub const AUDIENCES: [&str; 3] = ["player", "editor", "unknown"];
pub const REVIEWS: [&str; 5] = [
    "reviewed",
    "not_reviewed",
    "not_proofread",
    "changed_since_review",
    "machine_translated",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    All,
    SourceEditable,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    Problem,
    Folder,
    Asset,
    Origin,
    Namespace,
    Audience,
    /// Exact source text: a line's source, or a unit's first source in UTF-16 order.
    Source,
    /// The main asset class of a line's packages. Facets only: requests cannot group by it.
    #[serde(skip)]
    AssetType,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterField {
    Problem,
    Finding,
    Translation,
    Origin,
    Folder,
    Asset,
    Namespace,
    Editing,
    Notes,
    Audience,
    /// A line's gathered namespace and key, written as the JSON array `[namespace, key]`.
    TranslationKey,
    /// Exact source text, compared as stored: case-sensitive, untrimmed, UTF-16 exact.
    Source,
    /// The main asset class of the packages holding a line's saved places.
    AssetType,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Is,
    IsNot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Clause {
    pub field: FilterField,
    pub op: FilterOp,
    pub values: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocationScope {
    pub kinds: Option<Vec<String>>,
    pub path_prefix: Option<String>,
    pub files: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalizationScope {
    pub target: String,
    pub culture: Option<String>,
    pub cultures: Option<Vec<String>>,
    pub state: Option<String>,
    pub review: Option<String>,
    pub key_changed: Option<bool>,
    pub search_translations: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Facets {
    pub folder: Option<String>,
    pub assets: Option<bool>,
    pub origins: Option<bool>,
    pub audiences: Option<bool>,
    pub cultures: Option<bool>,
    pub asset_types: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    pub query: String,
    pub capability: Capability,
    pub page_size: usize,
    pub cursor: Option<String>,
    pub localization: Option<LocalizationScope>,
    pub localization_cursor: Option<String>,
    pub without_notes: Option<bool>,
    pub lens: Option<String>,
    #[serde(rename = "where")]
    pub location: Option<LocationScope>,
    pub filter: Option<Vec<Clause>>,
    pub lines: Option<Vec<String>>,
    pub group: Option<GroupBy>,
    /// Only groups holding at least this many matching rows; requires `group`.
    pub min_group_size: Option<usize>,
    pub open_group: Option<String>,
    pub facets: Option<Facets>,
    /// Set on a request derived from another (a facet or count base without a clause or the
    /// lens): the findings the original request counts. Never read from callers; part of the
    /// cache key when set.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub counted: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FocusSelection {
    pub target: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusRequest {
    pub id: String,
    pub page_size: usize,
    pub occurrence_cursor: Option<String>,
    pub localization: Option<FocusSelection>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DetailSelection {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalizationDetailRequest {
    pub target: String,
    pub selection: DetailSelection,
    pub culture_offset: Option<usize>,
    pub location_offset: Option<usize>,
    pub po_context_offset: Option<usize>,
}

pub fn parse_detail_request(payload: &str) -> Result<LocalizationDetailRequest> {
    let value = crate::json_value::parse(payload).map_err(|source| {
        Error::with_source(
            ErrorCode::InvalidInput,
            "Invalid localization detail JSON.",
            source,
        )
    })?;
    reject_nulls(&value)?;
    let request: LocalizationDetailRequest = serde_json::from_value(value).map_err(|source| {
        Error::with_source(
            ErrorCode::InvalidInput,
            "Invalid localization detail request.",
            source,
        )
    })?;
    require(
        matches!(request.selection.kind.as_str(), "line" | "unit"),
        invalid("Invalid localization selection kind."),
    )?;
    for value in [&request.target, &request.selection.id] {
        require(
            !value.is_empty() && characters(value) <= 32767,
            invalid("Invalid localization selection identity."),
        )?;
    }
    Ok(request)
}

pub fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::InvalidInput, message)
}

/// A `translation_key` clause value: the JSON array `[namespace, key]` of a gathered identity,
/// with a nonempty key. Unreal translates text by this identity, without a package marker.
pub fn translation_key(value: &str) -> Result<(String, String)> {
    let malformed = || invalid("A translation key must be a JSON [namespace, key] with a key.");
    let parsed = crate::json_value::parse_stored(value).map_err(|_| malformed())?;
    match parsed.as_array().map(Vec::as_slice) {
        Some(
            [
                serde_json::Value::String(namespace),
                serde_json::Value::String(key),
            ],
        ) if !key.is_empty() => Ok((namespace.clone(), key.clone())),
        _ => Err(malformed()),
    }
}

/// Decode the actual JSON text before Serde, retaining every JavaScript UTF-16 code unit.
/// Serde's ordinary String decoder intentionally rejects lone surrogates.
pub fn parse_search_request(payload: &str) -> Result<SearchRequest> {
    let value = crate::json_value::parse(payload).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid search JSON.", source)
    })?;
    reject_nulls(&value)?;
    let request: SearchRequest = serde_json::from_value(value).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid search request.", source)
    })?;
    request.validate()?;
    Ok(request)
}

fn reject_nulls(value: &serde_json::Value) -> Result<()> {
    match value {
        serde_json::Value::Null => Err(invalid(
            "Omit optional request fields rather than supplying null.",
        )),
        serde_json::Value::Array(values) => {
            for value in values {
                reject_nulls(value)?;
            }
            Ok(())
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                reject_nulls(value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn bounded(value: &str, max: u32, message: &str) -> Result<()> {
    require(characters(value) <= max, invalid(message))
}

fn list(values: &[String], max: usize, length: u32, message: &str) -> Result<()> {
    require(!values.is_empty() && values.len() <= max, invalid(message))?;
    for value in values {
        bounded(value, length, message)?;
    }
    Ok(())
}

impl SearchRequest {
    pub fn validate(&self) -> Result<()> {
        require(
            (1..=MAX_PAGE).contains(&self.page_size),
            invalid("Query page size must be between 1 and 50."),
        )?;
        bounded(&self.query, 512, "Search text exceeds its bound.")?;
        for cursor in [&self.cursor, &self.localization_cursor]
            .into_iter()
            .flatten()
        {
            bounded(cursor, 32767, "Search cursor exceeds its bound.")?;
        }
        if let Some(lens) = &self.lens {
            require(
                lens == "all" || SIGNALS[..5].contains(&lens.as_str()),
                invalid("Unknown search lens."),
            )?;
        }
        if let Some(location) = &self.location {
            if let Some(kinds) = &location.kinds {
                list(kinds, 5, 32, "Invalid origin scope.")?;
                require(
                    kinds.iter().all(|v| ORIGINS.contains(&v.as_str())),
                    invalid("Unknown origin scope."),
                )?;
            }
            if let Some(path) = &location.path_prefix {
                require(!path.is_empty(), invalid("Path prefix must not be empty."))?;
                bounded(path, 512, "Path prefix exceeds its bound.")?;
            }
            if let Some(files) = &location.files {
                list(files, 5000, 1024, "Invalid changed-file scope.")?;
            }
        }
        if let Some(filters) = &self.filter {
            require(filters.len() <= 32, invalid("Too many filter clauses."))?;
            for clause in filters {
                let (allowed, max, length): (&[&str], usize, u32) = match clause.field {
                    FilterField::Problem => (&PROBLEMS, PROBLEMS.len(), 64),
                    FilterField::Finding => (&SIGNALS, SIGNALS.len(), 64),
                    FilterField::Translation => (&["missing", "to_update", "not_synced"], 3, 64),
                    FilterField::Origin => (&ORIGINS, 5, 64),
                    FilterField::Editing => (&["editable", "read_only"], 2, 64),
                    FilterField::Notes => (&["missing", "present"], 2, 64),
                    FilterField::Audience => (&AUDIENCES, 3, 64),
                    FilterField::Folder => (&[], 50, 512),
                    FilterField::Asset => (&[], 200, 1024),
                    FilterField::Namespace => (&[], 50, 1024),
                    FilterField::TranslationKey => (&[], 200, 4096),
                    FilterField::Source => (&[], MAX_SOURCE_VALUES, MAX_SOURCE_LENGTH),
                    FilterField::AssetType => (&[], 50, 1024),
                };
                list(&clause.values, max, length, "Invalid filter clause bounds.")?;
                require(
                    allowed.is_empty()
                        || clause.values.iter().all(|v| allowed.contains(&v.as_str())),
                    invalid("Unknown filter clause value."),
                )?;
                require(
                    matches!(clause.field, FilterField::Namespace)
                        || clause.values.iter().all(|v| !v.is_empty()),
                    invalid("Filter value must not be empty."),
                )?;
                if clause.field == FilterField::TranslationKey {
                    for value in &clause.values {
                        translation_key(value)?;
                    }
                }
            }
        }
        if let Some(lines) = &self.lines {
            list(lines, 5000, 32767, "Invalid line selection.")?;
        }
        if let Some(group) = &self.open_group {
            bounded(group, MAX_SOURCE_LENGTH, "Group key exceeds its bound.")?;
        }
        if let Some(size) = self.min_group_size {
            require(
                self.group.is_some(),
                invalid("A minimum group size needs a group."),
            )?;
            require(
                (1..=u32::MAX as usize).contains(&size),
                invalid("Minimum group size must be at least 1."),
            )?;
        }
        if let Some(facets) = &self.facets
            && let Some(folder) = &facets.folder
        {
            bounded(folder, 512, "Facet folder exceeds its bound.")?;
        }
        if let Some(scope) = &self.localization {
            require(
                !scope.target.is_empty(),
                invalid("A localization target is required."),
            )?;
            if let Some(cultures) = &scope.cultures {
                list(cultures, 256, 128, "Invalid culture scope.")?;
            }
            if let Some(state) = &scope.state {
                require(
                    STATES.contains(&state.as_str()),
                    invalid("Unknown localization state."),
                )?;
            }
            if let Some(review) = &scope.review {
                require(
                    REVIEWS.contains(&review.as_str()),
                    invalid("Unknown review lens."),
                )?;
            }
        }
        Ok(())
    }

    /// The request without its `field` clauses. Findings it counts stay those of `self`.
    pub fn without_filter(&self, field: FilterField) -> Self {
        let mut result = self.clone();
        result.counted = Some(self.counted_findings());
        result.filter = self.filter.as_ref().map(|clauses| {
            clauses
                .iter()
                .filter(|clause| clause.field != field)
                .cloned()
                .collect()
        });
        result
    }

    pub(crate) fn without_page(&self) -> Self {
        let mut result = self.clone();
        result.page_size = 1;
        result.cursor = None;
        result.localization_cursor = None;
        result.open_group = None;
        result
    }

    /// The review signals that make a row a finding under this request: the defaults, and the
    /// findings its `finding is` clauses and lens name. Every problem in the request uses them.
    pub(crate) fn counted_findings(&self) -> u32 {
        if let Some(counted) = self.counted {
            return counted;
        }
        let clauses = self
            .filter
            .iter()
            .flatten()
            .filter(|clause| clause.field == FilterField::Finding && clause.op == FilterOp::Is);
        crate::text_problem::counted_findings(
            clauses
                .flat_map(|clause| clause.values.iter().map(String::as_str))
                .chain(self.lens.as_deref()),
        )
    }

    pub(crate) fn matching_key(&self) -> Result<String> {
        let mut result = self.without_page();
        result.group = None;
        result.min_group_size = None;
        result.facets = None;
        Ok(serde_json::to_string(&result)?)
    }
}

pub fn parse_focus_request(payload: &str) -> Result<FocusRequest> {
    let value = crate::json_value::parse(payload).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid focus JSON.", source)
    })?;
    reject_nulls(&value)?;
    let request: FocusRequest = serde_json::from_value(value).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid focus request.", source)
    })?;
    request.validate()?;
    Ok(request)
}

impl FocusRequest {
    pub fn validate(&self) -> Result<()> {
        require(
            (1..=MAX_PAGE).contains(&self.page_size),
            invalid("Focus page size must be between 1 and 50."),
        )?;
        bounded(&self.id, 32767, "Focus ID exceeds its bound.")?;
        if let Some(cursor) = &self.occurrence_cursor {
            bounded(cursor, 32767, "Occurrence cursor exceeds its bound.")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wtf8::Wtf8Buf;
    use serde_json::json;

    #[test]
    fn cache_keys_ignore_pagination_but_preserve_scope_and_response_shape() -> Result<()> {
        let request = parse_search_request(
            r#"{"query":"source","capability":"all","pageSize":1,"localization":{"target":"Game","cultures":["de"]}}"#,
        )?;
        let key = request.matching_key()?;
        let mut page = request.clone();
        page.page_size = 50;
        page.localization_cursor = Some("next-line".into());
        page.group = Some(GroupBy::Asset);
        page.open_group = Some("Content/Example.uasset".into());
        page.facets = Some(Facets {
            assets: Some(true),
            ..Default::default()
        });
        assert_eq!(key, page.matching_key()?);
        assert_ne!(
            serde_json::to_string(&request.without_page())?,
            serde_json::to_string(&page.without_page())?
        );
        let mut scope = request.clone();
        scope
            .localization
            .as_mut()
            .ok_or("Test localization scope")?
            .cultures = Some(vec!["en".into()]);
        assert_ne!(key, scope.matching_key()?);
        scope = request.clone();
        scope.query = "different".into();
        assert_ne!(key, scope.matching_key()?);
        scope = request.clone();
        scope.without_notes = Some(true);
        assert_ne!(key, scope.matching_key()?);
        // A relaxed base keeps the original's findings and so its own cache key; callers
        // cannot set them.
        scope = request.clone();
        scope.counted = Some(scope.counted_findings() | 4);
        assert_ne!(key, scope.matching_key()?);
        assert!(
            parse_search_request(r#"{"query":"","capability":"all","pageSize":1,"counted":4}"#)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn detail_requests_reject_unknown_null_negative_and_invalid_selection_fields() -> Result<()> {
        let valid =
            r#"{"target":"Game","selection":{"kind":"line","id":"line:K"},"locationOffset":10000}"#;
        assert_eq!(parse_detail_request(valid)?.location_offset, Some(10000));
        for payload in [
            r#"{"target":"Game","selection":{"kind":"sql","id":"K"}}"#,
            r#"{"target":"Game","selection":{"kind":"unit","id":""}}"#,
            r#"{"target":"Game","selection":{"kind":"unit","id":"K"},"cultureOffset":-1}"#,
            r#"{"target":"Game","selection":{"kind":"line","id":"K"},"poContextOffset":null}"#,
            r#"{"target":"Game","selection":{"kind":"line","id":"K"},"all":true}"#,
        ] {
            assert_eq!(
                parse_detail_request(payload)
                    .err()
                    .ok_or("Expected invalid detail")?
                    .code,
                ErrorCode::InvalidInput
            );
        }
        Ok(())
    }

    #[test]
    fn rejects_unknown_fields_and_unbounded_or_unknown_clauses() -> Result<()> {
        let request = json!({"query":"", "capability":"all", "pageSize":50});
        serde_json::from_value::<SearchRequest>(request.clone())?.validate()?;
        for patch in [
            json!({"pageSize":51}),
            json!({"filter":[{"field":"translation","op":"is","values":["invented"]}]}),
            json!({"where":{"files":[]}}),
        ] {
            let mut invalid = request.clone();
            for (key, value) in patch.as_object().ok_or("object")? {
                invalid[key] = value.clone();
            }
            assert_eq!(
                serde_json::from_value::<SearchRequest>(invalid)?
                    .validate()
                    .err()
                    .ok_or("expected invalid")?
                    .code,
                ErrorCode::InvalidInput
            );
        }
        let mut unknown = request;
        unknown["sql"] = json!("not an engine operation");
        assert!(serde_json::from_value::<SearchRequest>(unknown).is_err());
        Ok(())
    }

    #[test]
    fn source_clauses_signals_and_minimum_group_sizes_are_bounded() -> Result<()> {
        let base = json!({"query":"", "capability":"all", "pageSize":50});
        let with = |patch: serde_json::Value| -> Result<SearchRequest> {
            let mut request = base.clone();
            for (key, value) in patch.as_object().ok_or("object")? {
                request[key] = value.clone();
            }
            parse_search_request(&request.to_string())
        };
        let long = "x".repeat(MAX_SOURCE_LENGTH as usize);
        for valid in [
            json!({"filter":[{"field":"source","op":"is","values":["Mushroom", " Mushroom ", long]}]}),
            json!({"filter":[{"field":"finding","op":"is","values":SIGNALS}]}),
            json!({"group":"source","minGroupSize":2,"openGroup":long}),
            json!({"group":"asset","minGroupSize":1}),
        ] {
            with(valid)?;
        }
        let many = (0..=MAX_SOURCE_VALUES)
            .map(|n| n.to_string())
            .collect::<Vec<_>>();
        for invalid in [
            json!({"filter":[{"field":"source","op":"is","values":[""]}]}),
            json!({"filter":[{"field":"source","op":"is","values":[]}]}),
            json!({"filter":[{"field":"source","op":"is","values":many}]}),
            json!({"filter":[{"field":"source","op":"is","values":[long.clone() + "x"]}]}),
            json!({"filter":[{"field":"finding","op":"is","values":["up_to_date"]}]}),
            json!({"minGroupSize":2}),
            json!({"group":"source","minGroupSize":0}),
            json!({"group":"source","minGroupSize":-1}),
            json!({"group":"source","openGroup":long.clone() + "x"}),
        ] {
            assert_eq!(
                with(invalid.clone())
                    .err()
                    .ok_or(format!("{invalid}"))?
                    .code,
                ErrorCode::InvalidInput,
                "{invalid}"
            );
        }
        // A minimum size changes the groups listed, never the rows that match.
        let grouped = with(json!({"group":"source","minGroupSize":3}))?;
        let plain = with(json!({}))?;
        assert_eq!(grouped.matching_key()?, plain.matching_key()?);
        assert_ne!(
            serde_json::to_string(&grouped.without_page())?,
            serde_json::to_string(&with(json!({"group":"source"}))?.without_page())?
        );
        Ok(())
    }

    #[test]
    fn translation_keys_are_namespace_key_pairs_with_a_key() -> Result<()> {
        assert_eq!(
            translation_key(r#"["","Title"]"#)?,
            ("".into(), "Title".into())
        );
        assert_eq!(
            translation_key(r#"[ "UI" , "\ud800" ]"#)?,
            ("UI".into(), Wtf8Buf::from_utf16(&[0xd800]).into_view())
        );
        for value in [
            r#"["UI",""]"#,
            r#"["UI"]"#,
            r#"["UI","K",""]"#,
            r#"{"namespace":"UI","key":"K"}"#,
            r#"["UI",7]"#,
            "UI,K",
        ] {
            assert_eq!(
                translation_key(value).err().ok_or(value)?.code,
                ErrorCode::InvalidInput
            );
        }
        Ok(())
    }
}
