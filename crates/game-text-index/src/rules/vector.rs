//! Cheap operators execute directly on typed atoms, without tuple hashing or value conversion.
use super::columns::{Arena, Atom};
use super::text;
use crate::Result;

pub(super) fn cheap(op: &str) -> bool {
    matches!(
        op,
        "not"
            | "isNull"
            | "eq"
            | "ne"
            | "lt"
            | "le"
            | "gt"
            | "ge"
            | "in"
            | "add"
            | "sub"
            | "mul"
            | "div"
            | "min"
            | "max"
            | "round"
            | "get"
            | "count"
            | "first"
            | "formatIssues"
            | "formatCompiled"
    )
}
fn number(atom: Atom) -> Result<f64> {
    match atom {
        Atom::Int(value) => Ok(value as f64),
        Atom::Num(value) => Ok(f64::from_bits(value)),
        _ => Err("Rule operation requires a number.".into()),
    }
}
fn equal(arena: &Arena, a: Atom, b: Atom) -> bool {
    a == b
        || match (a, b) {
            (Atom::Str(a), Atom::Str(b)) => {
                !arena.same_dictionary(a, b) && arena.text(a) == arena.text(b)
            }
            (Atom::Int(_) | Atom::Num(_), Atom::Int(_) | Atom::Num(_)) => {
                number(a).ok() == number(b).ok()
            }
            (Atom::Val(_), Atom::Val(_)) => arena.value(a) == arena.value(b),
            _ => false,
        }
}
pub(super) fn run(arena: &Arena, op: &str, inputs: &[Atom]) -> Result<Atom> {
    let a = inputs.first().copied().unwrap_or_default();
    let b = inputs.get(1).copied().unwrap_or_default();
    match op {
        "not" => return Ok(Atom::Bool(!a.boolean())),
        "isNull" => return Ok(Atom::Bool(a == Atom::Null)),
        "eq" | "ne" => return Ok(Atom::Bool(equal(arena, a, b) == (op == "eq"))),
        "get" => {
            return Ok(if let Atom::Str(path) = b {
                arena.get_path(a, arena.text(path))
            } else {
                Atom::Null
            });
        }
        "formatIssues" | "formatCompiled" => {
            return Ok(arena.get_path(
                a,
                if op == "formatIssues" {
                    "issues"
                } else {
                    "compiled"
                },
            ));
        }
        "count" => {
            return Ok(arena
                .elements(a)?
                .map_or(Atom::Null, |values| Atom::Int(values.len() as i64)));
        }
        "first" => {
            return Ok(arena
                .elements(a)?
                .and_then(|values| values.first())
                .copied()
                .unwrap_or_default());
        }
        _ => {}
    }
    if inputs.contains(&Atom::Null) {
        return Ok(Atom::Null);
    }
    Ok(match op {
        "lt" | "le" | "gt" | "ge" => {
            let order = if let (Atom::Str(a), Atom::Str(b)) = (a, b) {
                text::code_unit_compare(arena.text(a), arena.text(b))
            } else {
                number(a)?
                    .partial_cmp(&number(b)?)
                    .ok_or("Invalid numeric comparison.")?
            };
            Atom::Bool(match op {
                "lt" => order.is_lt(),
                "le" => order.is_le(),
                "gt" => order.is_gt(),
                _ => order.is_ge(),
            })
        }
        "in" => Atom::Bool(
            arena
                .elements(b)?
                .unwrap_or_default()
                .iter()
                .any(|value| equal(arena, a, *value)),
        ),
        _ => {
            let value = match op {
                "add" => inputs.iter().try_fold(0.0, |value, atom| {
                    Ok::<_, crate::Error>(value + number(*atom)?)
                })?,
                "mul" => inputs.iter().try_fold(1.0, |value, atom| {
                    Ok::<_, crate::Error>(value * number(*atom)?)
                })?,
                "sub" => number(a)? - number(b)?,
                "div" => number(a)? / number(b)?,
                "round" => {
                    let factor = 10f64.powf(number(b)?);
                    (number(a)? * factor + 0.5).floor() / factor
                }
                "min" | "max" => {
                    let mut values = inputs.iter().map(|atom| number(*atom));
                    let mut value = values.next().transpose()?.unwrap_or(f64::NAN);
                    for next in values {
                        value = if op == "min" {
                            value.min(next?)
                        } else {
                            value.max(next?)
                        };
                    }
                    value
                }
                _ => return Err("Unknown vector operation.".into()),
            };
            if value.is_finite() {
                Atom::Num(value.to_bits())
            } else {
                Atom::Null
            }
        }
    })
}
