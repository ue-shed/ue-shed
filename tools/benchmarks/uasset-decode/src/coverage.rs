//! Unfiltered, recursive coverage census. Project identities are written only to caller output.
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Write as _};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
use uasset_parser::property::{PropertyStream, PropertyTypeName, PropertyValue, RawReason};
use uasset_parser::schema::embedded_source_model;

use super::Fallible;

#[derive(Default)]
struct Count {
    values: u64,
    bytes: u64,
    unknown_bytes: u64,
    packages: BTreeSet<usize>,
    examples: Vec<String>,
}

impl Count {
    fn add(&mut self, package: usize, location: &str, bytes: Option<u64>) {
        self.values += 1;
        if let Some(bytes) = bytes {
            self.bytes += bytes;
        } else {
            self.unknown_bytes += 1;
        }
        self.packages.insert(package);
        if self.examples.len() < 3 && !self.examples.iter().any(|item| item == location) {
            self.examples.push(location.to_owned());
        }
    }

    fn json(&self) -> Value {
        json!({"count": self.values, "packages_affected": self.packages.len(),
            "raw_payload_bytes": self.bytes, "unknown_payload_sizes": self.unknown_bytes,
            "examples": self.examples})
    }
}

#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
struct Bucket {
    reason: String,
    detail: String,
    property_type: String,
    struct_name: String,
    export_class: String,
}

impl Bucket {
    fn json(&self, count: &Count) -> Value {
        let mut value = count.json();
        value["reason"] = json!(self.reason);
        value["detail"] = json!(self.detail);
        value["property_type"] = json!(self.property_type);
        value["struct_name"] = json!(self.struct_name);
        value["export_class"] = json!(self.export_class);
        value
    }
}

fn reason_kind(reason: &RawReason) -> &'static str {
    match reason {
        RawReason::NotRequested => "NotRequested",
        RawReason::UnsupportedType => "UnsupportedType",
        RawReason::DecoderRejected(_) => "DecoderRejected",
        RawReason::LegacyDecoderRejected(_) => "LegacyDecoderRejected",
        RawReason::LegacyContainerElementWithoutTypeInformation => {
            "LegacyContainerElementWithoutTypeInformation"
        }
        RawReason::FeatureUnavailableForEngineVersion(_) => "FeatureUnavailableForEngineVersion",
        RawReason::UnsupportedTextHistory(_) => "UnsupportedTextHistory",
    }
}

/// Offsets, counts, and array indices vary between instances of the same rejected layout.
fn normalize(detail: &str) -> String {
    let mut number = false;
    let mut output = String::new();
    for ch in detail.chars() {
        if ch.is_ascii_digit() {
            if !number {
                output.push('#');
            }
            number = true;
        } else {
            number = false;
            output.push(ch);
        }
    }
    output
}

#[derive(Default)]
struct Census {
    packages: u64,
    fully_decoded: u64,
    properties: u64,
    tagged_properties: u64,
    raw: u64,
    raw_bytes: u64,
    unknown_sizes: u64,
    parse_errors: u64,
    decode_errors: u64,
    skipped_exports: u64,
    buckets: BTreeMap<Bucket, Count>,
    errors: BTreeMap<String, Count>,
    stage_ns: [u64; 3],
}

struct Walk<'a> {
    package: &'a Package,
    package_index: usize,
    relative: &'a str,
    class: &'a str,
    export_index: usize,
    evidence: &'a mut Option<BufWriter<File>>,
    census: &'a mut Census,
}

impl Walk<'_> {
    fn count_leaf(&mut self, value: &PropertyValue) -> bool {
        if self.evidence.is_none()
            && !matches!(
                value,
                PropertyValue::Raw { .. }
                    | PropertyValue::Struct(_)
                    | PropertyValue::Array(_)
                    | PropertyValue::Set(_)
                    | PropertyValue::Map(_)
                    | PropertyValue::NativeStruct { .. }
                    | PropertyValue::InstancedStruct(_)
            )
        {
            self.census.properties += 1;
            true
        } else {
            false
        }
    }

    fn witness(&mut self, path: &str, kind: &str, data: &str) -> Fallible<()> {
        if self.evidence.is_none() {
            return Ok(());
        }
        self.witness_digest(path, kind, format!("{:x}", Sha256::digest(data.as_bytes())))
    }

    fn witness_digest(&mut self, path: &str, kind: &str, digest: String) -> Fallible<()> {
        if let Some(writer) = self.evidence.as_mut() {
            serde_json::to_writer(
                &mut *writer,
                &json!({"package": self.relative,
                "export": self.export_index, "path": path, "kind": kind,
                "digest": digest}),
            )?;
            writeln!(writer)?;
        }
        Ok(())
    }

    fn stream(&mut self, stream: &PropertyStream, path: &str) -> Fallible<()> {
        for (index, record) in stream.records.iter().enumerate() {
            self.census.tagged_properties += 1;
            if self.count_leaf(&record.value) {
                continue;
            }
            let name = self.package.resolve_name(record.name).unwrap_or_default();
            let path = format!("{path}/record:{index}:{name}[{}]", record.array_index);
            if self.evidence.is_some() {
                self.witness(
                    &format!("{path}/tag"),
                    "tag",
                    &format!(
                        "{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}",
                        record.name,
                        record.type_name,
                        record.array_index,
                        record.flags,
                        record.property_guid,
                        record.struct_guid,
                        record.payload
                    ),
                )?;
            }
            self.value(
                &record.value,
                &path,
                Some(&record.type_name),
                Some(record.payload.len()),
            )?;
        }
        Ok(())
    }

    fn value(
        &mut self,
        value: &PropertyValue,
        path: &str,
        ty: Option<&PropertyTypeName>,
        bytes: Option<u64>,
    ) -> Fallible<()> {
        self.census.properties += 1;
        match value {
            PropertyValue::Raw {
                reason: RawReason::NotRequested,
            } => {}
            PropertyValue::Raw { reason } => {
                self.census.raw += 1;
                if let Some(bytes) = bytes {
                    self.census.raw_bytes += bytes;
                } else {
                    self.census.unknown_sizes += 1;
                }
                let property_type = ty
                    .and_then(|ty| self.package.resolve_name(ty.name))
                    .unwrap_or_else(|| "native".into());
                let struct_name = if property_type == "StructProperty" {
                    ty.and_then(|ty| ty.parameters.first())
                        .and_then(|ty| self.package.resolve_name(ty.name))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let key = Bucket {
                    reason: reason_kind(reason).into(),
                    detail: normalize(&reason.detail()),
                    property_type,
                    struct_name,
                    export_class: self.class.into(),
                };
                let location = format!("{}#export:{}{path}", self.relative, self.export_index);
                self.census.buckets.entry(key).or_default().add(
                    self.package_index,
                    &location,
                    bytes,
                );
                self.witness(path, "raw", &format!("{reason:?}"))?;
            }
            PropertyValue::Struct(stream) => {
                self.witness(path, "struct", "struct")?;
                self.stream(stream, path)?;
            }
            PropertyValue::Array(values) | PropertyValue::Set(values) => {
                let kind = if matches!(value, PropertyValue::Array(_)) {
                    "array"
                } else {
                    "set"
                };
                // Large saved byte/numeric arrays can contain millions of scalar values.
                // Hash their complete typed contents as one unit, without constructing a
                // giant Debug string or one JSON record per scalar. Partial and nested
                // containers keep individual evidence so raw replacements remain reviewable.
                if values.iter().all(is_scalar) {
                    if self.evidence.is_some() {
                        let mut digest = DebugDigest(Sha256::new());
                        write!(&mut digest, "{values:?}")?;
                        self.witness_digest(
                            path,
                            &format!("typed_{kind}"),
                            format!("{:x}", digest.0.finalize()),
                        )?;
                    }
                    self.census.properties += values.len() as u64;
                    return Ok(());
                }
                self.witness(path, kind, &values.len().to_string())?;
                let inner = ty.and_then(|ty| ty.parameters.first());
                for (index, value) in values.iter().enumerate() {
                    if self.count_leaf(value) {
                        continue;
                    }
                    self.value(value, &format!("{path}/element:{index}"), inner, None)?;
                }
            }
            PropertyValue::Map(entries) => {
                self.witness(path, "map", &entries.len().to_string())?;
                for (index, entry) in entries.iter().enumerate() {
                    if !self.count_leaf(&entry.key) {
                        self.value(
                            &entry.key,
                            &format!("{path}/key:{index}"),
                            ty.and_then(|ty| ty.parameters.first()),
                            None,
                        )?;
                    }
                    if !self.count_leaf(&entry.value) {
                        self.value(
                            &entry.value,
                            &format!("{path}/value:{index}"),
                            ty.and_then(|ty| ty.parameters.get(1)),
                            None,
                        )?;
                    }
                }
            }
            PropertyValue::NativeStruct { fields } => {
                self.witness(path, "native_struct", &fields.len().to_string())?;
                for (index, field) in fields.iter().enumerate() {
                    if self.count_leaf(&field.value) {
                        continue;
                    }
                    self.value(
                        &field.value,
                        &format!("{path}/field:{index}:{}", field.name),
                        None,
                        None,
                    )?;
                }
            }
            PropertyValue::InstancedStruct(instance) => {
                self.witness(
                    path,
                    "instanced_struct",
                    &format!("{:?}:{:?}", instance.struct_type, instance.payload),
                )?;
                if let Some(value) = &instance.value {
                    self.value(
                        value,
                        &format!("{path}/instance"),
                        None,
                        Some(instance.payload.len()),
                    )?;
                }
            }
            _ => {
                self.witness(path, "typed", &format!("{value:?}"))?;
            }
        }
        Ok(())
    }

    fn asset(&mut self, asset: &DecodedAsset) -> Fallible<()> {
        let stream = match asset {
            DecodedAsset::DataTable(asset) => {
                for (index, row) in asset.rows.iter().enumerate() {
                    self.stream(&row.properties, &format!("/row:{index}"))?;
                }
                &asset.properties
            }
            DecodedAsset::CurveTable(asset) => &asset.properties,
            DecodedAsset::StringTable(_) => return Ok(()),
            DecodedAsset::DataAsset(asset) => &asset.properties,
            DecodedAsset::UObject(asset) => {
                if let Some(value) = &asset.native_data {
                    self.value(value, "/native", None, None)?;
                }
                &asset.properties
            }
            DecodedAsset::Enum(asset) => &asset.properties,
            DecodedAsset::Struct(asset) => {
                self.stream(&asset.default_values, "/defaults")?;
                &asset.properties
            }
            DecodedAsset::Skeleton(asset) => {
                if let Some(value) = &asset.reference_pose {
                    self.value(value, "/reference_pose", None, None)?;
                }
                &asset.properties
            }
            DecodedAsset::AnimSequence(asset) => &asset.properties,
            DecodedAsset::BlueprintGraphNode(asset) => &asset.properties,
            DecodedAsset::Function(asset) => {
                if let Some(value) = &asset.object.native_data {
                    self.value(value, "/native", None, None)?;
                }
                &asset.object.properties
            }
        };
        self.stream(stream, "/properties")
    }
}

fn is_scalar(value: &PropertyValue) -> bool {
    !matches!(
        value,
        PropertyValue::Raw { .. }
            | PropertyValue::Struct(_)
            | PropertyValue::Array(_)
            | PropertyValue::Set(_)
            | PropertyValue::Map(_)
            | PropertyValue::NativeStruct { .. }
            | PropertyValue::InstancedStruct(_)
    )
}

struct DebugDigest(Sha256);

impl fmt::Write for DebugDigest {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        self.0.update(value.as_bytes());
        Ok(())
    }
}

fn grouped(buckets: &BTreeMap<Bucket, Count>, dimension: impl Fn(&Bucket) -> &str) -> Value {
    let mut groups: BTreeMap<String, Count> = BTreeMap::new();
    for (key, count) in buckets {
        let group = groups.entry(dimension(key).to_owned()).or_default();
        group.values += count.values;
        group.bytes += count.bytes;
        group.unknown_bytes += count.unknown_bytes;
        group.packages.extend(&count.packages);
        for sample in &count.examples {
            if group.examples.len() < 3 && !group.examples.contains(sample) {
                group.examples.push(sample.clone());
            }
        }
    }
    json!(
        groups
            .iter()
            .map(|(key, count)| (key.clone(), count.json()))
            .collect::<BTreeMap<_, _>>()
    )
}

fn report(census: &Census, wall_seconds: f64) -> Value {
    let mut reasons = grouped(&census.buckets, |key| &key.reason);
    if let Some(reasons) = reasons.as_object_mut() {
        for (reason, value) in reasons {
            let selected = census
                .buckets
                .iter()
                .filter(|(key, _)| &key.reason == reason)
                .map(|(key, count)| (key.clone(), count))
                .collect::<Vec<_>>();
            // Each dimension retains counts, package unions, byte coverage, and bounded examples.
            for (field, choose) in [
                (
                    "by_detail",
                    (|key: &Bucket| key.detail.as_str()) as fn(&Bucket) -> &str,
                ),
                ("by_property_type", |key: &Bucket| {
                    key.property_type.as_str()
                }),
                ("by_struct_name", |key: &Bucket| key.struct_name.as_str()),
                ("by_export_class", |key: &Bucket| key.export_class.as_str()),
            ] {
                let mut groups: BTreeMap<String, Count> = BTreeMap::new();
                for (key, count) in &selected {
                    let group = groups.entry(choose(key).to_owned()).or_default();
                    group.values += count.values;
                    group.bytes += count.bytes;
                    group.unknown_bytes += count.unknown_bytes;
                    group.packages.extend(&count.packages);
                    for sample in &count.examples {
                        if group.examples.len() < 3 && !group.examples.contains(sample) {
                            group.examples.push(sample.clone());
                        }
                    }
                }
                value[field] = json!(
                    groups
                        .iter()
                        .map(|(key, count)| (key.clone(), count.json()))
                        .collect::<BTreeMap<_, _>>()
                );
            }
        }
    }
    json!({"schema": 1, "git_commit": super::git_commit(), "wall_seconds": wall_seconds,
        "scope": "Unfiltered decoded property values, including container elements and native fields. Native tails and intentionally skipped exports are not properties. Fully decoded means no raw values, parse errors, or export decode errors; it does not claim all native bytes are understood.",
        "totals": {"packages": census.packages, "packages_fully_decoded": census.fully_decoded,
            "properties": census.properties, "tagged_properties": census.tagged_properties,
            "raw_properties": census.raw, "raw_payload_bytes": census.raw_bytes,
            "raw_properties_with_unknown_payload_size": census.unknown_sizes,
            "parse_errors": census.parse_errors, "export_decode_errors": census.decode_errors,
            "intentionally_skipped_exports": census.skipped_exports},
        "stage_ns": {"parse": census.stage_ns[0], "decode": census.stage_ns[1], "walk": census.stage_ns[2]},
        "by_reason": reasons,
        "buckets": census.buckets.iter().map(|(key, count)| key.json(count)).collect::<Vec<_>>(),
        "errors": census.errors.iter().map(|(key, count)| (key, count.json())).collect::<BTreeMap<_, _>>()})
}

fn markdown(census: &Census, wall_seconds: f64) -> String {
    let mut output = format!(
        "# Parser coverage\n\n{} packages; {} without raw properties or decode errors. {} raw values of {} values; {} known raw bytes. Wall time: {:.3}s.\n\nNative tails and intentionally skipped exports are outside the property census. See census.json for parse/export failures and exact totals.\n",
        census.packages,
        census.fully_decoded,
        census.raw,
        census.properties,
        census.raw_bytes,
        wall_seconds
    );
    for packages in [false, true] {
        output.push_str(if packages {
            "\n## Top 25 by packages affected\n\n"
        } else {
            "\n## Top 25 by raw values\n\n"
        });
        output.push_str("| Reason | Detail | Type / struct | Export class | Raw | Packages |\n| --- | --- | --- | --- | ---: | ---: |\n");
        let mut buckets: Vec<_> = census.buckets.iter().collect();
        buckets.sort_by(|(ka, a), (kb, b)| {
            let rank = if packages {
                b.packages
                    .len()
                    .cmp(&a.packages.len())
                    .then(b.values.cmp(&a.values))
            } else {
                b.values
                    .cmp(&a.values)
                    .then(b.packages.len().cmp(&a.packages.len()))
            };
            rank.then(ka.cmp(kb))
        });
        for (key, count) in buckets.into_iter().take(25) {
            output.push_str(&format!(
                "| {} | {} | {} / {} | {} | {} | {} |\n",
                key.reason,
                key.detail.replace('|', "\\|"),
                key.property_type,
                key.struct_name,
                key.export_class,
                count.values,
                count.packages.len()
            ));
        }
    }
    output
}

pub(super) fn run(paths: &[String], root: &Path, out: &Path, keep_evidence: bool) -> Fallible<()> {
    let root = root.canonicalize()?;
    let wall = Instant::now();
    let mut census = Census::default();
    let mut evidence = if keep_evidence {
        Some(BufWriter::new(File::create(out.join("values.jsonl"))?))
    } else {
        None
    };
    let mut failures = BufWriter::new(File::create(out.join("errors.jsonl"))?);
    for (index, path) in paths.iter().enumerate() {
        let absolute = Path::new(path).canonicalize()?;
        let relative = absolute
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::read(&absolute)?;
        census.packages += 1;
        let raw_before = census.raw;
        let errors_before = census.parse_errors + census.decode_errors;
        let started = Instant::now();
        let parsed = Package::parse(&bytes);
        census.stage_ns[0] += started.elapsed().as_nanos() as u64;
        match parsed {
            Err(error) => {
                census.parse_errors += 1;
                let detail = error.to_string();
                census
                    .errors
                    .entry(format!("parse: {}", normalize(&detail)))
                    .or_default()
                    .add(index, &relative, None);
                serde_json::to_writer(
                    &mut failures,
                    &json!({"package": relative, "error": detail}),
                )?;
                writeln!(failures)?;
            }
            Ok(package) => {
                let context = AssetDecodeContext {
                    source: &bytes,
                    package: &package,
                    schemas: embedded_source_model(),
                    property_filter: None,
                };
                for (export_index, export) in package.exports.iter().enumerate() {
                    let started = Instant::now();
                    let decoded = decode_export(export, &context);
                    census.stage_ns[1] += started.elapsed().as_nanos() as u64;
                    match decoded {
                        Ok(Some(asset)) => {
                            let started = Instant::now();
                            Walk {
                                package: &package,
                                package_index: index,
                                relative: &relative,
                                class: export
                                    .class_path
                                    .as_ref()
                                    .map_or("unresolved", |path| path.as_str()),
                                export_index,
                                evidence: &mut evidence,
                                census: &mut census,
                            }
                            .asset(&asset)?;
                            census.stage_ns[2] += started.elapsed().as_nanos() as u64;
                        }
                        Ok(None) => {
                            census.skipped_exports += 1;
                        }
                        Err(error) => {
                            census.decode_errors += 1;
                            let detail = error.to_string();
                            let location = format!("{relative}#export:{export_index}");
                            census
                                .errors
                                .entry(format!("export: {}", normalize(&detail)))
                                .or_default()
                                .add(index, &location, None);
                            serde_json::to_writer(
                                &mut failures,
                                &json!({"package": relative, "export": export_index, "class": export.class_path.as_ref().map(|path| path.as_str()), "error": detail}),
                            )?;
                            writeln!(failures)?;
                        }
                    }
                }
            }
        }
        if raw_before == census.raw && errors_before == census.parse_errors + census.decode_errors {
            census.fully_decoded += 1;
        }
        if (index + 1) % 5000 == 0 {
            eprintln!(
                "coverage: {} packages, {} raw values, {:.1}s",
                index + 1,
                census.raw,
                wall.elapsed().as_secs_f64()
            );
        }
    }
    if let Some(writer) = evidence.as_mut() {
        writer.flush()?;
    }
    failures.flush()?;
    let wall_seconds = wall.elapsed().as_secs_f64();
    fs::write(
        out.join("census.json"),
        serde_json::to_vec_pretty(&report(&census, wall_seconds))?,
    )?;
    fs::write(out.join("census.md"), markdown(&census, wall_seconds))?;
    println!(
        "Coverage: {} packages, {} fully decoded, {} raw values; {:.3}s",
        census.packages, census.fully_decoded, census.raw, wall_seconds
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_offsets_counts_and_indices() {
        assert_eq!(
            normalize("byte 123: Pins[42] has 67 values"),
            "byte #: Pins[#] has # values"
        );
    }

    #[test]
    fn streaming_debug_digest_covers_every_scalar_without_retaining_a_string() {
        let values = vec![
            PropertyValue::UInt(0),
            PropertyValue::Int(-42),
            PropertyValue::String("fixture".into()),
        ];
        let mut digest = DebugDigest(Sha256::new());
        write!(&mut digest, "{values:?}").unwrap();
        assert_eq!(
            digest.0.finalize(),
            Sha256::digest(format!("{values:?}").as_bytes())
        );
        assert!(values.iter().all(is_scalar));
        assert!(!is_scalar(&PropertyValue::Raw {
            reason: RawReason::UnsupportedType
        }));
    }

    #[test]
    fn counts_distinct_packages_and_bounds_samples() {
        let mut count = Count::default();
        for index in 0..10 {
            count.add(
                index / 2,
                &format!("package#property{index}"),
                (index % 2 == 0).then_some(8),
            );
        }
        assert_eq!(count.values, 10);
        assert_eq!(count.packages.len(), 5);
        assert_eq!(count.bytes, 40);
        assert_eq!(count.unknown_bytes, 5);
        assert_eq!(count.examples.len(), 3);
    }

    #[test]
    fn walks_nested_containers_and_excludes_filtered_values() -> Fallible<()> {
        use uasset_parser::property::{MapEntry, NativeProperty};
        let source = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../../fixtures/unreal-project/Content/Fixture/ParserNative/DA_Native.uasset",
        ))?;
        let package = Package::parse(&source)?;
        let value = PropertyValue::Array(vec![
            PropertyValue::Map(vec![MapEntry {
                key: PropertyValue::Int(1),
                value: PropertyValue::Set(vec![PropertyValue::NativeStruct {
                    fields: vec![NativeProperty {
                        name: "Unknown".into(),
                        value: PropertyValue::Raw {
                            reason: RawReason::UnsupportedType,
                        },
                    }],
                }]),
            }]),
            PropertyValue::Raw {
                reason: RawReason::NotRequested,
            },
        ]);
        let mut census = Census::default();
        let mut evidence = None;
        Walk {
            package: &package,
            package_index: 0,
            relative: "fixture.uasset",
            class: "/Script/Engine.DataAsset",
            export_index: 0,
            evidence: &mut evidence,
            census: &mut census,
        }
        .value(&value, "/test", None, Some(100))?;
        assert_eq!(census.properties, 7);
        assert_eq!(census.raw, 1);
        assert_eq!(census.unknown_sizes, 1);
        assert_eq!(census.raw_bytes, 0);
        assert_eq!(census.buckets.len(), 1);
        Ok(())
    }
}
