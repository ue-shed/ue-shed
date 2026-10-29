//! The engine's contract with its hosts, and the identity both sides compare once per session.
//!
//! Rust owns the contract: the rule IR (`rules/ir.rs`) and the findings replies
//! (`rules/replies.rs`). The host's TypeScript types are generated from these definitions into
//! `packages/protocol/src/game-text-contract.generated.ts`; a test fails when that file drifts.
//! After the handshake neither side validates the other's messages.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// The sources that decide what crosses the boundary: the typed contract, the engine's requests
/// and outcomes, the findings' fields (still JSON objects), and the JSON and UTF-16 encoders.
/// Hashing whole files over-approximates: an unrelated edit to one also changes the hash, and
/// the drift test then asks for the generated file to be regenerated.
const SOURCES: [&str; 19] = [
    include_str!("package_text_contract.rs"),
    include_str!("localization/import.rs"),
    include_str!("localization/mod.rs"),
    include_str!("contract.rs"),
    include_str!("session.rs"),
    include_str!("batch.rs"),
    include_str!("rules/ir.rs"),
    include_str!("rules/replies.rs"),
    include_str!("engine.rs"),
    include_str!("rules/findings_read.rs"),
    include_str!("rules/findings_query.rs"),
    include_str!("rules/identity.rs"),
    include_str!("wtf8.rs"),
    include_str!("engine_types.rs"),
    include_str!("engine_where.rs"),
    include_str!("sink.rs"),
    include_str!("../../unreal-code/src/lib.rs"),
    include_str!("../../unreal-code/src/discovery.rs"),
    include_str!("../../unreal-code/src/request.rs"),
];

/// The engine's build and contract identity, reported by `capabilities`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractIdentity {
    /// The UE Shed suite version the engine was built for.
    pub build_id: String,
    /// SHA-256 of the contract sources.
    pub contract_hash: String,
}

pub fn identity() -> ContractIdentity {
    static HASH: OnceLock<String> = OnceLock::new();
    ContractIdentity {
        build_id: env!("CARGO_PKG_VERSION").into(),
        contract_hash: HASH
            .get_or_init(|| {
                let mut hash = Sha256::new();
                for source in SOURCES {
                    // Line endings are checkout settings, not contract changes.
                    let source = source.replace("\r\n", "\n");
                    hash.update((source.len() as u64).to_le_bytes());
                    hash.update(source.as_bytes());
                }
                format!("{:x}", hash.finalize())
            })
            .clone(),
    }
}

#[cfg(test)]
mod tests {
    use crate::batch::{BatchHeader, ColumnHeader, ColumnType, Missing, StringsHeader};
    use crate::engine::{EnginePolicy, EngineRequest, OpenReply, Profile, Progress};
    use crate::engine_types::{
        DetailSection, Facets, FindingsSelection, GroupBy, GroupKey, GroupsPart, LineAnswer,
        LineRequest, OpenGroupAnswer, OpenGroupsPart, PlacesSection, Query, QueryAnswer,
        QueryParts, RelatedSection, RowKind, RowSelection, RowsPart, Selection, TextSearch,
    };
    use crate::engine_where::Facet;
    use crate::package_text_contract::{
        CodeLayerOutcome, CodeLayerRequest, PackageTextAudienceMatch, PackageTextAudienceRule,
        PackageTextExpected, PackageTextObjectPosition, PackageTextPlan, PackageTextPlanRequest,
        PackageTextPlanShard, PackageTextShard, PackageTextSnapshotRequest, PointCode, PointEntry,
        PointFile, PointFileStatus, PointOutcome, PointRequest,
    };
    use crate::rules::findings_query::{
        AcceptedFinding, CodeCount, Counts, Diagnostics, FindingsAcceptRequest, FindingsPage,
        Order, Page, QueryRequest, RuleTotal, View,
    };
    use crate::rules::ir::{
        Document, Expr, Family, MatchOperator, MatcherKind, Role, RoleMatcher, RoleScope, Rule,
        Scope, Severity, Subject,
    };
    use crate::rules::replies::{
        EvaluationProfile, FindingsEvaluation, LineDiagnostic, Memory, Place, PlaceSet,
        ProfileSample, ReadProfile, RoleTotal, RuleCount, RuleMetadata, RuleProblem,
        RuleProblemCode, RulesCheck, RunProfile, StageSample, SubStageSample,
    };
    use crate::session::{EngineEnd, EngineError, EngineFailure};
    use crate::sink::{Envelope, Format, Sink, SinkSummary};
    use crate::snapshot::IoMetrics;
    use crate::store::Configuration;
    use ts_rs::{Config, TS};

    const GENERATED: &str = "packages/protocol/src/game-text-contract.generated.ts";

    /// The generated TypeScript: one file, arrays and tuples read-only because hosts only build
    /// and read these values.
    fn typescript() -> String {
        let config = Config::default();
        let mut text = String::from(
            "// Generated from crates/game-text-index/src/contract.rs, rules/ir.rs and rules/replies.rs by\n\
             // `UE_SHED_UPDATE_GENERATED=1 cargo test -p game-text-index --lib contract`. Do not edit.\n\n",
        );
        let identity = super::identity();
        text.push_str(&format!(
            "/** The engine build and contract this host was built against. */\n\
             export const gameTextEngineContract = {{\n\tbuildId: \"{}\",\n\tcontractHash: \"{}\"\n}} as const;\n\n",
            identity.build_id, identity.contract_hash
        ));
        text.push_str(
            "/**\n * The Game Text engine's message types: the v4 rule IR, the findings replies and the\n\
             * evaluation profile. Hosts build and read engine messages with these types; the session\n\
             * handshake checks that the engine was built against the same contract.\n */\n\
             export declare namespace GameTextContract {\n\
             export type JsonValue =\n\t| null\n\t| boolean\n\t| number\n\t| string\n\t\
             | ReadonlyArray<JsonValue>\n\t| { readonly [key: string]: JsonValue };\n\n\
             /** One finding's fields; `places` names its place set. */\n\
             export type Finding = {\n\treadonly places: number;\n\treadonly id: string;\n\t\
             readonly [key: string]: JsonValue;\n};\n",
        );
        for declaration in [
            crate::localization::Format::decl(&config),
            crate::localization::Options::decl(&config),
            crate::localization::Limits::decl(&config),
            crate::localization::Diagnostic::decl(&config),
            crate::localization::import::Input::decl(&config),
            crate::localization::import::Request::decl(&config),
            crate::localization::import::Provenance::decl(&config),
            crate::localization::import::PreparedFile::decl(&config),
            crate::localization::import::FileResult::decl(&config),
            crate::localization::import::Outcome::decl(&config),
            EngineRequest::decl(&config),
            unreal_code::CodeTextRequest::decl(&config),
            unreal_code::CodeTarget::decl(&config),
            unreal_code::GatherStep::decl(&config),
            unreal_code::EngineLine::decl(&config),
            unreal_code::CodeTextResult::decl(&config),
            unreal_code::TargetText::decl(&config),
            unreal_code::FileCounts::decl(&config),
            unreal_code::EngineWrappers::decl(&config),
            unreal_code::CodeTextProfile::decl(&config),
            unreal_code::CodePlace::decl(&config),
            unreal_code::MetadataField::decl(&config),
            unreal_code::CodeDiagnostic::decl(&config),
            unreal_code::DiagnosticCode::decl(&config),
            super::ContractIdentity::decl(&config),
            Configuration::decl(&config),
            EnginePolicy::decl(&config),
            OpenReply::decl(&config),
            EngineEnd::decl(&config),
            EngineFailure::decl(&config),
            EngineError::decl(&config),
            Profile::decl(&config),
            Progress::decl(&config),
            IoMetrics::decl(&config),
            BatchHeader::decl(&config),
            ColumnHeader::decl(&config),
            ColumnType::decl(&config),
            Missing::decl(&config),
            StringsHeader::decl(&config),
            Document::decl(&config),
            Rule::decl(&config),
            Expr::decl(&config),
            Scope::decl(&config),
            Role::decl(&config),
            RoleScope::decl(&config),
            RoleMatcher::decl(&config),
            MatcherKind::decl(&config),
            MatchOperator::decl(&config),
            Subject::decl(&config),
            Family::decl(&config),
            Severity::decl(&config),
            FindingsEvaluation::decl(&config),
            RulesCheck::decl(&config),
            RuleProblem::decl(&config),
            RuleProblemCode::decl(&config),
            RuleMetadata::decl(&config),
            RuleCount::decl(&config),
            RoleTotal::decl(&config),
            EvaluationProfile::decl(&config),
            RunProfile::decl(&config),
            StageSample::decl(&config),
            SubStageSample::decl(&config),
            ProfileSample::decl(&config),
            Memory::decl(&config),
            FindingsAcceptRequest::decl(&config),
            AcceptedFinding::decl(&config),
            QueryRequest::decl(&config),
            Query::decl(&config),
            Selection::decl(&config),
            TextSearch::decl(&config),
            FindingsSelection::decl(&config),
            Facet::decl(&config),
            QueryParts::decl(&config),
            RowsPart::decl(&config),
            GroupKey::decl(&config),
            OpenGroupsPart::decl(&config),
            GroupsPart::decl(&config),
            GroupBy::decl(&config),
            Facets::decl(&config),
            QueryAnswer::decl(&config),
            OpenGroupAnswer::decl(&config),
            LineRequest::decl(&config),
            RowSelection::decl(&config),
            RowKind::decl(&config),
            PlacesSection::decl(&config),
            PackageTextSnapshotRequest::decl(&config),
            PackageTextPlanRequest::decl(&config),
            PackageTextPlan::decl(&config),
            CodeLayerRequest::decl(&config),
            CodeLayerOutcome::decl(&config),
            PointFile::decl(&config),
            PointCode::decl(&config),
            PointRequest::decl(&config),
            PointEntry::decl(&config),
            PointFileStatus::decl(&config),
            PointOutcome::decl(&config),
            PackageTextPlanShard::decl(&config),
            PackageTextShard::decl(&config),
            PackageTextExpected::decl(&config),
            PackageTextAudienceRule::decl(&config),
            PackageTextAudienceMatch::decl(&config),
            PackageTextObjectPosition::decl(&config),
            DetailSection::decl(&config),
            RelatedSection::decl(&config),
            LineAnswer::decl(&config),
            Sink::decl(&config),
            Envelope::decl(&config),
            Format::decl(&config),
            SinkSummary::decl(&config),
            View::decl(&config),
            Order::decl(&config),
            Page::decl(&config),
            FindingsPage::decl(&config),
            Counts::decl(&config),
            RuleTotal::decl(&config),
            CodeCount::decl(&config),
            Diagnostics::decl(&config),
            LineDiagnostic::decl(&config),
            PlaceSet::decl(&config),
            Place::decl(&config),
            ReadProfile::decl(&config),
        ] {
            text.push_str("\nexport ");
            text.push_str(
                &declaration
                    .replace("Array<", "ReadonlyArray<")
                    .replace(": [", ": readonly ["),
            );
            text.push('\n');
        }
        text.push('\n');
        text.push_str(
            &crate::batch::relations_typescript().unwrap_or_else(|error| error.to_string()),
        );
        text.push_str("}\n");
        text
    }

    #[test]
    fn generated_typescript_matches_the_contract() -> crate::Result<()> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .ok_or("Missing repository root.")?;
        let path = root.join(GENERATED);
        let expected = typescript();
        if std::env::var_os("UE_SHED_UPDATE_GENERATED").is_some() {
            std::fs::write(&path, &expected)?;
        }
        let actual = std::fs::read_to_string(&path)?.replace("\r\n", "\n");
        assert!(
            actual == expected,
            "{GENERATED} is stale; regenerate it with UE_SHED_UPDATE_GENERATED=1 cargo test -p game-text-index --lib contract"
        );
        Ok(())
    }
}
