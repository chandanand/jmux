/**
 * Field separator for structured tmux `-F` output, plus a splitter that
 * tolerates every form tmux has emitted it in.
 *
 * We build `-F` format strings by joining field expansions with a separator,
 * then split on an exact field count with no rejoin gymnastics. The catch —
 * and the reason this lives in one shared module — is that **tmux does not
 * round-trip a separator uniformly across versions**, and it has now done
 * three different things with the ASCII Unit Separator (0x1F) this module
 * originally used:
 *
 *  - **3.6+** passes the raw 0x1F through untouched.
 *  - **3.4** (Ubuntu 24.04) escapes it to the 4-character octal text `\037`.
 *    A parser splitting on the raw byte alone found no separator and silently
 *    dropped every row — GitHub issue #7.
 *  - **3.3a** (Debian 12, Ubuntu 22.04) rewrites *any* non-printable byte to a
 *    single `_`. Measured: 0x1F, 0x01, and even `␟` (U+241F — printable, but
 *    multi-byte) all come back as `_`, while printable ASCII passes through.
 *    Nothing survives to split on, so a whole row parsed as one field, the
 *    session name came back `undefined`, and jmux died during boot inside
 *    `tq(undefined)` — exiting 0 with nothing on stderr.
 *
 * So the separator is **printable ASCII**, which is the only class all three
 * agree to leave alone. `:|:` rather than a single character because it has to
 * be absent from arbitrary user data: `pane_current_path`, a model-generated
 * session title, an issue identifier. The `:` is load-bearing — tmux rejects
 * `:` in session names and `sanitizeTmuxSessionName` strips it, so the token
 * cannot occur in the one field that is raw user input. It carries no `#`, `{`
 * or `}`, which would be read as format expansion rather than literal text.
 *
 * {@link splitFields} still accepts both legacy forms, so a control client
 * talking to a server started by an older jmux keeps parsing.
 *
 * Note this only normalises the *separator*; field values are passed through
 * verbatim. A value containing a literal `:|:` is as unrealistic as one
 * containing a raw 0x1F, so we do not attempt general un-escaping (which would
 * corrupt paths that legitimately contain backslashes).
 */
export const US = ":|:";

/**
 * The current separator, plus the raw US byte (3.6+) and the octal-escaped text
 * (3.4) that earlier jmux builds emitted. `\|` is escaped — bare `|` is regex
 * alternation, which would split on every colon and pipe in the line.
 */
const FIELD_SEP = /:\|:|\x1f|\\037/;

/** Split one tmux `-F` output line into its fields, on any separator jmux has used. */
export function splitFields(line: string): string[] {
  return line.split(FIELD_SEP);
}
