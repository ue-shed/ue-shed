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
const SOURCES: [&str; 7] = [
    include_str!("contract.rs"),
    include_str!("rules/ir.rs"),
    include_str!("rules/replies.rs"),
    include_str!("engine.rs"),
    include_str!("rules/findings_read.rs"),
    include_str!("rules/identity.rs"),
    include_str!("wtf8.rs"),
];

/// The engine's build and contract identity, reported by `capabilities`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    use crate::rules::ir::{
        Document, Expr, Family, MatchOperator, MatcherKind, Role, RoleMatcher, RoleScope, Rule,
        Scope, Severity, Subject,
    };
    use crate::rules::replies::{
        EvaluationProfile, FindingLine, FindingLines, FindingUnits, FindingsEvaluation,
        LineDiagnostic, Memory, Place, PlaceSet, ProfileSample, ReadProfile, RuleCount,
        RuleMetadata, RunProfile, SpilledReply, StageSample, SubStageSample, UnitFindings,
    };
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
            "export type JsonValue =\n\t| null\n\t| boolean\n\t| number\n\t| string\n\t\
             | ReadonlyArray<JsonValue>\n\t| { readonly [key: string]: JsonValue };\n\n\
             /** One finding's fields; `places` names its place set. */\n\
             export type Finding = {\n\treadonly places: number;\n\treadonly id: string;\n\t\
             readonly [key: string]: JsonValue;\n};\n",
        );
        for declaration in [
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
            RuleMetadata::decl(&config),
            RuleCount::decl(&config),
            EvaluationProfile::decl(&config),
            RunProfile::decl(&config),
            StageSample::decl(&config),
            SubStageSample::decl(&config),
            ProfileSample::decl(&config),
            Memory::decl(&config),
            FindingLines::decl(&config),
            FindingLine::decl(&config),
            LineDiagnostic::decl(&config),
            FindingUnits::decl(&config),
            UnitFindings::decl(&config),
            PlaceSet::decl(&config),
            Place::decl(&config),
            ReadProfile::decl(&config),
            SpilledReply::decl(&config),
        ] {
            text.push_str("\nexport ");
            text.push_str(
                &declaration
                    .replace("Array<", "ReadonlyArray<")
                    .replace(": [", ": readonly ["),
            );
            text.push('\n');
        }
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
