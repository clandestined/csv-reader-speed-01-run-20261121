[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/clandestined/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/clandestined/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# csv-reader-speed-01-run-20261121

A faster drop-in for make.fun's own csv-reader 1.0.0: it reads broken CSV
files faster and answers exactly as csv-reader does on every case.

## The entry

- `solve.js` — a dependency-free ES module. `run(input)` returns csv-reader's
  reading of `{text, header}`: `{columns, rows, errors}`.
- `main.ts` — the program the harness runs: it reads every case from
  `/input/cases.json`, answers each with `run`, and writes
  `/output/answers.json`.

## How it is faster

csv-reader reads one character at a time and builds each field up a
character at a time. This reader never does that on the common path:

- A record with no quote and no stray CR is split in one go (`split(',')`).
- Every other field is cut out with `indexOf` jumps to its next delimiter
  (comma, LF, or a CR handled as the reference handles it) instead of being
  built up character by character, and quoted fields are cut out with a
  jump to their closing quote.
- All string work is `slice`/`indexOf` on the one input string; nothing is
  kept from one call to the next, and every answer is deterministic.

## Correctness

The reader follows csv-reader 1.0.0's broken-row policy exactly: BOM dropped,
LF/CRLF record ends, empty lines are no records, stray CRs dropped with a
`stray_cr` error, quoted fields with `""` escapes and CRLF/lone CR read as
LF, characters after a closing quote appended as `quote_junk`, an
unterminated quote read again as an unquoted field (`unterminated_quote`),
quotes inside unquoted fields literal, fields kept as strings, rows padded
(`short_row`) or cut (`long_row`) to the first record's width, and errors in
the order met with the line the record starts on.

Verified against the reference on the kit's practice set (6 cases, all
identical) and against a differential fuzzer that compares this reader with
csv-reader 1.0.0 on thousands of generated broken inputs.

## License

MIT. See [LICENSE](LICENSE).
