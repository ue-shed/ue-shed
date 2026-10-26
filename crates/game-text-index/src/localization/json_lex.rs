// packages/game-text/src/localization-stream.ts:184-375: keep scanner boundaries and offsets.
struct Record {
    raw: String,
    units: usize,
    depth: usize,
    quoted: bool,
    escaped: bool,
}
impl Parser<'_> {
    fn charge(&mut self, bytes: usize) -> Parsed<()> {
        for frame in self
            .frames
            .iter_mut()
            .rev()
            .take_while(|f| f.mode == Mode::Value)
        {
            frame.bytes += bytes;
            if frame.bytes > self.limits.max_record_bytes {
                return Err(self.error("limit_exceeded"));
            }
        }
        Ok(())
    }
    fn finish_token(&mut self) -> Parsed<()> {
        let token = std::mem::take(&mut self.lex_token);
        let value = self.token(&token, self.offset - self.lex_units)?;
        self.emit(value, 0)?;
        self.lex_units = 0;
        Ok(())
    }
    fn feed(&mut self, text: &str) -> Parsed<()> {
        let chars = text.chars().collect::<Vec<_>>();
        let mut index = 0;
        while index < chars.len() {
            let c = chars[index];
            self.offset += c.len_utf16();
            if let Some(mut current) = self.lex_record.take() {
                let start = index;
                let mut end = index;
                while end < chars.len() {
                    if current.quoted {
                        if current.escaped {
                            current.escaped = false;
                            end += 1;
                            continue;
                        }
                        let stop = (end..chars.len())
                            .find(|i| matches!(chars[*i], '"' | '\\' | '\u{0}'..='\u{1f}'));
                        let Some(stop) = stop else {
                            end = chars.len();
                            break;
                        };
                        end = stop + 1;
                        match chars[stop] {
                            '\\' => current.escaped = true,
                            '"' => current.quoted = false,
                            _ => return Err(self.error("malformed_json")),
                        }
                    } else {
                        let stop = (end..chars.len())
                            .find(|i| matches!(chars[*i], '{' | '[' | '}' | ']' | '"'));
                        let next = stop.unwrap_or(chars.len());
                        if self.frames.len() + current.depth > self.limits.max_depth
                            && chars[end..next]
                                .iter()
                                .any(|c| !matches!(c, ':' | ',' | ' ' | '\t' | '\r' | '\n'))
                        {
                            return Err(self.error("limit_exceeded"));
                        }
                        if stop.is_none() {
                            end = chars.len();
                            break;
                        }
                        end = next + 1;
                        match chars[next] {
                            '"' => {
                                if self.frames.len() + current.depth > self.limits.max_depth {
                                    return Err(self.error("limit_exceeded"));
                                }
                                current.quoted = true;
                            }
                            '{' | '[' => {
                                current.depth += 1;
                                if self.frames.len() + current.depth - 1 > self.limits.max_depth {
                                    return Err(self.error("limit_exceeded"));
                                }
                            }
                            _ => {
                                current.depth -= 1;
                                if current.depth == 0 {
                                    break;
                                }
                            }
                        }
                    }
                }
                let units = chars[start..end]
                    .iter()
                    .map(|c| c.len_utf16())
                    .sum::<usize>();
                current.raw.extend(&chars[start..end]);
                current.units += units;
                self.offset += units - c.len_utf16();
                index = end;
                if current.units * 2 > self.limits.max_record_bytes {
                    return Err(self.error("limit_exceeded"));
                }
                if current.depth == 0 {
                    let value = self.token(&current.raw, self.offset - current.units)?;
                    self.accept(value)?;
                } else {
                    self.lex_record = Some(current);
                }
                continue;
            }
            if !self.lex_quoted
                && self.lex_token.is_empty()
                && matches!(c, ' ' | '\t' | '\r' | '\n')
            {
                let end = (index..chars.len())
                    .find(|i| !matches!(chars[*i], ' ' | '\t' | '\r' | '\n'))
                    .unwrap_or(chars.len());
                self.charge((end - index) * 2)?;
                self.offset += end - index - 1;
                index = end;
                continue;
            }
            if !self.lex_quoted
                && matches!(c, '{' | '[')
                && self.frames.last().is_some_and(|p| p.mode == Mode::Children)
            {
                if !self.lex_token.is_empty()
                    || self
                        .frames
                        .last()
                        .is_none_or(|p| !matches!(p.state, State::First | State::Value))
                {
                    return Err(self.error("malformed_json"));
                }
                if self.frames.len() > self.limits.max_depth {
                    return Err(self.error("limit_exceeded"));
                }
                self.lex_record = Some(Record {
                    raw: c.into(),
                    units: 1,
                    depth: 1,
                    quoted: false,
                    escaped: false,
                });
                index += 1;
                continue;
            }
            self.charge(c.len_utf16() * 2)?;
            if self.lex_quoted {
                if self.lex_escaped {
                    self.lex_token.push(c);
                    self.lex_units += c.len_utf16();
                    self.lex_escaped = false;
                } else if c == '\\' {
                    self.lex_token.push(c);
                    self.lex_units += 1;
                    self.lex_escaped = true;
                } else if c == '"' {
                    self.lex_token.push(c);
                    self.lex_units += 1;
                    self.lex_quoted = false;
                    self.finish_token()?;
                } else {
                    if c < ' ' {
                        return Err(self.error("malformed_json"));
                    }
                    let end = (index + 1..chars.len())
                        .find(|i| matches!(chars[*i], '"' | '\\' | '\u{0}'..='\u{1f}'))
                        .unwrap_or(chars.len());
                    let units = chars[index..end]
                        .iter()
                        .map(|c| c.len_utf16())
                        .sum::<usize>();
                    self.lex_token.extend(&chars[index..end]);
                    self.lex_units += units;
                    self.charge((units - c.len_utf16()) * 2)?;
                    self.offset += units - c.len_utf16();
                    index = end - 1;
                }
            } else if c == '"' {
                if !self.lex_token.is_empty() {
                    return Err(self.error("malformed_json"));
                }
                self.lex_quoted = true;
                self.lex_token.push(c);
                self.lex_units = 1;
            } else if "{}[],: \t\r\n".contains(c) {
                if !self.lex_token.is_empty() {
                    self.finish_token()?;
                }
                if "{}[],:".contains(c) {
                    self.emit(Value::Null, c as u8)?;
                }
            } else {
                self.lex_token.push(c);
                self.lex_units += c.len_utf16();
            }
            if self.lex_units * 2 > self.limits.max_record_bytes {
                return Err(self.error("limit_exceeded"));
            }
            index += 1;
        }
        Ok(())
    }
}
