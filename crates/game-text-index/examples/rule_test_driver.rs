//! Runs the native evaluator on explicit subject rows supplied by portable rule unit tests.
use game_text_index::Result;
use game_text_index::rules::{
    HostCollator, Relation, Subject, compile, javascript_json, parse_json,
};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};

fn main() -> Result<()> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    let input = parse_json(&text)?;
    let program = compile(&javascript_json(&input["document"], false))?;
    let collator = HostCollator::new(input["locale"].as_str().ok_or("Missing locale.")?)?;
    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    for (name, subject) in [
        ("line", Subject::Line),
        ("line_culture", Subject::LineCulture),
        ("unit_source", Subject::UnitSource),
    ] {
        let rows = input[name].as_array().ok_or("Missing subject rows.")?;
        let mut relation = Relation {
            subject: Some(subject),
            fields: HashMap::new(),
            occurrences: Vec::new(),
        };
        for row in rows {
            for (name, value) in row["fields"].as_object().ok_or("Missing row fields.")? {
                relation
                    .fields
                    .entry(name.clone())
                    .or_default()
                    .push(value.clone());
            }
            relation.occurrences.push(
                row["occurrences"]
                    .as_array()
                    .ok_or("Missing occurrences.")?
                    .clone(),
            );
        }
        let evaluated = program.evaluate(&mut relation, &collator)?;
        for finding in evaluated.findings {
            let affected = finding
                .affected
                .rows
                .iter()
                .map(|row| relation.place(*row))
                .collect::<Result<Vec<_>>>()?;
            output.push(json!({"rule":finding.rule,"row":finding.row,"actual":finding.actual,"expectation":finding.expectation,"fix":finding.fix,"extra":finding.extra,"translationOrigin":finding.translation_origin,"recovery":finding.recovery,"affected":affected}));
        }
        for diagnostic in evaluated.diagnostics {
            diagnostics
                .push(json!({"subject":subject,"row":diagnostic.row,"code":diagnostic.name()}));
        }
        if subject == Subject::LineCulture {
            for (row, value) in rows.iter().enumerate() {
                let fields = &value["fields"];
                let culture = fields["culture"].as_str().ok_or("Missing culture.")?;
                let mut codes = Vec::new();
                if fields["line.checkable"] == true && fields["line.comparable"] == true {
                    for text in [&fields["line.comparisonSource"], &fields["latest"]] {
                        if let Some(text) = text.as_str() {
                            codes.extend(
                                game_text_index::rules::format_pattern(text, culture)
                                    .issues
                                    .into_iter()
                                    .filter(|issue| {
                                        matches!(
                                            issue.code.as_str(),
                                            "unsupported_culture" | "syntax_limit"
                                        )
                                    })
                                    .map(|issue| issue.code),
                            );
                        }
                    }
                }
                diagnostics.push(json!({"subject":"line_culture","row":row,"patternIssues":codes}));
            }
        }
    }
    let rules = program
        .rules
        .iter()
        .map(|compiled| {
            let mut rule = serde_json::to_value(&compiled.rule)?;
            if let Some(fields) = rule.as_object_mut() {
                fields.retain(|_, value| !value.is_null());
            }
            Ok(json!({"ordinal":compiled.ordinal,"rule":rule}))
        })
        .collect::<Result<Vec<_>>>()?;
    std::io::stdout().write_all(
        javascript_json(
            &json!({"findings":output,"diagnostics":diagnostics,"rules":rules}),
            false,
        )
        .as_bytes(),
    )?;
    Ok(())
}
