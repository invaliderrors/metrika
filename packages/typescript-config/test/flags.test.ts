import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

async function compileFixtures(): Promise<string> {
  try {
    await run("pnpm", [
      "exec",
      "tsc",
      "-p",
      "test/tsconfig.fixtures.json",
      "--noEmit",
    ]);
    return "";
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

describe("base tsconfig strict flags", () => {
  it.each([
    ["noUncheckedIndexedAccess", "unchecked-index.ts", "TS18048"],
    ["exactOptionalPropertyTypes", "exact-optional.ts", "TS2375"],
    ["noImplicitReturns", "implicit-returns.ts", "TS7030"],
  ])("%s rejects its fixture", async (_flag, file, code) => {
    const output = await compileFixtures();
    expect(output).toContain(file);
    expect(output).toContain(code);
  });
});
