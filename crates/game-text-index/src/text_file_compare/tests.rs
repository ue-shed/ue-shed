use super::*;

/// A file in its own directory under the temporary directory, named for the test.
fn file(test: &str, name: &str, bytes: &[u8]) -> TextFileSide {
    let directory = std::env::temp_dir()
        .join("ue-shed-text-file-compare")
        .join(format!("{}-{test}", std::process::id()));
    fs::create_dir_all(&directory).expect("a temporary directory");
    let file = directory.join(name);
    fs::write(&file, bytes).expect("a temporary file");
    TextFileSide {
        file,
        path: format!("//Game/{name}"),
    }
}

fn request(
    format: Format,
    before: Option<TextFileSide>,
    after: Option<TextFileSide>,
) -> CompareTextFilesRequest {
    CompareTextFilesRequest {
        options: Options {
            format,
            po_format: None,
            collapse_mode: None,
        },
        before,
        after,
        changes: PageRequest {
            offset: 0,
            limit: 100,
        },
    }
}

fn archive(children: &[(&str, &str, &str)]) -> String {
    let children = children
        .iter()
        .map(|(key, source, translation)| {
            format!(
                r#"{{"Source":{{"Text":"{source}"}},"Translation":{{"Text":"{translation}"}},"Key":"{key}"}}"#
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"FormatVersion":2,"Namespace":"","Subnamespaces":[{{"Namespace":"Menu","Children":[{children}]}}]}}"#
    )
}

fn po(entries: &[(&str, &str, &str)]) -> String {
    let mut text =
        String::from("msgid \"\"\nmsgstr \"\"\n\"Content-Type: text/plain; charset=UTF-8\\n\"\n\n");
    for (context, source, translation) in entries {
        text.push_str(&format!(
            "#. Key:\t{context}\nmsgctxt \"{context}\"\nmsgid \"{source}\"\nmsgstr \"{translation}\"\n\n"
        ));
    }
    text
}

fn kinds(comparison: &TextFileComparison) -> Vec<(PointChangeKind, String)> {
    comparison
        .changes
        .iter()
        .map(|change| {
            let key = change
                .after
                .as_ref()
                .or(change.before.as_ref())
                .expect("a key");
            (change.kind, key.key.clone())
        })
        .collect()
}

fn translation(change: &TextFileChange) -> (Option<&str>, Option<&str>) {
    let field = change
        .fields
        .iter()
        .find(|field| field.name == TextFileFieldName::Translation)
        .expect("a translation");
    (field.before.as_deref(), field.after.as_deref())
}

#[test]
fn an_archive_lists_added_removed_and_edited_keys_in_file_order() -> Result<()> {
    let before = file(
        "archive-order",
        "before.archive",
        archive(&[
            ("Play", "Play", "Jouer"),
            ("Options", "Options", "Options"),
            ("Quit", "Quit", "Quitter"),
        ])
        .as_bytes(),
    );
    let after = file(
        "archive-order",
        "after.archive",
        archive(&[
            ("Play", "Play", "Jouer"),
            ("Credits", "Credits", "Générique"),
            ("Quit", "Quit", "Quitter le jeu"),
        ])
        .as_bytes(),
    );
    let comparison = compare(&request(Format::Archive, Some(before), Some(after)))?;
    assert_eq!(
        kinds(&comparison),
        [
            (PointChangeKind::Added, "Credits".to_owned()),
            (PointChangeKind::Removed, "Options".to_owned()),
            (PointChangeKind::Edited, "Quit".to_owned()),
        ]
    );
    assert_eq!(
        translation(&comparison.changes[2]),
        (Some("Quitter"), Some("Quitter le jeu"))
    );
    assert_eq!(comparison.counts.unchanged, 1);
    assert_eq!(comparison.total, 3);
    Ok(())
}

#[test]
fn a_utf16_archive_reads_like_a_utf8_one() -> Result<()> {
    let text = archive(&[("Play", "Play", "Jouer")]);
    let utf16 = [0xff, 0xfe]
        .into_iter()
        .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
        .collect::<Vec<_>>();
    let before = file("archive-utf16", "before.archive", &utf16);
    let after = file(
        "archive-utf16",
        "after.archive",
        archive(&[("Play", "Play", "Lancer")]).as_bytes(),
    );
    let comparison = compare(&request(Format::Archive, Some(before), Some(after)))?;
    assert_eq!(
        translation(&comparison.changes[0]),
        (Some("Jouer"), Some("Lancer"))
    );
    Ok(())
}

#[test]
fn text_moved_to_a_new_key_is_a_rekey_when_its_source_is_unique() -> Result<()> {
    let before = file(
        "archive-rekey",
        "before.archive",
        archive(&[
            ("Line_01", "Where were you?", "Où étais-tu ?"),
            ("Yes_1", "Yes", "Oui"),
            ("Yes_2", "Yes", "Oui"),
        ])
        .as_bytes(),
    );
    let after = file(
        "archive-rekey",
        "after.archive",
        archive(&[
            ("6F1C", "Where were you?", "Où étais-tu ?"),
            ("A1", "Yes", "Oui"),
            ("A2", "Yes", "Oui"),
        ])
        .as_bytes(),
    );
    let comparison = compare(&request(Format::Archive, Some(before), Some(after)))?;
    let rekey = &comparison.changes[0];
    assert_eq!(rekey.kind, PointChangeKind::Rekeyed);
    assert_eq!(
        rekey.before.as_ref().map(|key| key.key.as_str()),
        Some("Line_01")
    );
    assert_eq!(
        rekey.after.as_ref().map(|key| key.key.as_str()),
        Some("6F1C")
    );
    // "Yes" is on two keys each side, so which went where is not known.
    assert_eq!(comparison.counts.rekeyed, 1);
    assert_eq!(comparison.counts.added, 2);
    assert_eq!(comparison.counts.removed, 2);
    Ok(())
}

#[test]
fn a_manifest_key_with_two_contexts_pairs_by_occurrence() -> Result<()> {
    let manifest = |second: &str| {
        format!(
            r#"{{"FormatVersion":1,"Namespace":"","Subnamespaces":[{{"Namespace":"Menu","Children":[{{"Source":{{"Text":"Back"}},"Keys":[{{"Key":"Back","Path":"/Game/A"}},{{"Key":"Back","Path":"{second}"}}]}}]}}]}}"#
        )
    };
    let before = file(
        "manifest",
        "before.manifest",
        manifest("/Game/B").as_bytes(),
    );
    let after = file("manifest", "after.manifest", manifest("/Game/C").as_bytes());
    let comparison = compare(&request(Format::Manifest, Some(before), Some(after)))?;
    assert_eq!(comparison.counts.unchanged, 1);
    assert_eq!(comparison.counts.edited, 1);
    let path = comparison.changes[0]
        .fields
        .iter()
        .find(|field| field.name == TextFileFieldName::Path)
        .expect("a path");
    assert_eq!(
        (path.before.as_deref(), path.after.as_deref()),
        (Some("/Game/B"), Some("/Game/C"))
    );
    Ok(())
}

#[test]
fn a_po_pairs_by_its_context_and_compares_notes_and_plural_forms() -> Result<()> {
    let before = file(
        "po",
        "before.po",
        po(&[("Menu,Play", "Play", "Jouer"), ("Menu,Quit", "Quit", "")]).as_bytes(),
    );
    let mut text = po(&[
        ("Menu,Play", "Play", "Jouer"),
        ("Menu,Quit", "Quit", "Quitter"),
    ]);
    text.push_str(
        "#. Key:\tApples\nmsgctxt \"Shop,Apples\"\nmsgid \"{0} apple\"\nmsgid_plural \"{0} apples\"\nmsgstr[0] \"{0} pomme\"\nmsgstr[1] \"{0} pommes\"\n",
    );
    let after = file("po", "after.po", text.as_bytes());
    let comparison = compare(&request(Format::Po, Some(before), Some(after)))?;
    assert_eq!(
        kinds(&comparison),
        [
            (PointChangeKind::Edited, "Quit".to_owned()),
            (PointChangeKind::Added, "Apples".to_owned()),
        ]
    );
    assert_eq!(translation(&comparison.changes[0]), (None, Some("Quitter")));
    let forms = comparison.changes[1]
        .fields
        .iter()
        .map(|field| (field.name, field.form))
        .collect::<Vec<_>>();
    assert_eq!(
        forms,
        [
            (TextFileFieldName::Source, None),
            (TextFileFieldName::SourcePlural, None),
            (TextFileFieldName::Translation, Some(0)),
            (TextFileFieldName::Translation, Some(1)),
            (TextFileFieldName::Notes, None),
        ]
    );
    Ok(())
}

#[test]
fn a_deleted_file_removes_every_entry_and_pages_past_the_end_are_empty() -> Result<()> {
    let before = file(
        "deleted",
        "before.archive",
        archive(&[("Play", "Play", "Jouer"), ("Quit", "Quit", "Quitter")]).as_bytes(),
    );
    let mut request = request(Format::Archive, Some(before), None);
    let comparison = compare(&request)?;
    assert_eq!(comparison.counts.removed, 2);
    assert!(!comparison.kept);
    request.changes = PageRequest {
        offset: 5,
        limit: 10,
    };
    let page = compare(&request)?;
    assert!(page.kept, "a later page reuses the comparison");
    assert!(page.changes.is_empty());
    assert_eq!(page.total, 2);
    Ok(())
}

#[test]
fn a_comparison_needs_a_side_and_a_bounded_page() {
    let mut request = request(Format::Po, None, None);
    assert!(validate(&request).is_err());
    request.after = Some(file("validate", "after.po", po(&[]).as_bytes()));
    request.changes.limit = MAX_PAGE + 1;
    assert!(validate(&request).is_err());
}
