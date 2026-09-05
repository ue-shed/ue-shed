//! Standalone allocation/selection experiment: rustc -O header_selection.rs -o <output>.
//! Input construction is excluded. All variants must preserve the same sorted unique sample.
use std::collections::BTreeSet;
use std::hint::black_box;
use std::time::Instant;

fn baseline(names: &[String]) -> Vec<String> {
    names
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(64)
        .collect()
}

fn borrowed(names: &[String]) -> Vec<String> {
    names
        .iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(64)
        .cloned()
        .collect()
}

fn bounded(names: &[String]) -> Vec<String> {
    let mut selected = BTreeSet::new();
    for value in names {
        if selected.len() == 64 && selected.last().is_some_and(|last| value >= *last) {
            continue;
        }
        selected.insert(value);
        if selected.len() > 64 {
            selected.pop_last();
        }
    }
    selected.into_iter().cloned().collect()
}

fn main() {
    for count in [64, 512, 4096, 65536] {
        for distribution in ["ascending", "descending", "shuffled", "duplicates"] {
            let names: Vec<_> = (0..count)
                .map(|i| {
                    let key = match distribution {
                        "ascending" => i,
                        "descending" => count - i,
                        "shuffled" => (i * 7919) % count,
                        _ => i % 32,
                    };
                    format!("GenericProperty{key:06}")
                })
                .collect();
            let expected = baseline(&names);
            let repeats = (131072 / count).max(8);
            for (name, select) in [
                ("clone_all", baseline as fn(&[String]) -> Vec<String>),
                ("borrow_all", borrowed),
                ("borrow_bounded", bounded),
            ] {
                assert_eq!(expected, select(&names));
                let mut samples = Vec::new();
                for _ in 0..7 {
                    let start = Instant::now();
                    for _ in 0..repeats {
                        black_box(select(black_box(&names)));
                    }
                    samples.push(start.elapsed().as_nanos() as f64 / repeats as f64);
                }
                println!("{{\"names\":{count},\"distribution\":\"{distribution}\",\"algorithm\":\"{name}\",\"nanoseconds\":{samples:?}}}");
            }
        }
    }
}
