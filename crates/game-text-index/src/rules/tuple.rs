//! Exact NaN-boxed atoms and fixed-width tuple memo keys, including unbounded IR arities.
use super::columns::Atom;
use rustc_hash::FxHashMap;

#[derive(Clone, Copy, Default, PartialEq, Eq, Hash)]
pub(super) struct Key {
    atoms: [u64; 4],
    len: usize,
}
#[derive(Default)]
pub(super) struct Packer {
    overflow: FxHashMap<Atom, u32>,
    tails: FxHashMap<(u64, u32), u32>,
}
impl Packer {
    fn atom(&mut self, atom: Atom) -> u64 {
        let (tag, value) = match atom {
            Atom::Null => (0x7ff8, 0),
            Atom::Bool(value) => (0x7ff9, u64::from(value)),
            Atom::Str(value) => (0x7ffa, u64::from(value.0)),
            Atom::Val(value) => (0x7ffb, u64::from(value.0)),
            Atom::Int(value) if (-(1i64 << 47)..(1i64 << 47)).contains(&value) => {
                (0x7ffc, value as u64 & 0x0000_ffff_ffff_ffff)
            }
            Atom::Num(value) if !f64::from_bits(value).is_nan() => return value,
            value => {
                let next = self.overflow.len() as u32;
                (
                    0x7ffd,
                    u64::from(*self.overflow.entry(value).or_insert(next)),
                )
            }
        };
        (tag << 48) | value
    }
    /// The key without touching the overflow tables: up to four atoms, none of them an integer
    /// outside 48 bits or a NaN. Read-only, so parallel workers can share the packer.
    pub fn try_key(&self, atoms: &[Atom]) -> Option<Key> {
        if atoms.len() > 4 {
            return None;
        }
        let mut key = Key {
            atoms: [0; 4],
            len: atoms.len(),
        };
        for (slot, atom) in key.atoms.iter_mut().zip(atoms) {
            let (tag, value) = match *atom {
                Atom::Null => (0x7ff8, 0),
                Atom::Bool(value) => (0x7ff9, u64::from(value)),
                Atom::Str(value) => (0x7ffa, u64::from(value.0)),
                Atom::Val(value) => (0x7ffb, u64::from(value.0)),
                Atom::Int(value) if (-(1i64 << 47)..(1i64 << 47)).contains(&value) => {
                    (0x7ffc, value as u64 & 0x0000_ffff_ffff_ffff)
                }
                Atom::Num(value) if !f64::from_bits(value).is_nan() => {
                    *slot = value;
                    continue;
                }
                _ => return None,
            };
            *slot = (tag << 48) | value;
        }
        Some(key)
    }
    pub fn key(&mut self, atoms: &[Atom]) -> Key {
        let mut key = Key {
            atoms: [0; 4],
            len: atoms.len(),
        };
        let prefix = if atoms.len() <= 4 { atoms.len() } else { 3 };
        for (slot, atom) in key.atoms.iter_mut().zip(&atoms[..prefix]) {
            *slot = self.atom(*atom);
        }
        if atoms.len() > 4 {
            let mut tail = u32::MAX;
            for atom in atoms[3..].iter().rev() {
                let atom = self.atom(*atom);
                let next = self.tails.len() as u32;
                tail = *self.tails.entry((atom, tail)).or_insert(next);
            }
            key.atoms[3] = u64::from(tail);
        }
        key
    }
    pub fn bytes(&self) -> usize {
        self.overflow.capacity() * (std::mem::size_of::<Atom>() + 4)
            + self.tails.capacity() * (std::mem::size_of::<(u64, u32)>() + 4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_keys_cover_float_bits_large_integers_and_unbounded_arity() {
        let mut packer = Packer::default();
        let values = [
            Atom::Null,
            Atom::Bool(false),
            Atom::Int(0),
            Atom::Int(i64::MIN),
            Atom::Int(i64::MAX),
            Atom::Num(0f64.to_bits()),
            Atom::Num((-0f64).to_bits()),
            Atom::Num(f64::NAN.to_bits()),
        ];
        let keys = values.map(|value| packer.key(&[value]));
        for a in 0..keys.len() {
            for b in 0..keys.len() {
                assert_eq!(keys[a] == keys[b], a == b);
            }
        }
        let mut long = [Atom::Int(1); 30];
        let first = packer.key(&long);
        assert!(first == packer.key(&long));
        long[29] = Atom::Int(2);
        assert!(first != packer.key(&long));
        assert!(packer.key(&long[..4]) != packer.key(&long[..3]));
    }
}
