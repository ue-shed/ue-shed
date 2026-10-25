//! Bounded query requests. The native boundary validates requests independently of its TS client.
use crate::engine_where::{Facet, Node};
use crate::join_policy::characters;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;

pub const MAX_PAGE: usize = 50;
pub const MAX_GROUPS: usize = 200;
/// The UTF-16 length of a group key: the bound on a stored ID, so a source group's key can always
/// be opened again.
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
/// A row's facts, stored as its `signals` bits from `FACT_SHIFT` up.
pub const FACTS: [&str; 4] = [
    "unresolved",
    "conflicting",
    "evidence_only",
    "compiled_copy_differs",
];
/// The first fact's bit in a row's `signals`. The bits below it are retired.
pub const FACT_SHIFT: u32 = 3;
/// The facts a row's `signals` hold.
pub fn facts(signals: u32) -> Vec<&'static str> {
    crate::engine_query::selected_bits(&FACTS, signals >> FACT_SHIFT)
}
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
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "QueryGroupBy"))]
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
    /// The rules with a finding on the row, one group per rule; a row can be in several.
    Finding,
    /// The main asset class of a line's packages. Facets only: requests cannot group by it.
    #[serde(skip)]
    AssetType,
}

/// The most groups one request lists the rows of, and the most rows it lists for them.
pub const MAX_OPEN_GROUPS: usize = 20;
pub const MAX_OPEN_GROUP_ROWS: usize = 500;

/// The facets a query counts, each over the rows its own facet's marks don't narrow.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "QueryFacets"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Facets {
    /// The folders under this path.
    #[cfg_attr(test, ts(optional))]
    pub folder: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub assets: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    pub origins: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    pub audiences: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    pub cultures: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    pub asset_types: Option<bool>,
    /// Every rule of the findings layer, in program order, with the rows it has a finding on.
    #[cfg_attr(test, ts(optional))]
    pub findings: Option<bool>,
    /// The rows with each fact.
    #[cfg_attr(test, ts(optional))]
    pub facts: Option<bool>,
}

/// The findings layer a read shows, and the review acceptance whose findings it hides.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingsSelection {
    pub key: String,
    #[cfg_attr(test, ts(optional))]
    pub acceptance: Option<String>,
    /// Only the layer's source rules, as Browse without a target lists them.
    #[cfg_attr(test, ts(optional))]
    pub source_only: Option<bool>,
}

impl FindingsSelection {
    fn validate(&self) -> Result<()> {
        for value in std::iter::once(&self.key).chain(&self.acceptance) {
            require(
                !value.is_empty() && characters(value) <= 256,
                invalid("Invalid findings selection."),
            )?;
        }
        Ok(())
    }
}

/// Text a query searches for: each term in the row's source, or with `translations` and a
/// culture scope, in its source or an in-scope culture's translation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "QueryText"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextSearch {
    pub query: String,
    #[cfg_attr(test, ts(optional))]
    pub translations: Option<bool>,
}

/// The rows a query reads (Phase 4 §6): a target's lines, or corpus units without one.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "QuerySelection"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    /// The localization target whose lines are the rows.
    #[cfg_attr(test, ts(optional))]
    pub target: Option<String>,
    /// The culture the list shows: culture tests and problems read only it.
    #[cfg_attr(test, ts(optional))]
    pub culture: Option<String>,
    /// The list's culture scope and the cultures its tallies list; every culture when absent.
    #[cfg_attr(test, ts(optional))]
    pub cultures: Option<Vec<String>>,
    /// The findings layer the `findings` field, problems, facets and groups read.
    #[cfg_attr(test, ts(optional))]
    pub findings: Option<FindingsSelection>,
    /// The rows' test: the Browse shapes of the rule IR, with facet marks.
    #[serde(rename = "where")]
    #[cfg_attr(test, ts(optional, type = "Expr"))]
    pub filter: Option<Value>,
    #[cfg_attr(test, ts(optional))]
    pub text: Option<TextSearch>,
    /// The facets whose marks hold, as counting a facet drops them.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub dropped: Vec<Facet>,
}

/// A group's rows: the matching rows whose `by` group is `key`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupKey {
    pub by: GroupBy,
    pub key: String,
}

/// Matching rows in display order, after a cursor.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsPart {
    /// At most this many rows; over 500 makes the request bulk.
    pub limit: u32,
    /// The ID of the row the previous page ended with.
    #[cfg_attr(test, ts(optional))]
    pub after: Option<String>,
    /// Only one group's rows.
    #[cfg_attr(test, ts(optional))]
    pub group: Option<GroupKey>,
}

/// Groups to list the first rows of, in this order.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenGroupsPart {
    pub by: GroupBy,
    pub keys: Vec<String>,
    /// Rows each group lists. Past 500 rows in all, a group and every one after it list none.
    pub first_rows: u32,
}

/// The matching rows counted by group.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupsPart {
    pub by: GroupBy,
    /// Only groups holding at least this many matching rows.
    #[cfg_attr(test, ts(optional))]
    pub min_size: Option<u32>,
}

/// The parts of a query's answer; each is computed only when asked for.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryParts {
    #[cfg_attr(test, ts(optional))]
    pub rows: Option<RowsPart>,
    #[cfg_attr(test, ts(optional))]
    pub open_groups: Option<OpenGroupsPart>,
    /// `counts`, `total`, `problems`, `fileScope` and the localization tallies.
    #[cfg_attr(test, ts(optional))]
    pub counts: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    pub facets: Option<Facets>,
    #[cfg_attr(test, ts(optional))]
    pub groups: Option<GroupsPart>,
    /// Files the counts report on: how many hold matching text, lie outside the project or
    /// were not scanned.
    #[cfg_attr(test, ts(optional))]
    pub file_scope: Option<Vec<String>>,
}

/// An open group in a query's answer. Its rows are the `groupUnits` and `groupLines` batches
/// naming its position.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenGroupAnswer {
    pub key: String,
    /// The ID of its last row listed, when more follow.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub next_cursor: Option<String>,
    /// Past the row budget the group, and every one after it, lists none.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub rows_omitted: Option<bool>,
}

/// A query's part: the aggregates its parts asked for, the rows part's cursor and the open
/// groups. Rows follow as `units` and `lines` batches.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct QueryAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "JsonValue"))]
    pub counts: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "JsonValue"))]
    pub problems: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "JsonValue"))]
    pub groups: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "JsonValue"))]
    pub facets: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "JsonValue"))]
    pub file_scope: Option<Value>,
    /// The localization tallies, with a target and counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "{ readonly [key: string]: JsonValue }"))]
    pub localization: Option<Value>,
    /// The ID of the rows part's last row, when more follow.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub open_groups: Option<Vec<OpenGroupAnswer>>,
}

/// A `query` request: the rows, and the parts of the answer about them.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub selection: Selection,
    pub parts: QueryParts,
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
    /// The findings layer whose rules the focused row lists.
    pub findings: Option<FindingsSelection>,
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
    /// The list's culture scope, as `LocalizationScope` names it; its problems use only these.
    pub culture: Option<String>,
    pub cultures: Option<Vec<String>>,
    pub culture_offset: Option<usize>,
    pub location_offset: Option<usize>,
    pub po_context_offset: Option<usize>,
    /// The findings layer whose rules the line lists, in its culture scope.
    pub findings: Option<FindingsSelection>,
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
    if let Some(culture) = &request.culture {
        bounded(culture, 128, "Invalid culture scope.")?;
    }
    if let Some(cultures) = &request.cultures {
        list(cultures, 256, 128, "Invalid culture scope.")?;
    }
    if let Some(findings) = &request.findings {
        findings.validate()?;
    }
    Ok(request)
}

pub fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::InvalidInput, message)
}

/// Decode the actual JSON text before Serde, retaining every JavaScript UTF-16 code unit.
/// Serde's ordinary String decoder intentionally rejects lone surrogates.
pub fn parse_query(payload: &str) -> Result<Query> {
    #[cfg(feature = "benchmark-timings")]
    let _span = crate::benchmark_timings::Span::new("payloadDecodeValidate");
    let value = crate::json_value::parse(payload).map_err(|source| {
        Error::with_source(ErrorCode::InvalidInput, "Invalid query JSON.", source)
    })?;
    reject_nulls(&value)?;
    let request: Query = serde_json::from_value(value)
        .map_err(|source| Error::with_source(ErrorCode::InvalidInput, "Invalid query.", source))?;
    request.validate()?;
    Ok(request)
}

/// A request body read WTF-8-aware, without nulls, into its type; the caller validates it.
pub fn parse_request<T: serde::de::DeserializeOwned>(payload: &str, what: &str) -> Result<T> {
    let value = crate::json_value::parse(payload).map_err(|source| {
        Error::with_source(
            ErrorCode::InvalidInput,
            format!("Invalid {what} JSON."),
            source,
        )
    })?;
    reject_nulls(&value)?;
    serde_json::from_value(value).map_err(|source| {
        Error::with_source(
            ErrorCode::InvalidInput,
            format!("Invalid {what} request."),
            source,
        )
    })
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

impl Selection {
    /// The rows of a localization target.
    pub fn lines(target: &str) -> Self {
        Self {
            target: Some(target.to_owned()),
            ..Self::default()
        }
    }
    pub fn validate(&self) -> Result<()> {
        if let Some(target) = &self.target {
            require(
                !target.is_empty() && characters(target) <= 1024,
                invalid("A localization target is required."),
            )?;
        } else {
            require(
                self.culture.is_none() && self.cultures.is_none(),
                invalid("A culture scope needs a target."),
            )?;
        }
        if let Some(culture) = &self.culture {
            bounded(culture, 128, "Invalid culture scope.")?;
        }
        if let Some(cultures) = &self.cultures {
            list(cultures, 256, 128, "Invalid culture scope.")?;
        }
        if let Some(text) = &self.text {
            bounded(&text.query, 512, "Search text exceeds its bound.")?;
        }
        if let Some(findings) = &self.findings {
            findings.validate()?;
        }
        self.plan()?;
        Ok(())
    }
    /// The `where`, parsed, with the dropped facets' marks holding.
    pub(crate) fn plan(&self) -> Result<Option<Node>> {
        self.filter
            .as_ref()
            .map(|value| Ok(Node::parse(value, self.target.is_some())?.without(&self.dropped)))
            .transpose()
    }
    /// The selection with `facet`'s marks holding.
    pub fn without(&self, facet: Facet) -> Self {
        let mut result = self.clone();
        result.dropped.push(facet);
        result
    }
    pub fn localized(&self) -> bool {
        self.target.is_some()
    }
}

impl Query {
    pub fn validate(&self) -> Result<()> {
        self.selection.validate()?;
        let parts = &self.parts;
        let bounded_key =
            |key: &str| bounded(key, MAX_SOURCE_LENGTH, "Group key exceeds its bound.");
        if let Some(rows) = &parts.rows {
            require(
                rows.limit >= 1,
                invalid("A rows part lists at least one row."),
            )?;
            if let Some(after) = &rows.after {
                bounded(after, 32767, "Search cursor exceeds its bound.")?;
            }
            if let Some(group) = &rows.group {
                bounded_key(&group.key)?;
            }
        }
        if let Some(open) = &parts.open_groups {
            require(
                !open.keys.is_empty() && open.keys.len() <= MAX_OPEN_GROUPS,
                invalid("Open groups must name between 1 and 20 groups."),
            )?;
            for key in &open.keys {
                bounded_key(key)?;
            }
            require(
                (1..=MAX_OPEN_GROUP_ROWS as u32).contains(&open.first_rows),
                invalid("Open groups list between 1 and 500 rows each."),
            )?;
        }
        if let Some(groups) = &parts.groups {
            require(
                groups.min_size.is_none_or(|size| size >= 1),
                invalid("Minimum group size must be at least 1."),
            )?;
        }
        if let Some(files) = &parts.file_scope {
            list(files, 5000, 1024, "Invalid changed-file scope.")?;
        }
        if let Some(facets) = &parts.facets
            && let Some(folder) = &facets.folder
        {
            bounded(folder, 512, "Facet folder exceeds its bound.")?;
        }
        Ok(())
    }
    /// The rows a query's body asks to list, as the session classes it before parsing it.
    pub fn listed_rows(request: &Value) -> u64 {
        let number = |pointer: &str| {
            request
                .pointer(pointer)
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        let keys = request
            .pointer("/parts/openGroups/keys")
            .and_then(Value::as_array)
            .map_or(0, Vec::len) as u64;
        number("/parts/rows/limit").saturating_add(
            number("/parts/openGroups/firstRows")
                .saturating_mul(keys)
                .min(MAX_OPEN_GROUP_ROWS as u64),
        )
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
        if let Some(findings) = &self.findings {
            findings.validate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queries_bound_their_parts_and_reject_unknown_null_and_retired_fields() -> Result<()> {
        let request = parse_query(
            r#"{"selection":{"target":"Game","findings":{"key":"layer","acceptance":"review"}},"parts":{"rows":{"limit":5000}}}"#,
        )?;
        assert_eq!(
            request.selection.findings,
            Some(FindingsSelection {
                key: "layer".into(),
                acceptance: Some("review".into()),
                source_only: None,
            })
        );
        let long = "x".repeat(MAX_SOURCE_LENGTH as usize);
        let crowded = (0..=MAX_OPEN_GROUPS)
            .map(|n| n.to_string())
            .collect::<Vec<_>>();
        let query = |selection: serde_json::Value, parts: serde_json::Value| {
            parse_query(&json!({"selection":selection,"parts":parts}).to_string())
        };
        for (selection, parts) in [
            (json!({}), json!({"groups":{"by":"source","minSize":2}})),
            (
                json!({}),
                json!({"rows":{"limit":1,"group":{"by":"source","key":long}}}),
            ),
            (
                json!({}),
                json!({"openGroups":{"by":"finding","keys":["whitespace"],"firstRows":500}}),
            ),
            (
                json!({"target":"Game","culture":"de","cultures":["de","fr"]}),
                json!({"counts":true,"fileScope":["Content/A.uasset"]}),
            ),
            (
                json!({"text":{"query":"quit","translations":true}}),
                json!({"facets":{"folder":"/Game"}}),
            ),
        ] {
            query(selection, parts)?;
        }
        for (selection, parts) in [
            (json!({}), json!({"rows":{"limit":0}})),
            (
                json!({}),
                json!({"openGroups":{"by":"source","keys":[],"firstRows":1}}),
            ),
            (
                json!({}),
                json!({"openGroups":{"by":"source","keys":crowded,"firstRows":1}}),
            ),
            (
                json!({}),
                json!({"openGroups":{"by":"source","keys":["a"],"firstRows":501}}),
            ),
            (
                json!({}),
                json!({"openGroups":{"by":"source","keys":[long.clone() + "x"],"firstRows":1}}),
            ),
            (json!({}), json!({"groups":{"by":"source","minSize":0}})),
            (json!({}), json!({"groups":{"by":"asset_type"}})),
            (json!({}), json!({"fileScope":[]})),
            (json!({"culture":"de"}), json!({})),
            (json!({"findings":{"key":""}}), json!({})),
            (json!({"text":{"query":"x".repeat(513)}}), json!({})),
            (json!({"where":null}), json!({})),
            (json!({"lens":"long"}), json!({})),
            (json!({}), json!({"pageSize":50})),
        ] {
            assert_eq!(
                query(selection.clone(), parts.clone())
                    .err()
                    .ok_or(format!("{selection} {parts}"))?
                    .code,
                ErrorCode::InvalidInput,
                "{selection} {parts}"
            );
        }
        assert_eq!(
            Query::listed_rows(
                &json!({"parts":{"rows":{"limit":400},"openGroups":{"keys":["a","b","c"],"firstRows":200}}})
            ),
            900
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
}
