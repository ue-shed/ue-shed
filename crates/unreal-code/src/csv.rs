//! `FCsvParser`, the reader String Table CSVs go through.
//!
//! Unreal parses in place: a quoted cell is unquoted by writing over its own characters, and a
//! cell ends at the first NUL written into it. The port keeps the same buffer walk, so stray
//! text after a closing quote and doubled quotes come out the way Unreal reads them.

use crate::wide::{QUOTE, Wide};

const CR: u16 = 0x0D;
const LF: u16 = 0x0A;
const COMMA: u16 = b',' as u16;

pub(crate) type Row = Vec<Wide>;

#[derive(PartialEq, Eq)]
enum End {
    Cell,
    Row,
    Text,
}

struct Parser {
    buffer: Wide,
    read: usize,
    rows: Vec<Vec<usize>>,
}

impl Parser {
    fn new_line(&self, at: usize) -> usize {
        match self.buffer[at] {
            CR if self.buffer[at + 1] == LF => 2,
            CR | LF => 1,
            _ => 0,
        }
    }

    fn end_after(&self) -> End {
        if self.buffer[self.read] != 0 {
            End::Row
        } else {
            End::Text
        }
    }

    fn row(&mut self) -> End {
        let size = self.new_line(self.read);
        if size > 0 {
            self.read += size;
            return self.end_after();
        }
        self.rows.push(Vec::new());
        loop {
            let end = self.cell();
            if end != End::Cell {
                return end;
            }
        }
    }

    fn cell(&mut self) -> End {
        let mut write = self.read;
        let mut quoted = self.buffer[self.read] == QUOTE;
        if quoted {
            write += 1;
            self.read = write;
        }
        let start = self.read;
        if let Some(row) = self.rows.last_mut() {
            row.push(start);
        }
        while self.buffer[self.read] != 0 {
            if quoted {
                if self.buffer[self.read] == QUOTE {
                    // RFC 4180 escapes a quote as two.
                    while self.buffer[self.read] == QUOTE {
                        self.read += 1;
                        quoted = !quoted;
                        if quoted {
                            self.buffer[write] = QUOTE;
                            write += 1;
                        }
                    }
                    self.buffer[write] = 0;
                    continue;
                }
            } else {
                let size = self.new_line(self.read);
                if size != 0 {
                    self.buffer[write] = 0;
                    self.read += size;
                    return self.end_after();
                } else if self.buffer[self.read] == COMMA {
                    self.buffer[write] = 0;
                    self.read += 1;
                    return End::Cell;
                }
            }
            if write != self.read {
                self.buffer[write] = self.buffer[self.read];
                write += 1;
                self.read += 1;
            } else {
                write += 1;
                self.read = write;
            }
        }
        End::Text
    }
}

pub(crate) fn parse(text: &[u16]) -> Vec<Row> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut buffer: Wide = text.to_vec();
    // The terminator, and one more unit so a lone CR at the end can look past itself.
    buffer.extend([0, 0]);
    let mut parser = Parser {
        buffer,
        read: 0,
        rows: Vec::new(),
    };
    while parser.row() != End::Text {}
    let Parser { buffer, rows, .. } = parser;
    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|start| {
                    let end = buffer[start..]
                        .iter()
                        .position(|&unit| unit == 0)
                        .map_or(buffer.len(), |at| at + start);
                    buffer[start..end].to_vec()
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wide::{narrow, wide};

    fn rows(text: &str) -> Vec<Vec<String>> {
        parse(&wide(text))
            .into_iter()
            .map(|row| row.iter().map(|cell| narrow(cell)).collect())
            .collect()
    }

    #[test]
    fn reads_cells_rows_and_quotes() {
        assert_eq!(
            rows("Key,SourceString\r\nA,\"Hello, \"\"world\"\"\"\nB,Plain\n"),
            [
                vec!["Key", "SourceString"],
                vec!["A", "Hello, \"world\""],
                vec!["B", "Plain"]
            ]
        );
    }

    #[test]
    fn keeps_a_trailing_empty_cell_and_skips_empty_lines() {
        assert_eq!(rows("a,\n\nb"), [vec!["a", ""], vec!["b"]]);
    }

    #[test]
    fn joins_text_after_a_closing_quote() {
        assert_eq!(rows("\"ab\"cd,e"), [vec!["abcd", "e"]]);
        // At the very end nothing terminates the shifted cell, so Unreal reads a stale unit too.
        assert_eq!(rows("\"ab\"c"), [vec!["abcc"]]);
    }
}
