//! The engine's contract with its hosts, and the identity both sides compare once per session.
//!
//! Rust owns the contract. The host's TypeScript types are generated from these definitions into
//! `packages/protocol/src/game-text-contract.generated.ts`; a test fails when that file drifts.
//! After the handshake neither side validates the other's messages.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// The sources that define the contract, serde attributes and encoding conventions included.
const SOURCES: [&str; 2] = [include_str!("contract.rs"), include_str!("rules/ir.rs")];

/// The engine's build and contract identity, reported by `capabilities`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContractIdentity {
    /// The UE Shed suite version the engine was built for.
    pub build_id: &'static str,
    /// SHA-256 of the contract sources.
    pub contract_hash: &'static str,
}

pub fn identity() -> ContractIdentity {
    static HASH: OnceLock<String> = OnceLock::new();
    ContractIdentity {
        build_id: env!("CARGO_PKG_VERSION"),
        contract_hash: HASH.get_or_init(|| {
            let mut hash = Sha256::new();
            for source in SOURCES {
                // Line endings are checkout settings, not contract changes.
                let source = source.replace("\r\n", "\n");
                hash.update((source.len() as u64).to_le_bytes());
                hash.update(source.as_bytes());
            }
            format!("{:x}", hash.finalize())
        }),
    }
}

#[cfg(test)]
mod tests {
    use crate::rules::ir::{
        Document, Expr, Family, MatchOperator, MatcherKind, Role, RoleMatcher, RoleScope, Rule,
        Scope, Severity, Subject,
    };
    use ts_rs::{Config, TS};

    const GENERATED: &str = "packages/protocol/src/game-text-contract.generated.ts";

    /// The generated TypeScript: one file, arrays and tuples read-only because hosts only build
    /// and read these values.
    fn typescript() -> String {
        let config = Config::default();
        let mut text = String::from(
            "// Generated from crates/game-text-index/src/contract.rs and rules/ir.rs by\n\
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
             | ReadonlyArray<JsonValue>\n\t| { readonly [key: string]: JsonValue };\n",
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
