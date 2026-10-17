//! Server-sent events, parsed as the TypeScript worker does: lines end in
//! `\n`, `\r` or `\r\n`, invalid UTF-8 becomes U+FFFD, an event is
//! dispatched on a blank line if it has data, and any `retry:` line ends
//! the stream. (`eventsource-stream` stalls on invalid UTF-8 and has no size
//! limit.)

/// Larger pending events fail the stream rather than grow without bound.
const MAX_EVENT_SIZE: usize = 10 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Data(String),
    Retry,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TooLarge;

#[derive(Debug, Default)]
pub(crate) struct Parser {
    /// Bytes after the last line ending.
    line: Vec<u8>,
    data: Option<String>,
    /// The previous chunk ended in `\r`, so a leading `\n` isn't a new line.
    after_cr: bool,
    started: bool,
}

impl Parser {
    /// Feeds a chunk of the body, appending any events it completes.
    pub fn push(&mut self, mut chunk: &[u8], events: &mut Vec<Event>) -> Result<(), TooLarge> {
        if chunk.is_empty() {
            return Ok(());
        }
        if std::mem::take(&mut self.after_cr) && chunk.first() == Some(&b'\n') {
            chunk = &chunk[1..];
        }
        while let Some(end) = chunk.iter().position(|&b| b == b'\n' || b == b'\r') {
            self.line.extend_from_slice(&chunk[..end]);
            let crlf = chunk[end] == b'\r' && chunk.get(end + 1) == Some(&b'\n');
            if chunk[end] == b'\r' && end + 1 == chunk.len() {
                self.after_cr = true;
            }
            chunk = &chunk[end + if crlf { 2 } else { 1 }..];
            let line = std::mem::take(&mut self.line);
            self.line_ended(&line, events);
        }
        self.line.extend_from_slice(chunk);
        let pending = self.line.len() + self.data.as_ref().map_or(0, String::len);
        if pending > MAX_EVENT_SIZE { Err(TooLarge) } else { Ok(()) }
    }

    fn line_ended(&mut self, line: &[u8], events: &mut Vec<Event>) {
        // Lines split only at ASCII bytes, so no UTF-8 sequence is cut.
        let mut line = String::from_utf8_lossy(line);
        if !std::mem::replace(&mut self.started, true)
            && let Some(rest) = line.strip_prefix('\u{feff}')
        {
            line = rest.to_owned().into();
        }
        if line.is_empty() {
            if let Some(data) = self.data.take().filter(|data| !data.is_empty()) {
                events.push(Event::Data(data));
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = line.split_once(':').unwrap_or((&line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_owned()),
            },
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                events.push(Event::Retry);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(chunks: &[&[u8]]) -> Vec<Event> {
        let mut parser = Parser::default();
        let mut events = Vec::new();
        for chunk in chunks {
            parser.push(chunk, &mut events).unwrap();
        }
        events
    }

    fn data(text: &str) -> Event {
        Event::Data(text.to_owned())
    }

    #[test]
    fn events_end_at_blank_lines_whatever_the_line_endings() {
        assert_eq!(
            parse(&[
                b"\xef\xbb\xbfdata: a\r\n\r\ndata:b\rdata: c\r",
                b"\n\r\n: comment\nevent: x\ndata: d\n\n"
            ]),
            [data("a"), data("b\nc"), data("d")]
        );
    }

    #[test]
    fn invalid_utf8_is_replaced_not_fatal() {
        assert_eq!(
            parse(&[b"data: \xff\xe2\x82", b"\xac\n\n", b"data: ok\n\n"]),
            [data("\u{fffd}€"), data("ok")]
        );
    }

    #[test]
    fn empty_events_and_unterminated_ones_are_dropped() {
        assert_eq!(parse(&[b"data:\n\n\n", b"data: never ended"]), []);
    }

    #[test]
    fn a_retry_line_is_reported_in_order() {
        assert_eq!(
            parse(&[b"data: a\n\nretry: 10\ndata: b\n\n"]),
            [data("a"), Event::Retry, data("b")]
        );
        assert_eq!(parse(&[b"retry: soon\n\n"]), []);
    }

    #[test]
    fn oversized_events_fail() {
        let mut parser = Parser::default();
        let big = vec![b'x'; MAX_EVENT_SIZE + 1];
        assert_eq!(parser.push(&big, &mut Vec::new()), Err(TooLarge));
    }
}
