// Shared saved-byte mutations for the projection and both adapter regressions.
pub fn custom_graph_fixture(damage: &str) -> (Vec<u8>, uasset_parser::Package) {
    use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
    use uasset_parser::package::{ObjectPath, PackageIndex};
    use uasset_parser::property::{PropertyValue, RawReason};

    let mut bytes =
        include_bytes!("../../../../fixtures/graph-pin-text/5.7/BP_Keys.uasset").to_vec();
    let mut package = uasset_parser::Package::parse(&bytes).unwrap();
    let index = package
        .exports
        .iter()
        .position(|export| export.object_path.as_str().ends_with("EventGraph.split"))
        .unwrap();
    package.exports[index].class_path = Some(ObjectPath::new("/Script/Plugin.CustomNode"));
    let PackageIndex::Export(graph) = package.exports[index].outer_index else {
        panic!("saved node belongs to a graph");
    };
    // Membership dispatch accepts arbitrary class names, without a Graph suffix.
    package.exports[graph as usize].class_path =
        Some(ObjectPath::new("/Script/Plugin.CustomContainer"));
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let DecodedAsset::UObject(object) = decode_export(&package.exports[graph as usize], &context)
        .unwrap()
        .unwrap()
    else {
        panic!("graph properties");
    };
    match damage {
        "decoded" => {}
        "rejected" => {
            let nodes = object
                .properties
                .records
                .iter()
                .find(|property| package.resolve_name(property.name).as_deref() == Some("Nodes"))
                .unwrap();
            let offset = nodes.payload.offset() as usize;
            // Leave the element payload behind so the array decoder rejects trailing bytes.
            bytes[offset..offset + 4].copy_from_slice(&0_i32.to_le_bytes());
            let context = AssetDecodeContext {
                source: &bytes,
                package: &package,
                schemas: uasset_parser::schema::embedded_source_model(),
            };
            let DecodedAsset::UObject(object) =
                decode_export(&package.exports[graph as usize], &context)
                    .unwrap()
                    .unwrap()
            else {
                panic!("recovered graph properties");
            };
            assert!(object.properties.records.iter().any(|property| {
                package.resolve_name(property.name).as_deref() == Some("Nodes")
                    && matches!(
                        &property.value,
                        PropertyValue::Raw { reason } if matches!(reason, RawReason::DecoderRejected(_))
                    )
            }));
        }
        "unreadable" => {
            let export = &package.exports[graph as usize];
            let offset = export.serial_offset.get() as usize;
            bytes[offset..offset + export.serial_size as usize].fill(0xff);
            let context = AssetDecodeContext {
                source: &bytes,
                package: &package,
                schemas: uasset_parser::schema::embedded_source_model(),
            };
            assert!(decode_export(export, &context).is_err());
        }
        _ => panic!("unknown fixture damage"),
    }
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let node = decode_export(&package.exports[index], &context)
        .unwrap()
        .unwrap();
    assert_eq!(
        matches!(node, DecodedAsset::BlueprintGraphNode(_)),
        damage == "decoded"
    );
    assert_eq!(
        uasset_inspection::projection::project_text_asset(&package, &node)
            .occurrences
            .iter()
            .any(|text| text.source == "Reviewed split source"),
        damage == "decoded"
    );
    // Model a trusted empty runtime gather table. Editor-only pins may still be omitted.
    package.summary.gatherable_text_data = Some(uasset_parser::package::TableLocation {
        count: 0,
        offset: package.exports[graph as usize].serial_offset,
    });
    let coverage = uasset_inspection::gather_coverage::gather_coverage(
        &bytes,
        &package,
        "Content/BP_Keys.uasset",
        &uasset_inspection::gather_coverage::DecodedTextKeys::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!((coverage.runtime_sites, coverage.missing), (0, 0));
    (bytes, package)
}
