use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub type NodeId = usize;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Subject {
    Line,
    LineCulture,
    UnitSource,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub rule_id: Option<String>,
    pub kind: String,
    pub label: String,
    pub subject: Subject,
    pub family: String,
    pub enabled: Option<bool>,
    pub severity: String,
    #[serde(default)]
    pub params: serde_json::Map<String, Value>,
    pub scope: Option<Value>,
    pub role: Option<String>,
    #[serde(default, rename = "let")]
    pub bindings: serde_json::Map<String, Value>,
    pub each: Option<Value>,
    pub each_as: Option<String>,
    pub when: Value,
    pub actual: Value,
    pub expectation: Value,
    pub fix: Option<Value>,
    pub affected: Option<Value>,
    pub translation_origin: Option<Value>,
    pub extra: Option<Value>,
    pub recovery: Value,
    pub counts: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema_version: u32,
    roles: Vec<Value>,
    rules: Vec<Rule>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Null,
    Bool,
    Int,
    Number,
    String,
    List(Box<Self>),
    Object,
    Occurrence,
    Any,
}
impl Type {
    fn accepts(&self, other: &Self) -> bool {
        self == other
            || matches!(other, Self::Null | Self::Any)
            || matches!(self, Self::Any)
            || (*self == Self::Number && *other == Self::Int)
    }
}
#[derive(Debug)]
pub struct Node {
    pub op: String,
    pub args: Vec<NodeId>,
    pub value: Value,
    pub result: Type,
}
#[derive(Debug)]
pub struct CompiledRule {
    pub rule: Rule,
    pub ordinal: usize,
    pub each: Option<NodeId>,
    pub when: NodeId,
    pub actual: NodeId,
    pub expectation: NodeId,
    pub fix: Option<NodeId>,
    pub affected: Option<NodeId>,
    pub translation_origin: Option<NodeId>,
    pub extra: Option<NodeId>,
    pub recovery: NodeId,
}
pub struct Program {
    pub nodes: Vec<Node>,
    pub rules: Vec<CompiledRule>,
    pub roles: HashMap<String, Value>,
    pub(crate) diagnostic_patterns: [NodeId; 2],
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::InvalidInput, message)
}
fn literal_type(value: &Value) -> Type {
    match value {
        Value::Null => Type::Null,
        Value::Bool(_) => Type::Bool,
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Type::Int
            } else {
                Type::Number
            }
        }
        Value::String(_) => Type::String,
        Value::Array(values) => {
            Type::List(Box::new(values.first().map_or(Type::Any, literal_type)))
        }
        Value::Object(_) => Type::Object,
    }
}
fn field_type(subject: Subject, name: &str) -> Result<Type> {
    let line = |name: &str| -> Option<Type> {
        Some(match name {
            "lineId" | "source" | "manifestSource" | "comparisonSource" | "sourceCulture"
            | "sourceLatestOrigin" | "nativeCulture" | "originKind" => Type::String,
            "identity" => Type::Object,
            "sourceVariants" | "manifestNotes" | "manifestLocations" | "stringTables" => {
                Type::List(Box::new(Type::String))
            }
            "comparable" | "checkable" | "gathered" | "bytecodeOnly" => Type::Bool,
            _ => return None,
        })
    };
    let value = match subject {
        Subject::Line => line(name),
        Subject::LineCulture => {
            if let Some(name) = name.strip_prefix("line.") {
                line(name)
            } else {
                Some(match name {
                    "culture" | "state" | "po" | "archive" | "archiveSource" | "latest"
                    | "latestOrigin" | "expectedSource" => Type::String,
                    "facts" | "unknownReasons" => Type::List(Box::new(Type::String)),
                    "reducedSourceChecking" | "isNative" | "isSourceCulture" => Type::Bool,
                    _ => return Err(invalid(format!("Unknown line_culture field {name}."))),
                })
            }
        }
        Subject::UnitSource => match name {
            "textUnitId" | "source" => Some(Type::String),
            _ => None,
        },
    };
    value.ok_or_else(|| invalid(format!("Unknown subject field {name}.")))
}

struct Compiler {
    nodes: Vec<Node>,
    interned: HashMap<String, NodeId>,
    active_bindings: HashSet<String>,
    variables: HashSet<String>,
}
impl Compiler {
    fn node(&mut self, op: &str, args: Vec<NodeId>, value: Value, result: Type) -> Result<NodeId> {
        let key = serde_json::to_string(&(op, &args, &value))?;
        if let Some(id) = self.interned.get(&key) {
            return Ok(*id);
        }
        let id = self.nodes.len();
        self.nodes.push(Node {
            op: op.into(),
            args,
            value,
            result,
        });
        self.interned.insert(key, id);
        Ok(id)
    }
    fn expression(&mut self, value: &Value, rule: &Rule) -> Result<NodeId> {
        let Value::Object(object) = value else {
            require(
                !value.is_array(),
                invalid("Lists require a list expression."),
            )?;
            return self.node("lit", Vec::new(), value.clone(), literal_type(value));
        };
        require(
            object.len() == 1,
            invalid("An expression must have exactly one operator."),
        )?;
        let (op, argument) = object.iter().next().ok_or("Missing expression operator.")?;
        if op == "lit" {
            return self.node(op, Vec::new(), argument.clone(), literal_type(argument));
        }
        if op == "field" {
            let name = argument
                .as_str()
                .ok_or_else(|| invalid("A field name must be a string."))?;
            return self.node(
                op,
                Vec::new(),
                argument.clone(),
                field_type(rule.subject, name)?,
            );
        }
        if op == "param" {
            let name = argument
                .as_str()
                .ok_or_else(|| invalid("A parameter name must be a string."))?;
            let value = rule
                .params
                .get(name)
                .ok_or_else(|| invalid(format!("Rule {} has no parameter {name}.", rule.id)))?;
            return self.node("lit", Vec::new(), value.clone(), literal_type(value));
        }
        if op == "var" {
            let name = argument
                .as_str()
                .ok_or_else(|| invalid("A variable name must be a string."))?;
            if let Some(binding) = rule.bindings.get(name) {
                require(
                    self.active_bindings.insert(name.into()),
                    invalid("Cyclic let binding."),
                )?;
                let result = self.expression(binding, rule);
                self.active_bindings.remove(name);
                return result;
            }
            require(
                self.variables.contains(name),
                invalid(format!("Unknown expression variable {name}.")),
            )?;
            return self.node(op, Vec::new(), argument.clone(), Type::Any);
        }
        if op == "finding" {
            require(
                argument.is_string(),
                invalid("A finding reference must name a rule."),
            )?;
            return self.node(op, Vec::new(), argument.clone(), Type::Bool);
        }
        if op == "occurrences" {
            require(
                argument.as_array().is_some_and(Vec::is_empty),
                invalid("occurrences takes no arguments."),
            )?;
            return self.node(
                op,
                Vec::new(),
                Value::Null,
                Type::List(Box::new(Type::Occurrence)),
            );
        }
        if op == "object" {
            let fields = argument
                .as_object()
                .ok_or_else(|| invalid("object requires expression fields."))?;
            let args = fields
                .values()
                .map(|expression| self.expression(expression, rule))
                .collect::<Result<Vec<_>>>()?;
            return self.node(
                op,
                args,
                serde_json::to_value(fields.keys().collect::<Vec<_>>())?,
                Type::Object,
            );
        }
        let unary = [
            "not",
            "isNull",
            "utf16Length",
            "codePoints",
            "visibleLength",
            "visibleWords",
            "interiorLineBreaks",
            "trim",
            "lower",
            "normalizeLineEndings",
            "count",
            "flatten",
            "distinct",
            "first",
            "sortByStart",
            "formatArgumentNames",
            "formatArgumentOrder",
            "formatModifiers",
            "formatIssues",
            "formatCompiled",
            "richTextCounts",
            "richTextTagBalance",
            "unrealWhitespace",
            "unrealUnsafeWhitespace",
            "formatBraceBalance",
        ];
        let binding = ["filter", "map", "flatMap", "any", "all"];
        let mut arguments = if unary.contains(&op.as_str()) {
            vec![argument.clone()]
        } else {
            argument
                .as_array()
                .ok_or_else(|| invalid(format!("Operator {op} requires an argument list.")))?
                .clone()
        };
        let mut extra = Value::Null;
        if binding.contains(&op.as_str()) && arguments.len() == 3 {
            extra = arguments.pop().ok_or("Missing binding name.")?;
            require(
                extra.is_string(),
                invalid("A binding name must be a string."),
            )?;
        }
        if op == "findingField" {
            require(
                arguments.len() == 2 && arguments.iter().all(Value::is_string),
                invalid("findingField requires a rule ID and path."),
            )?;
            return self.node(op, Vec::new(), json_array(arguments), Type::Any);
        }
        let arity = arguments.len();
        let mut args = Vec::new();
        for (index, expression) in arguments.iter().enumerate() {
            let binding_name = if index == 1
                && (binding.contains(&op.as_str())
                    || ["sortCodeUnit", "sortLocale"].contains(&op.as_str()))
            {
                Some(extra.as_str().unwrap_or("item"))
            } else {
                None
            };
            let existed = binding_name.is_some_and(|name| !self.variables.insert(name.into()));
            let argument = self.expression(expression, rule)?;
            if let Some(name) = binding_name
                && !existed
            {
                self.variables.remove(name);
            }
            args.push(argument);
        }
        let result = match op.as_str() {
            "list" => Type::List(Box::new(
                args.first()
                    .map_or(Type::Any, |id| self.nodes[*id].result.clone()),
            )),
            "and" | "or" => {
                self.arguments(&args, &Type::Bool)?;
                Type::Bool
            }
            "not" => {
                self.arity(arity, 1, op)?;
                self.arguments(&args, &Type::Bool)?;
                Type::Bool
            }
            "eq" | "ne" => {
                self.arity(arity, 2, op)?;
                Type::Bool
            }
            "lt" | "le" | "gt" | "ge" => {
                self.arity(arity, 2, op)?;
                for id in &args {
                    require(
                        matches!(
                            self.nodes[*id].result,
                            Type::Number | Type::Int | Type::String | Type::Any | Type::Null
                        ),
                        invalid("Comparison requires numbers or strings."),
                    )?;
                }
                Type::Bool
            }
            "in" => {
                self.arity(arity, 2, op)?;
                Type::Bool
            }
            "isNull" => {
                self.arity(arity, 1, op)?;
                Type::Bool
            }
            "if" => {
                self.arity(arity, 3, op)?;
                self.arguments(&args[..1], &Type::Bool)?;
                self.nodes[args[1]].result.clone()
            }
            "coalesce" => args
                .first()
                .map_or(Type::Any, |id| self.nodes[*id].result.clone()),
            "add" | "mul" | "min" | "max" | "sub" | "div" | "round" => {
                if ["sub", "div", "round"].contains(&op.as_str()) {
                    self.arity(arity, 2, op)?;
                }
                self.arguments(&args, &Type::Number)?;
                Type::Number
            }
            "utf16Length" | "codePoints" | "visibleLength" | "visibleWords"
            | "interiorLineBreaks" => {
                self.arity(arity, 1, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Int
            }
            "trim" | "lower" | "normalizeLineEndings" => {
                self.arity(arity, 1, op)?;
                self.arguments(&args, &Type::String)?;
                Type::String
            }
            "concat" => {
                self.arguments(&args, &Type::String)?;
                Type::String
            }
            "slice" => {
                self.arity(arity, 3, op)?;
                self.arguments(&args[..1], &Type::String)?;
                self.arguments(&args[1..], &Type::Number)?;
                Type::String
            }
            "startsWith" | "endsWith" | "contains" => {
                self.arity(arity, 2, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Bool
            }
            "countOccurrences" => {
                self.arity(arity, 2, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Int
            }
            "findAll" => {
                self.arity(arity, 2, op)?;
                Type::List(Box::new(Type::Object))
            }
            "anyChar" | "allChars" => {
                self.arity(arity, 2, op)?;
                Type::Bool
            }
            "removeClass" | "leadingClass" | "trailingClass" => {
                self.arity(arity, 2, op)?;
                Type::String
            }
            "trimClass" => {
                self.arity(arity, 3, op)?;
                Type::String
            }
            "runs" => {
                self.arity(arity, 3, op)?;
                Type::Int
            }
            "regexMatches" | "termMatches" => {
                self.arity(arity, 3, op)?;
                Type::List(Box::new(Type::Object))
            }
            "regexTest" => {
                self.arity(arity, 3, op)?;
                Type::Bool
            }
            "termListMatches" => {
                self.arity(arity, 4, op)?;
                Type::List(Box::new(Type::Object))
            }
            "count" => {
                self.arity(arity, 1, op)?;
                Type::Int
            }
            "any" | "all" => {
                self.arity(arity, 2, op)?;
                Type::Bool
            }
            "filter" | "map" | "flatMap" => {
                self.arity(arity, 2, op)?;
                Type::List(Box::new(Type::Any))
            }
            "flatten" | "distinct" | "sortByStart" => {
                self.arity(arity, 1, op)?;
                Type::List(Box::new(Type::Any))
            }
            "sortCodeUnit" | "sortLocale" => {
                require(
                    (1..=2).contains(&arity),
                    invalid("A sort requires a list and optional key."),
                )?;
                Type::List(Box::new(Type::Any))
            }
            "first" => {
                self.arity(arity, 1, op)?;
                Type::Any
            }
            "take" | "drop" | "minus" | "zip" => {
                self.arity(arity, 2, op)?;
                Type::List(Box::new(Type::Any))
            }
            "concatLists" => Type::List(Box::new(Type::Any)),
            "get" => {
                self.arity(arity, 2, op)?;
                self.arguments(&args[1..], &Type::String)?;
                Type::Any
            }
            "matchesRole" | "pathHasPrefix" => {
                self.arity(arity, 2, op)?;
                Type::Bool
            }
            "formatPattern" => {
                self.arity(arity, 2, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Object
            }
            "formatArgumentNames" | "formatArgumentOrder" | "formatModifiers" | "formatIssues" => {
                self.arity(arity, 1, op)?;
                Type::List(Box::new(Type::Any))
            }
            "formatCompiled" => {
                self.arity(arity, 1, op)?;
                Type::Bool
            }
            "formatRenameArgument" => {
                self.arity(arity, 4, op)?;
                self.arguments(&args, &Type::String)?;
                Type::String
            }
            "richTextCounts" | "richTextTagBalance" | "unrealWhitespace" | "formatBraceBalance" => {
                self.arity(arity, 1, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Object
            }
            "unrealUnsafeWhitespace" => {
                self.arity(arity, 1, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Bool
            }
            "richTextValid" => {
                self.arity(arity, 2, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Bool
            }
            "compareRichTextTags" => {
                self.arity(arity, 2, op)?;
                self.arguments(&args, &Type::String)?;
                Type::Object
            }
            "withoutOptionalArgumentTags" => {
                self.arity(arity, 2, op)?;
                Type::String
            }
            _ => return Err(invalid(format!("Unknown expression operator {op}."))),
        };
        self.node(op, std::mem::take(&mut args), extra, result)
    }
    fn arity(&self, actual: usize, expected: usize, op: &str) -> Result<()> {
        require(
            actual == expected,
            invalid(format!(
                "Operator {op} expects {expected} arguments, got {actual}."
            )),
        )
    }
    fn arguments(&self, args: &[NodeId], expected: &Type) -> Result<()> {
        for id in args {
            require(
                expected.accepts(&self.nodes[*id].result),
                invalid(format!(
                    "Expected {expected:?}, got {:?}.",
                    self.nodes[*id].result
                )),
            )?;
        }
        Ok(())
    }
}
fn json_array(values: Vec<Value>) -> Value {
    Value::Array(values)
}

pub fn compile(json: &str) -> Result<Program> {
    let document: Document =
        serde_json::from_value(crate::json_value::parse(json)?).map_err(|cause| {
            Error::with_source(ErrorCode::InvalidInput, "Invalid v4 rule document.", cause)
        })?;
    require(
        document.schema_version == 4,
        invalid("The evaluator requires an internal v4 document."),
    )?;
    let mut roles = HashMap::new();
    for role in document.roles {
        let id = role["id"]
            .as_str()
            .ok_or_else(|| invalid("Missing role ID."))?
            .to_owned();
        require(
            roles.insert(id, role).is_none(),
            invalid("Duplicate role ID."),
        )?;
    }
    let subjects = document
        .rules
        .iter()
        .map(|rule| (rule.id.clone(), rule.subject))
        .collect::<HashMap<_, _>>();
    require(
        subjects.len() == document.rules.len(),
        invalid("Duplicate rule ID."),
    )?;
    let mut compiler = Compiler {
        nodes: Vec::new(),
        interned: HashMap::new(),
        active_bindings: HashSet::new(),
        variables: HashSet::new(),
    };
    let mut compiled = Vec::new();
    for (ordinal, rule) in document.rules.into_iter().enumerate() {
        require(
            rule.role
                .as_ref()
                .is_none_or(|role| roles.contains_key(role)),
            invalid("Unknown rule role."),
        )?;
        if rule.enabled == Some(false) {
            continue;
        }
        if let Some(scope) = &rule.scope
            && let Some(ids) = scope["roles"].as_array()
        {
            require(
                ids.iter()
                    .all(|role| role.as_str().is_some_and(|id| roles.contains_key(id))),
                invalid("Unknown scope role."),
            )?;
        }
        let each = rule
            .each
            .as_ref()
            .map(|each| compiler.expression(each, &rule))
            .transpose()?;
        if each.is_some() {
            compiler
                .variables
                .insert(rule.each_as.clone().unwrap_or("item".into()));
        }
        let mut optional = |value: &Option<Value>| {
            value
                .as_ref()
                .map(|value| compiler.expression(value, &rule))
                .transpose()
        };
        let fix = optional(&rule.fix)?;
        let affected = optional(&rule.affected)?;
        let translation_origin = optional(&rule.translation_origin)?;
        let extra = optional(&rule.extra)?;
        let when = compiler.expression(&rule.when, &rule)?;
        compiler.arguments(&[when], &Type::Bool)?;
        let actual = compiler.expression(&rule.actual, &rule)?;
        let expectation = compiler.expression(&rule.expectation, &rule)?;
        compiler.arguments(&[actual, expectation], &Type::Object)?;
        let recovery = compiler.expression(&rule.recovery, &rule)?;
        compiler.arguments(&[recovery], &Type::String)?;
        compiler.variables.clear();
        compiled.push(CompiledRule {
            rule,
            ordinal,
            each,
            when,
            actual,
            expectation,
            fix,
            affected,
            translation_origin,
            extra,
            recovery,
        });
    }
    let mut order = Vec::new();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    fn visit(
        index: usize,
        rules: &[CompiledRule],
        nodes: &[Node],
        subjects: &HashMap<String, Subject>,
        visiting: &mut HashSet<usize>,
        visited: &mut HashSet<usize>,
        order: &mut Vec<usize>,
    ) -> Result<()> {
        if visited.contains(&index) {
            return Ok(());
        }
        require(
            visiting.insert(index),
            invalid("rule_cycle: cyclic rule reference."),
        )?;
        let rule = &rules[index];
        let mut node_ids = vec![rule.when, rule.actual, rule.expectation, rule.recovery];
        node_ids.extend(
            [
                rule.each,
                rule.fix,
                rule.affected,
                rule.translation_origin,
                rule.extra,
            ]
            .into_iter()
            .flatten(),
        );
        let mut seen = HashSet::new();
        while let Some(id) = node_ids.pop() {
            if !seen.insert(id) {
                continue;
            }
            let node = &nodes[id];
            node_ids.extend_from_slice(&node.args);
            let reference = if node.op == "finding" {
                node.value.as_str()
            } else if node.op == "findingField" {
                node.value[0].as_str()
            } else {
                None
            };
            if let Some(reference) = reference {
                require(
                    subjects
                        .get(reference)
                        .is_none_or(|subject| *subject == rule.rule.subject),
                    invalid("Finding references must have the same subject."),
                )?;
                if let Some(dependency) = rules.iter().position(|rule| rule.rule.id == reference) {
                    visit(dependency, rules, nodes, subjects, visiting, visited, order)?;
                }
            }
        }
        visiting.remove(&index);
        visited.insert(index);
        order.push(index);
        Ok(())
    }
    for index in 0..compiled.len() {
        visit(
            index,
            &compiled,
            &compiler.nodes,
            &subjects,
            &mut visiting,
            &mut visited,
            &mut order,
        )?;
    }
    let mut compiled: Vec<Option<CompiledRule>> = compiled.into_iter().map(Some).collect();
    let rules = order
        .into_iter()
        .filter_map(|index| compiled[index].take())
        .collect();
    // Diagnostics are independent of rule selection and share the same grammar DAG nodes.
    let culture = compiler.node(
        "field",
        Vec::new(),
        Value::String("culture".into()),
        Type::String,
    )?;
    let source = compiler.node(
        "field",
        Vec::new(),
        Value::String("line.comparisonSource".into()),
        Type::String,
    )?;
    let latest = compiler.node(
        "field",
        Vec::new(),
        Value::String("latest".into()),
        Type::String,
    )?;
    let diagnostic_patterns = [
        compiler.node(
            "formatPattern",
            vec![source, culture],
            Value::Null,
            Type::Object,
        )?,
        compiler.node(
            "formatPattern",
            vec![latest, culture],
            Value::Null,
            Type::Object,
        )?,
    ];
    Ok(Program {
        nodes: compiler.nodes,
        rules,
        roles,
        diagnostic_patterns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    #[test]
    fn compiles_the_typescript_catalogue_and_shares_subexpressions() -> Result<()> {
        let output = Command::new("node").args(["--import", "tsx", "--input-type=module", "-e", "import {translateRuleDocument} from './packages/game-text/src/rules/translate.ts'; process.stdout.write(JSON.stringify(translateRuleDocument(undefined)));"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Missing repository root.")?).output()?;
        require(
            output.status.success(),
            std::str::from_utf8(&output.stderr)?,
        )?;
        let program = compile(std::str::from_utf8(&output.stdout)?)?;
        assert_eq!(program.rules.len(), 21);
        assert_eq!(
            program
                .nodes
                .iter()
                .filter(|node| node.op == "formatPattern")
                .count(),
            2
        );
        Ok(())
    }
}
