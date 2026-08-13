import { describe, test, expect } from "bun:test";
import { US, splitFields } from "../tmux-fields";

describe("splitFields", () => {
  test("splits on the raw US byte (tmux 3.6 passes it through)", () => {
    expect(splitFields(["$1", "name", "running"].join(US))).toEqual([
      "$1",
      "name",
      "running",
    ]);
  });

  test("splits on tmux 3.4's octal-escaped separator (\\037)", () => {
    // tmux 3.4 emits the 4 literal chars `\037` in place of the raw 0x1F byte.
    const line = "$1\\037name\\037running";
    expect(splitFields(line)).toEqual(["$1", "name", "running"]);
  });

  test("handles a line that mixes both forms", () => {
    expect(splitFields("$1\\037name\x1frunning")).toEqual([
      "$1",
      "name",
      "running",
    ]);
  });

  test("preserves empty fields (unset tmux options render as '')", () => {
    expect(splitFields("$1\\037\\037running")).toEqual(["$1", "", "running"]);
    expect(splitFields("$1\x1f\x1frunning")).toEqual(["$1", "", "running"]);
  });

  test("a value with no separator returns a single field", () => {
    expect(splitFields("$1")).toEqual(["$1"]);
  });
});

// tmux 3.3a — Debian 12's and Ubuntu 22.04's build — rewrites *every*
// non-printable byte in a `-F` format to a single "_", so the separator never
// survives to be split on. Measured: 0x1F, 0x01 and even ␟ (U+241F, printable
// but multi-byte) all come back as "_", while a printable ASCII "~" passes
// through untouched. That is a third behaviour beside 3.4's octal escaping and
// 3.6+'s raw passthrough, and it collapsed every row into one field: the
// session name parsed as undefined and jmux died in boot on tq(undefined),
// exiting 0 with nothing on stderr.
describe("splitFields separator choice", () => {
  test("the separator is printable ASCII, or tmux 3.3a eats it", () => {
    expect(US.length).toBeGreaterThan(0);
    for (const ch of US) {
      const code = ch.charCodeAt(0);
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThan(0x7f);
    }
  });

  test("it carries no tmux format metacharacter", () => {
    // `#` introduces #{...} / #[...] expansion; braces close them.
    expect(US).not.toContain("#");
    expect(US).not.toContain("{");
    expect(US).not.toContain("}");
  });

  test("it cannot occur in a tmux session name", () => {
    // tmux rejects "." and ":" in session names and jmux sanitises them out,
    // so a separator containing ":" can never appear in the highest-risk
    // field — a name the user typed.
    expect(US).toContain(":");
  });

  test("splits a line the current separator produced", () => {
    expect(splitFields(["$1", "name", "running"].join(US))).toEqual(["$1", "name", "running"]);
  });

  test("still splits both legacy forms, so a running server mid-upgrade parses", () => {
    expect(splitFields("$1\x1fname\x1frunning")).toEqual(["$1", "name", "running"]);
    expect(splitFields("$1\\037name\\037running")).toEqual(["$1", "name", "running"]);
  });

  test("preserves empty fields on the current separator", () => {
    expect(splitFields(["$1", "", "running"].join(US))).toEqual(["$1", "", "running"]);
  });

  test("a value containing one separator component is not split on it", () => {
    // A path or title may well contain ":" or "|" alone; only the whole token
    // separates.
    const line = ["$1", "feat: add |pipe| support", "running"].join(US);
    expect(splitFields(line)).toEqual(["$1", "feat: add |pipe| support", "running"]);
  });
});
