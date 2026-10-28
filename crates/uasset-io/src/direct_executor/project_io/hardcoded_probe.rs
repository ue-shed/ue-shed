//! Throwaway, opt-in counts over already decoded string/name values. No values are serialized.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use serde::Serialize;
use uasset_parser::asset::DecodedAsset;
use uasset_parser::package::{Export, Package};
use uasset_parser::property::{PropertyStream, PropertyValue};

const MAX_DISTINCT: usize = 8_000_000;
const MAX_VALUE_BYTES: usize = 512 * 1024 * 1024;
const MAX_GROUPS: usize = 200_000;

pub(super) struct Probe {
    pub(super) counts: Option<Mutex<Counts>>,
    output: PathBuf,
    start: Instant,
    cpu: u64,
    private_labels: Vec<String>,
}

impl Probe {
    pub(super) fn new(project_root: &str) -> Option<Self> {
        let output = std::env::var_os("UE_SHED_HARDCODED_METRICS")?;
        let root = std::path::Path::new(project_root);
        let mut private_labels = Vec::new();
        if let Some(name) = root.file_stem().and_then(|n| n.to_str()) {
            private_labels.push(name.to_lowercase());
        }
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "uproject")
                    && let Some(name) = path.file_stem().and_then(|n| n.to_str())
                {
                    private_labels.push(name.to_lowercase());
                }
            }
        }
        Some(Self {
            counts: (std::env::var("UE_SHED_HARDCODED_PROBE").as_deref() == Ok("1"))
                .then(|| Mutex::new(Counts::default())),
            output: output.into(),
            start: Instant::now(),
            cpu: process_metrics::process_cpu_ns().unwrap_or(0),
            private_labels,
        })
    }

    pub(super) fn finish(self) -> std::io::Result<()> {
        let wall_seconds = self.start.elapsed().as_secs_f64();
        let cpu_seconds = process_metrics::process_cpu_ns()?.saturating_sub(self.cpu) as f64 / 1e9;
        let memory = process_metrics::memory()?;
        let counts = self.counts.map(|counts| {
            counts
                .into_inner()
                .unwrap_or_else(PoisonError::into_inner)
                .report(&self.private_labels)
        });
        #[derive(Serialize)]
        struct Report {
            wall_seconds: f64,
            cpu_seconds: f64,
            peak_working_set_bytes: u64,
            peak_private_bytes: Option<u64>,
            counts: Option<CountReport>,
        }
        let report = Report {
            wall_seconds,
            cpu_seconds,
            peak_working_set_bytes: memory.peak_working_set_bytes,
            peak_private_bytes: memory.peak_private_bytes,
            counts,
        };
        // Only aggregate DTOs reach serde; the interning table never implements Serialize.
        let bytes = serde_json::to_vec_pretty(&report)?;
        std::fs::write(self.output, bytes)
    }
}

#[derive(Default)]
struct Group {
    count: u64,
    distinct: HashSet<u32>,
    shapes: Vec<String>,
}

impl Group {
    fn record(&mut self, id: u32, shape: Option<&str>) {
        self.count += 1;
        let first = self.distinct.insert(id);
        if first
            && self.shapes.len() < 3
            && let Some(shape) = shape
        {
            self.shapes.push(shape.to_owned());
        }
    }
}

#[derive(Default)]
pub(super) struct Counts {
    values: HashMap<String, u32>,
    value_bytes: usize,
    total: Group,
    retained: Group,
    exclusions: BTreeMap<&'static str, Group>,
    properties: BTreeMap<String, Group>,
    classes: BTreeMap<String, Group>,
    locations: BTreeMap<&'static str, Group>,
    kinds: BTreeMap<&'static str, Group>,
    shapes: BTreeMap<&'static str, Group>,
    contains_space: Group,
    sentence: Group,
    raw_values: u64,
    unresolved_names: u64,
    decoded_exports: u64,
    cap_hit: bool,
}

#[derive(Serialize)]
struct Row {
    label: String,
    count: u64,
    distinct: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    examples_as_shapes: Vec<String>,
}

#[derive(Serialize)]
struct CountReport {
    total: Row,
    retained: Row,
    exclusions: Vec<Row>,
    properties: Vec<Row>,
    classes: Vec<Row>,
    locations: Vec<Row>,
    kinds: Vec<Row>,
    shapes: Vec<Row>,
    contains_space: Row,
    sentence: Row,
    raw_values: u64,
    unresolved_names: u64,
    decoded_exports: u64,
    cap_hit: bool,
}

fn row(label: &str, group: &Group) -> Row {
    Row {
        label: label.to_owned(),
        count: group.count,
        distinct: group.distinct.len(),
        examples_as_shapes: group.shapes.clone(),
    }
}

fn rows<K: AsRef<str> + Ord>(groups: &BTreeMap<K, Group>) -> Vec<Row> {
    let mut rows: Vec<_> = groups
        .iter()
        .map(|(label, group)| row(label.as_ref(), group))
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then(a.label.cmp(&b.label)));
    rows
}

impl Counts {
    fn report(mut self, private_labels: &[String]) -> CountReport {
        for label in [
            "empty",
            "whitespace-only",
            "None",
            "object path/soft reference",
            "file path/extension",
            "GUID/hex",
            "number",
            "dotted tag-like name",
        ] {
            self.exclusions.entry(label).or_default();
        }
        for label in [
            "plain property",
            "struct member",
            "array/map/set element",
            "DataTable cell",
            "CDO",
            "graph pin",
        ] {
            self.locations.entry(label).or_default();
        }
        let mut properties = rows(&self.properties);
        let mut classes = rows(&self.classes);
        properties.truncate(40);
        classes.truncate(20);
        for (i, row) in properties.iter_mut().chain(classes.iter_mut()).enumerate() {
            let lower = row.label.to_lowercase();
            if private_labels
                .iter()
                .any(|p| !p.is_empty() && lower.contains(p))
                || row.label.contains('/')
                || row.label.contains('\\')
            {
                row.label = format!("redacted metadata {}", i + 1);
            }
        }
        CountReport {
            total: row("all", &self.total),
            retained: row("remaining", &self.retained),
            exclusions: rows(&self.exclusions),
            properties,
            classes,
            locations: rows(&self.locations),
            kinds: rows(&self.kinds),
            shapes: rows(&self.shapes),
            contains_space: row("contains space", &self.contains_space),
            sentence: row("sentence-like", &self.sentence),
            raw_values: self.raw_values,
            unresolved_names: self.unresolved_names,
            decoded_exports: self.decoded_exports,
            cap_hit: self.cap_hit,
        }
    }

    fn record(
        &mut self,
        value: &str,
        name: &str,
        class: &str,
        location: &'static str,
        kind: &'static str,
    ) {
        let id = if let Some(id) = self.values.get(value) {
            *id
        } else {
            if self.values.len() >= MAX_DISTINCT || self.value_bytes + value.len() > MAX_VALUE_BYTES
            {
                self.cap_hit = true;
                return;
            }
            let id = self.values.len() as u32;
            self.value_bytes += value.len();
            self.values.insert(value.to_owned(), id);
            id
        };
        self.total.record(id, None);
        self.kinds.entry(kind).or_default().record(id, None);
        if let Some(reason) = exclusion(value) {
            self.exclusions.entry(reason).or_default().record(id, None);
            return;
        }
        self.retained.record(id, None);
        let words = value.split_whitespace().count();
        let has_space = value.chars().any(char::is_whitespace);
        let punctuation = value
            .chars()
            .any(|c| matches!(c, '.' | '!' | '?' | '。' | '！' | '？'));
        if value.contains(' ') {
            self.contains_space.record(id, None);
        }
        if has_space && (punctuation || words >= 4) {
            self.sentence.record(id, None);
        }
        let shape = if has_space {
            "multiple words"
        } else if value.chars().all(char::is_lowercase) {
            "lowercase"
        } else if value.chars().next().is_some_and(char::is_uppercase)
            && value.chars().skip(1).all(char::is_lowercase)
        {
            "Capitalized"
        } else if value.contains('_') || value.chars().skip(1).any(char::is_uppercase) {
            "CamelCase/snake_case identifier"
        } else {
            "other single token"
        };
        self.shapes.entry(shape).or_default().record(id, None);
        let example = format!(
            "{} chars, {} words{}",
            value.chars().count(),
            words,
            if punctuation {
                ", sentence punctuation"
            } else {
                ""
            }
        );
        if self.properties.len() >= MAX_GROUPS && !self.properties.contains_key(name)
            || self.classes.len() >= MAX_GROUPS && !self.classes.contains_key(class)
        {
            self.cap_hit = true;
            return;
        }
        self.properties
            .entry(name.to_owned())
            .or_default()
            .record(id, Some(&example));
        self.classes
            .entry(class.to_owned())
            .or_default()
            .record(id, None);
        self.locations.entry(location).or_default().record(id, None);
    }

    fn stream(
        &mut self,
        package: &Package,
        stream: &PropertyStream,
        class: &str,
        location: &'static str,
    ) {
        for property in &stream.records {
            let name = package
                .resolve_name(property.name)
                .unwrap_or_else(|| "unresolved property".to_owned());
            self.value(package, &property.value, &name, class, location);
        }
    }

    fn value(
        &mut self,
        package: &Package,
        value: &PropertyValue,
        name: &str,
        class: &str,
        location: &'static str,
    ) {
        let nested = |kind| match location {
            "DataTable cell" | "CDO" | "graph pin" => location,
            _ => kind,
        };
        match value {
            PropertyValue::String(value) => self.record(value, name, class, location, "FString"),
            PropertyValue::Name(value) => {
                if let Some(value) = package.resolve_name(*value) {
                    self.record(&value, name, class, location, "FName");
                } else {
                    self.unresolved_names += 1;
                }
            }
            PropertyValue::Array(values) | PropertyValue::Set(values) => {
                for value in values {
                    self.value(package, value, name, class, nested("array/map/set element"));
                }
            }
            PropertyValue::Map(entries) => {
                for entry in entries {
                    self.value(
                        package,
                        &entry.key,
                        name,
                        class,
                        nested("array/map/set element"),
                    );
                    self.value(
                        package,
                        &entry.value,
                        name,
                        class,
                        nested("array/map/set element"),
                    );
                }
            }
            PropertyValue::Struct(stream) => {
                self.stream(package, stream, class, nested("struct member"))
            }
            PropertyValue::NativeStruct { fields } => {
                for field in fields {
                    self.value(
                        package,
                        &field.value,
                        &field.name,
                        class,
                        nested("struct member"),
                    );
                }
            }
            PropertyValue::InstancedStruct {
                value: Some(value), ..
            } => {
                self.value(package, value, name, class, nested("struct member"));
            }
            PropertyValue::DataTableRowHandle(handle) => {
                self.value(
                    package,
                    &PropertyValue::Name(handle.row_name),
                    "RowName",
                    class,
                    nested("struct member"),
                );
            }
            PropertyValue::Raw { .. } => self.raw_values += 1,
            _ => {}
        }
    }

    pub(super) fn asset(
        &mut self,
        package: &Package,
        asset: &DecodedAsset,
        export: &Export,
        class: &str,
    ) {
        self.decoded_exports += 1;
        // RF_ClassDefaultObject, also covering its nested default subobjects by saved outer path.
        let location = if export.object_flags & 0x10 != 0
            || export.object_path.as_str().contains(".Default__")
        {
            "CDO"
        } else {
            "plain property"
        };
        match asset {
            DecodedAsset::DataTable(table) => {
                self.stream(package, &table.properties, class, location);
                for row in &table.rows {
                    self.stream(package, &row.properties, class, "DataTable cell");
                }
            }
            DecodedAsset::DataAsset(object) => {
                self.stream(package, &object.properties, class, location)
            }
            DecodedAsset::UObject(object) => {
                self.stream(package, &object.properties, class, location);
                if let Some(value) = &object.native_data {
                    self.value(package, value, "NativeData", class, location);
                }
            }
            DecodedAsset::Function(function) => {
                self.stream(package, &function.object.properties, class, location);
                if let Some(value) = &function.object.native_data {
                    self.value(package, value, "NativeData", class, location);
                }
            }
            DecodedAsset::BlueprintGraphNode(node) => {
                self.stream(package, &node.properties, class, location);
                for pin in node.pins.iter().flatten() {
                    if matches!(
                        package.resolve_name(pin.pin_type.category).as_deref(),
                        Some("string" | "name")
                    ) {
                        let kind = if package.resolve_name(pin.pin_type.category).as_deref()
                            == Some("name")
                        {
                            "FName pin literal"
                        } else {
                            "FString pin literal"
                        };
                        self.record(
                            &pin.default_value,
                            "Pin.DefaultValue",
                            class,
                            "graph pin",
                            kind,
                        );
                    }
                }
                for pin in &node.user_defined_pins {
                    if matches!(
                        package.resolve_name(pin.pin_type.category).as_deref(),
                        Some("string" | "name")
                    ) {
                        self.record(
                            &pin.default_value,
                            "UserPin.DefaultValue",
                            class,
                            "graph pin",
                            "user pin literal",
                        );
                    }
                }
            }
            // StringTable native entries are localizable and are not FString properties.
            DecodedAsset::StringTable(_) => {}
            DecodedAsset::CurveTable(table) => {
                self.stream(package, &table.properties, class, location)
            }
            DecodedAsset::AnimSequence(sequence) => {
                self.stream(package, &sequence.properties, class, location)
            }
            DecodedAsset::Skeleton(skeleton) => {
                self.stream(package, &skeleton.properties, class, location);
                if let Some(value) = &skeleton.reference_pose {
                    self.value(package, value, "ReferencePose", class, "struct member");
                }
            }
            DecodedAsset::Enum(enumeration) => {
                self.stream(package, &enumeration.properties, class, location)
            }
            DecodedAsset::Struct(structure) => {
                self.stream(package, &structure.properties, class, location);
                self.stream(package, &structure.default_values, class, "struct member");
            }
        }
    }
}

fn exclusion(value: &str) -> Option<&'static str> {
    if value.is_empty() {
        return Some("empty");
    }
    let value = value.trim();
    if value.is_empty() {
        return Some("whitespace-only");
    }
    if value.eq_ignore_ascii_case("None") {
        return Some("None");
    }
    if ["/Game/", "/Script/", "/Engine/"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
        || value.split_once('\'').is_some_and(|(prefix, tail)| {
            !prefix.contains(char::is_whitespace) && tail.ends_with('\'')
        })
    {
        return Some("object path/soft reference");
    }
    let guid = value.trim_matches(['{', '}']);
    if (guid.len() == 32 || guid.len() == 36)
        && guid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && guid.chars().filter(|c| *c != '-').count() == 32
    {
        return Some("GUID/hex");
    }
    if value.parse::<f64>().is_ok() {
        return Some("number");
    }
    if value
        .strip_prefix("0x")
        .is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit()))
        || value.len() >= 8 && value.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Some("GUID/hex");
    }
    let extension = value
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    if value.contains('\\')
        || value.contains('/')
        || value.as_bytes().get(1) == Some(&b':')
        || extension.as_deref().is_some_and(|ext| {
            matches!(
                ext,
                "uasset"
                    | "umap"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "tga"
                    | "dds"
                    | "exr"
                    | "wav"
                    | "mp3"
                    | "ogg"
                    | "mp4"
                    | "fbx"
                    | "obj"
                    | "txt"
                    | "csv"
                    | "json"
                    | "ini"
                    | "cpp"
                    | "h"
                    | "dll"
                    | "exe"
                    | "ttf"
                    | "otf"
                    | "xml"
                    | "pdf"
            )
        })
    {
        return Some("file path/extension");
    }
    if value.contains('.')
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_alphanumeric() || c == '_'))
    {
        return Some("dotted tag-like name");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusions_are_ordered_and_do_not_swallow_sentences() {
        for (value, reason) in [
            ("", "empty"),
            (" \t", "whitespace-only"),
            ("None", "None"),
            ("/Game/Example.Example", "object path/soft reference"),
            ("Class'/Script/Engine.Actor'", "object path/soft reference"),
            ("C:\\Temp\\file.png", "file path/extension"),
            (".png", "file path/extension"),
            ("123.25", "number"),
            ("-1e3", "number"),
            ("0xabcdef", "GUID/hex"),
            ("12345678-1234-1234-1234-123456789abc", "GUID/hex"),
            ("Input.Action.Jump", "dotted tag-like name"),
        ] {
            assert_eq!(exclusion(value), Some(reason));
        }
        for value in [
            "Play",
            "Open settings.",
            "Waiting for the next turn",
            "first_name",
        ] {
            assert_eq!(exclusion(value), None);
        }
    }

    #[test]
    fn distinct_counts_and_serialization_keep_only_shapes() {
        let mut counts = Counts::default();
        for value in [
            "private content alpha",
            "private content alpha",
            "private content beta",
            "None",
        ] {
            counts.record(value, "Label", "Blueprint", "plain property", "FString");
        }
        let report = counts.report(&[]);
        assert_eq!((report.total.count, report.total.distinct), (4, 3));
        assert_eq!((report.retained.count, report.retained.distinct), (3, 2));
        assert_eq!(
            (report.properties[0].count, report.properties[0].distinct),
            (3, 2)
        );
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("private content"));
        assert!(json.contains("words"));
    }

    #[test]
    fn walks_nested_containers_and_keeps_cell_and_cdo_context() {
        use uasset_parser::archive::Span;
        use uasset_parser::property::{MapEntry, NativeProperty};
        let bytes = include_bytes!(
            "../../../../../fixtures/unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset"
        );
        let package = Package::parse(bytes).unwrap();
        let value = PropertyValue::Array(vec![PropertyValue::Map(vec![MapEntry {
            key: PropertyValue::String("Play".to_owned()),
            value: PropertyValue::Set(vec![PropertyValue::InstancedStruct {
                struct_type: uasset_parser::package::PackageIndex::Null,
                payload: Span::new(0, 0).unwrap(),
                value: Some(Box::new(PropertyValue::NativeStruct {
                    fields: vec![NativeProperty {
                        name: "NestedLabel".to_owned(),
                        value: PropertyValue::String("Options".to_owned()),
                    }],
                })),
            }]),
        }])]);
        for location in ["DataTable cell", "CDO", "plain property"] {
            let mut counts = Counts::default();
            counts.value(&package, &value, "Labels", "DataTable", location);
            assert_eq!(counts.total.count, 2);
            assert_eq!(counts.properties["NestedLabel"].count, 1);
            if location == "plain property" {
                assert_eq!(counts.locations["array/map/set element"].count, 1);
                assert_eq!(counts.locations["struct member"].count, 1);
            } else {
                assert_eq!(counts.locations[location].count, 2);
            }
        }
    }

    #[test]
    fn metadata_redaction_does_not_change_counts() {
        let mut counts = Counts::default();
        counts.record(
            "Play",
            "SecretProjectLabel",
            "SecretProjectClass",
            "CDO",
            "FString",
        );
        let report = counts.report(&["secretproject".to_owned()]);
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("SecretProject"));
        assert_eq!(report.retained.count, 1);
    }
}
