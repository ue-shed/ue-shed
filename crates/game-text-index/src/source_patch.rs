//! Splice bounded variable-length source lists over an immutable projection.
use crate::{Result, require};

pub(crate) fn splice(
    original: [&[u32]; 3],
    rows: &[u32],
    starts: &[u32],
    values: &[u32],
) -> Result<[Vec<u32>; 3]> {
    require(
        rows.len() <= 8192
            && values.len() <= 8192
            && starts.len() == rows.len() + 1
            && starts.first() == Some(&0)
            && starts.last().copied() == Some(values.len() as u32),
        "Invalid source-list patch lengths.",
    )?;
    require(
        original[0].len() == original[1].len(),
        "Invalid source-list base.",
    )?;
    let mut out_starts = Vec::with_capacity(original[0].len());
    let mut out_ends = Vec::with_capacity(original[0].len());
    let mut out_values = Vec::new();
    let mut patch_index = 0;
    let mut position = 0;
    for row in 0..original[0].len() {
        let end = original[1][row] as usize;
        require(
            original[0][row] as usize == position && end >= position && end <= original[2].len(),
            "Invalid base source ranges.",
        )?;
        out_starts.push(u32::try_from(out_values.len())?);
        if rows.get(patch_index).copied() == Some(row as u32) {
            require(
                patch_index == 0 || rows[patch_index - 1] < rows[patch_index],
                "Invalid source patch ordering.",
            )?;
            let start = starts[patch_index] as usize;
            let end = starts[patch_index + 1] as usize;
            require(
                start < end && end <= values.len(),
                "Invalid source patch range.",
            )?;
            out_values.extend_from_slice(&values[start..end]);
            patch_index += 1;
        } else {
            out_values.extend_from_slice(&original[2][position..end]);
        }
        out_ends.push(u32::try_from(out_values.len())?);
        position = end;
    }
    require(
        position == original[2].len() && patch_index == rows.len(),
        "Source patch does not cover valid rows.",
    )?;
    Ok([out_starts, out_ends, out_values])
}
