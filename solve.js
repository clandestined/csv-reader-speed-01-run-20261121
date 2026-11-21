// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the
// same {text, header}: {columns, rows, errors}. Same broken-row policy:
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a
// line left with no characters is no record; outside quotes a CR not followed
// by LF is dropped (stray_cr); a field that opens with a quote runs to the
// next quote that is not doubled, "" inside it one quote and each CRLF or lone
// CR inside it read as LF; what follows its closing quote, up to the next
// comma or line break, is appended as it stands (quote_junk, when the field
// ends); a quote that never closes is a literal character and the text after
// it is read again as unquoted (unterminated_quote); a quote inside an
// unquoted field is a literal character; fields stay strings, never trimmed or
// converted; columns is the first record when header is true, else null; rows
// holds the records after it, each padded with "" (short_row) or cut
// (long_row) to the first record's width; each error is {code, line, row} in
// the order met, line the 1-based line its record starts on, row its record's
// index in rows (null for the header).
//
// Speed comes from never reading one character at a time on the common path:
// a run of unquoted fields is split in one go, and a quoted field is cut out
// with a jump to its closing quote. A ',"' can only sit at a field boundary
// (a comma ends an unquoted field, so no unquoted field holds one, and a
// quote after a comma opens a quoted field), so the run from a field start to
// the next ',"' or line break holds whole unquoted fields only. All string
// work is slice/indexOf/split on the one input string; nothing is kept from
// one call to the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const len = text.length;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors raised while reading it use these.
  let recordLine = 1;
  let recordRow = null;

  // The result of scanUnquoted, reused so no array is made per field.
  const scanOut = ['', 0];

  // Reads unquoted characters onto `base` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Writes
  // [value, ended] into scanOut and returns it. `base` never holds a CR (a
  // quoted value has them read as LF, '"' has none), so the CR search starts
  // past it.
  function scanUnquoted(base) {
    const comma = text.indexOf(',', pos);
    const nl = text.indexOf('\n', pos);
    let end;
    let ended;
    if (comma === -1) {
      if (nl === -1) {
        end = len;
        ended = END;
      } else {
        end = nl;
        ended = LINE_BREAK;
      }
    } else if (nl === -1) {
      end = comma;
      ended = COMMA;
    } else if (comma < nl) {
      end = comma;
      ended = COMMA;
    } else {
      end = nl;
      ended = LINE_BREAK;
    }
    let value = base === '' ? text.slice(pos, end) : base + text.slice(pos, end);
    const cr = value.indexOf('\r', base.length);
    if (cr !== -1) {
      // Every CR in the kept part is a lone one, except a trailing CR just
      // before the LF that ends the field: that one is the CRLF line break.
      let count = 0;
      for (let i = cr; i < value.length; i++) {
        if (value.charCodeAt(i) === 13) count++;
      }
      const trailingCRLF = ended === LINE_BREAK && value.charCodeAt(value.length - 1) === 13;
      const stray = count - (trailingCRLF ? 1 : 0);
      for (let i = 0; i < stray; i++) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      value = value.replaceAll('\r', '');
    }
    if (ended === COMMA) {
      pos = end + 1;
    } else if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else {
      pos = len;
    }
    scanOut[0] = value;
    scanOut[1] = ended;
    return scanOut;
  }

  // Files one record's fields away: the header, the padding/cutting to the
  // first record's width, and the short_row / long_row errors. A record that
  // held only one empty unquoted field is no record at all.
  function finishRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let lastQuoted = false;
    let recordDone = false;
    while (!recordDone) {
      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        // The closing quote: the next quote that is not doubled.
        let q = text.indexOf('"', pos + 1);
        let escaped = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          escaped = true;
          q = text.indexOf('"', q + 2);
        }
        let value;
        let ended;
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = scanUnquoted('"');
          value = r[0];
          ended = r[1];
        } else {
          if (!escaped) {
            value = text.slice(pos + 1, q);
          } else {
            const parts = [];
            let s = pos + 1;
            let p = text.indexOf('"', s);
            while (text.charCodeAt(p + 1) === 34) {
              parts.push(text.slice(s, p));
              parts.push('"');
              s = p + 2;
              p = text.indexOf('"', s);
            }
            parts.push(text.slice(s, q));
            value = parts.join('');
          }
          // Each CRLF or lone CR inside quotes is read as LF.
          if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
            let out = '';
            let breaks = 0;
            let start = 0;
            for (let i = 0; i < value.length; i++) {
              const cc = value.charCodeAt(i);
              if (cc === 13) {
                out += value.slice(start, i) + '\n';
                breaks += 1;
                if (value.charCodeAt(i + 1) === 10) i += 1;
                start = i + 1;
              } else if (cc === 10) {
                out += value.slice(start, i) + '\n';
                breaks += 1;
                start = i + 1;
              }
            }
            out += value.slice(start);
            value = out;
            line += breaks;
          }
          pos = q + 1;
          if (pos >= len) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              const before = value.length;
              const r = scanUnquoted(value);
              value = r[0];
              ended = r[1];
              if (value.length - before > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
        }
        fields.push(value);
        if (ended !== COMMA) recordDone = true;
      } else {
        // A run of unquoted fields, up to the next quoted field (',"'), the
        // next line break, or the end of the text.
        lastQuoted = false;
        const cq = text.indexOf(',"', pos);
        const nn = text.indexOf('\n', pos);
        let runEnd;
        let runKind; // 0: a quoted field follows, 1: line break, 2: end
        if (cq === -1) {
          if (nn === -1) {
            runEnd = len;
            runKind = 2;
          } else {
            runEnd = nn;
            runKind = 1;
          }
        } else if (nn === -1) {
          runEnd = cq;
          runKind = 0;
        } else if (cq < nn) {
          runEnd = cq;
          runKind = 0;
        } else {
          runEnd = nn;
          runKind = 1;
        }
        let segEnd = runEnd;
        // A trailing CR just before the line break is the CRLF break, not
        // part of a field.
        if (runKind === 1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
        const seg = text.slice(pos, segEnd);
        if (seg.indexOf('\r') !== -1) {
          // A stray CR sits in the run: fall back to one field at a time,
          // which drops each stray CR with its error.
          const r = scanUnquoted('');
          fields.push(r[0]);
          if (r[1] !== COMMA) recordDone = true;
          continue;
        }
        const runFields = seg.split(',');
        // Spread is the fast push, but a huge run would overflow the call
        // stack, so long runs push one field at a time.
        if (runFields.length < 1000) fields.push(...runFields);
        else for (let i = 0; i < runFields.length; i++) fields.push(runFields[i]);
        if (runKind === 0) {
          pos = cq + 1;
        } else if (runKind === 1) {
          pos = nn + 1;
          line += 1;
          recordDone = true;
        } else {
          pos = len;
          recordDone = true;
        }
      }
    }
    finishRecord(fields, lastQuoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
