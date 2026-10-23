//! Dense dictionary-ID slots and typed result storage for string kernels.
use super::columns::{Atom, Bits, StrId};
use super::evaluator::Slot;
const MISSING: u32 = u32::MAX;
const PENDING: u32 = u32::MAX - 1;
const NULL: u32 = u32::MAX - 2;
const LIMIT: u32 = u32::MAX - 3;
#[derive(Default)]
enum Values {
    Int(Vec<i64>),
    Bool(Bits),
    Str(Vec<StrId>),
    #[default]
    General,
}
#[derive(Default)]
pub(super) struct DenseMemo {
    slots: Vec<u32>,
    values: Values,
    general: Vec<Atom>,
    len: usize,
}
impl DenseMemo {
    pub fn bytes(&self) -> usize {
        self.slots.capacity() * 4
            + self.general.capacity() * std::mem::size_of::<Atom>()
            + match &self.values {
                Values::Int(values) => values.capacity() * 8,
                Values::Bool(values) => values.words.capacity() * 8,
                Values::Str(values) => values.capacity() * 4,
                Values::General => 0,
            }
    }
    pub fn get(&self, id: usize) -> Option<Slot> {
        let slot = *self.slots.get(id)?;
        match slot {
            MISSING | PENDING => None,
            NULL => Some(Slot::Value(Atom::Null)),
            LIMIT => Some(Slot::Limit),
            slot => Some(Slot::Value(self.value(slot as usize))),
        }
    }
    fn value(&self, slot: usize) -> Atom {
        match &self.values {
            Values::Int(values) => Atom::Int(values[slot]),
            Values::Bool(values) => Atom::Bool(values.get(slot)),
            Values::Str(values) => Atom::Str(values[slot]),
            Values::General => self.general[slot],
        }
    }
    pub fn reserve(&mut self, len: usize) {
        self.slots.resize(len.max(self.slots.len()), MISSING);
    }
    /// Whether `claim` would take this id: nothing is stored or pending for it.
    pub fn missing(&self, id: usize) -> bool {
        self.slots.get(id).is_none_or(|slot| *slot == MISSING)
    }
    pub fn claim(&mut self, id: usize) -> bool {
        if self.slots.len() <= id {
            self.reserve(id + 1);
        }
        if self.slots[id] != MISSING {
            return false;
        }
        self.slots[id] = PENDING;
        true
    }
    pub fn insert(&mut self, id: usize, value: Slot) {
        if self.slots.len() <= id {
            self.reserve(id + 1);
        }
        let atom = match value {
            Slot::Limit => {
                self.slots[id] = LIMIT;
                return;
            }
            Slot::Value(Atom::Null) => {
                self.slots[id] = NULL;
                return;
            }
            Slot::Value(atom) => atom,
        };
        if self.len == 0 {
            self.values = match atom {
                Atom::Int(_) => Values::Int(Vec::new()),
                Atom::Bool(_) => Values::Bool(Bits::default()),
                Atom::Str(_) => Values::Str(Vec::new()),
                _ => Values::General,
            };
        }
        let compatible = matches!(
            (&self.values, atom),
            (Values::Int(_), Atom::Int(_))
                | (Values::Bool(_), Atom::Bool(_))
                | (Values::Str(_), Atom::Str(_))
                | (Values::General, _)
        );
        if !compatible {
            self.general = (0..self.len).map(|slot| self.value(slot)).collect();
            self.values = Values::General;
        }
        match (&mut self.values, atom) {
            (Values::Int(values), Atom::Int(value)) => values.push(value),
            (Values::Bool(values), Atom::Bool(value)) => {
                if self.len.is_multiple_of(64) {
                    values.words.push(0);
                }
                values.len += 1;
                if value {
                    values.set(self.len);
                }
            }
            (Values::Str(values), Atom::Str(value)) => values.push(value),
            (Values::General, value) => self.general.push(value),
            _ => unreachable!(),
        }
        self.slots[id] = self.len as u32;
        self.len += 1;
    }
}
