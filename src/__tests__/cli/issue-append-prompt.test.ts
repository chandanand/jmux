import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSeedPrompt,
  MAX_SEED_PROMPT_BYTES,
  assertSeedPromptFits,
  readContractFile,
  assertLaunchAgentForContract,
} from "../../cli/issue";

function writeTemp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jmux-append-prompt-"));
  const path = join(dir, "contract.md");
  writeFileSync(path, contents, "utf-8");
  return path;
}

describe("buildSeedPrompt", () => {
  test("the contract goes after the issue text, separated by a blank line", () => {
    expect(buildSeedPrompt("ISSUE", "CONTRACT")).toBe("ISSUE\n\nCONTRACT");
  });

  test("the issue prompt does not already end in a separator, so one is added", () => {
    // A direct concatenation would produce "ISSUECONTRACT".
    expect(buildSeedPrompt("ISSUE", "CONTRACT")).toContain("ISSUE\n\nCONTRACT");
  });

  test("a contract with no issue still produces a prompt", () => {
    // Today a prompt file is written only when an issue resolved. The contract
    // must survive the case where there is none.
    expect(buildSeedPrompt(null, "CONTRACT")).toBe("CONTRACT");
  });

  test("an issue with no contract is unchanged", () => {
    expect(buildSeedPrompt("ISSUE", null)).toBe("ISSUE");
  });
});

describe("the size limit is enforced before anything is created", () => {
  test("a prompt at the limit is allowed", () => {
    const contract = "x".repeat(MAX_SEED_PROMPT_BYTES - 1);
    expect(() => assertSeedPromptFits(buildSeedPrompt(null, contract))).not.toThrow();
  });

  test("a prompt over the limit is refused, naming the size and the limit", () => {
    // The whole prompt becomes one positional argument to the agent command, so
    // an oversized prompt fails the launch and leaves a bare shell in the pane.
    const contract = "x".repeat(MAX_SEED_PROMPT_BYTES + 1);
    expect(() => assertSeedPromptFits(buildSeedPrompt(null, contract))).toThrow(/prompt/i);
  });

  test("the limit counts bytes, not characters", () => {
    // A multi-byte character must not slip past a length check.
    const contract = "é".repeat(MAX_SEED_PROMPT_BYTES);
    expect(() => assertSeedPromptFits(buildSeedPrompt(null, contract))).toThrow();
  });
});

describe("reading the contract file", () => {
  test("a missing file is refused, naming the path", () => {
    expect(() => readContractFile("/nope/does-not-exist")).toThrow(/\/nope\/does-not-exist/);
  });

  test("an empty file is refused", () => {
    // An empty contract is indistinguishable from a bug, and the orchestrator
    // never means to inject nothing.
    const p = writeTemp("");
    expect(() => readContractFile(p)).toThrow(/empty/i);
  });

  test("a whitespace-only file is refused", () => {
    expect(() => readContractFile(writeTemp("   \n  \n"))).toThrow(/empty/i);
  });
});

describe("the contract requires an agent to receive it", () => {
  test("refused when the effective launch value is false", () => {
    // Not merely --no-launch-agent: launchAgent already folds in the repo's
    // autoLaunchAgent setting, and either one being false means there is no
    // agent to deliver the contract to.
    expect(() => assertLaunchAgentForContract(false, "/tmp/c.md")).toThrow(/launch/i);
  });

  test("allowed when the effective launch value is true", () => {
    expect(() => assertLaunchAgentForContract(true, "/tmp/c.md")).not.toThrow();
  });
});
