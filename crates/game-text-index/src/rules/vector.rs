//! Cheap operators execute directly on typed atoms, without tuple hashing or value conversion.
use super::columns::{Arena, Atom};
use super::compiler::Op;
use super::text;
use crate::Result;

pub(super) fn cheap(op: &Op) -> bool {
    matches!(
        op,
        Op::Not
            | Op::IsNull
            | Op::Eq
            | Op::Ne
            | Op::Lt
            | Op::Le
            | Op::Gt
            | Op::Ge
            | Op::In
            | Op::Add
            | Op::Sub
            | Op::Mul
            | Op::Div
            | Op::Min
            | Op::Max
            | Op::Round
            | Op::Get
            | Op::Count
            | Op::First
            | Op::FormatIssues
            | Op::FormatCompiled
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
            (Atom::Val(_), Atom::Val(_)) => arena.equal(a, b),
            _ => false,
        }
}
pub(super) fn run(arena: &Arena, op: &Op, inputs: &[Atom]) -> Result<Atom> {
    let a = inputs.first().copied().unwrap_or_default();
    let b = inputs.get(1).copied().unwrap_or_default();
    match op {
        Op::Not => return Ok(Atom::Bool(!a.boolean())),
        Op::IsNull => return Ok(Atom::Bool(a == Atom::Null)),
        Op::Eq | Op::Ne => return Ok(Atom::Bool(equal(arena, a, b) == (*op == Op::Eq))),
        Op::Get => {
            return Ok(if let Atom::Str(path) = b {
                arena.get_path(a, arena.text(path))
            } else {
                Atom::Null
            });
        }
        Op::FormatIssues | Op::FormatCompiled => {
            return Ok(arena.get_path(
                a,
                if *op == Op::FormatIssues {
                    "issues"
                } else {
                    "compiled"
                },
            ));
        }
        Op::Count => {
            return Ok(arena
                .elements(a)?
                .map_or(Atom::Null, |values| Atom::Int(values.len() as i64)));
        }
        Op::First => {
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
        Op::Lt | Op::Le | Op::Gt | Op::Ge => {
            let order = if let (Atom::Str(a), Atom::Str(b)) = (a, b) {
                text::code_unit_compare(arena.text(a), arena.text(b))
            } else {
                number(a)?
                    .partial_cmp(&number(b)?)
                    .ok_or("Invalid numeric comparison.")?
            };
            Atom::Bool(match op {
                Op::Lt => order.is_lt(),
                Op::Le => order.is_le(),
                Op::Gt => order.is_gt(),
                _ => order.is_ge(),
            })
        }
        Op::In => Atom::Bool(
            arena
                .elements(b)?
                .unwrap_or_default()
                .iter()
                .any(|value| equal(arena, a, *value)),
        ),
        _ => {
            let value = match op {
                Op::Add => inputs.iter().try_fold(0.0, |value, atom| {
                    Ok::<_, crate::Error>(value + number(*atom)?)
                })?,
                Op::Mul => inputs.iter().try_fold(1.0, |value, atom| {
                    Ok::<_, crate::Error>(value * number(*atom)?)
                })?,
                Op::Sub => number(a)? - number(b)?,
                Op::Div => number(a)? / number(b)?,
                Op::Round => {
                    let factor = 10f64.powf(number(b)?);
                    (number(a)? * factor + 0.5).floor() / factor
                }
                Op::Min | Op::Max => {
                    let mut values = inputs.iter().map(|atom| number(*atom));
                    let mut value = values.next().transpose()?.unwrap_or(f64::NAN);
                    for next in values {
                        value = if *op == Op::Min {
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
