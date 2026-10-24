import { describe, expect, it } from "vitest";
import { compareRaw, exactPin, maxVersion, parseSpecifiers, parseVersion, satisfies } from "../src/core/pep440";

const sat = (v: string, spec: string) => satisfies(v, parseSpecifiers(spec)!);

describe("pep440 versions", () => {
  it("parses and orders versions", () => {
    expect(parseVersion("1.0")).toBeDefined();
    expect(parseVersion("not a version")).toBeUndefined();
    const sorted = ["1.0.post1", "1.0", "1.0rc1", "1.0a1", "1.0.dev1", "0.9", "1!0.1", "1.0b2"].sort(compareRaw);
    expect(sorted).toEqual(["0.9", "1.0.dev1", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1", "1!0.1"]);
    expect(compareRaw("1.0", "1.0.0")).toBe(0);
    expect(compareRaw("v2.0", "2.0")).toBe(0);
    expect(maxVersion(["1.2", "1.10", "1.9"])).toBe("1.10");
  });
});

describe("pep440 specifiers", () => {
  it("handles comparison operators", () => {
    expect(sat("2.31.0", ">=2.0,<3")).toBe(true);
    expect(sat("3.0", ">=2.0,<3")).toBe(false);
    expect(sat("1.5", "!=1.5")).toBe(false);
    expect(sat("1.5.1", "==1.5.*")).toBe(true);
    expect(sat("1.6", "==1.5.*")).toBe(false);
    expect(sat("2.2", "~=2.2")).toBe(true);
    expect(sat("2.9", "~=2.2")).toBe(true);
    expect(sat("3.0", "~=2.2")).toBe(false);
    expect(sat("1.4.9", "~=1.4.5")).toBe(true);
    expect(sat("1.5.0", "~=1.4.5")).toBe(false);
    expect(sat("1.0", "")).toBe(true);
    expect(sat("1.0", "===1.0")).toBe(true);
  });
  it("excludes pre-releases unless asked for", () => {
    expect(sat("2.0rc1", ">=1.0")).toBe(false);
    expect(sat("2.0rc1", ">=2.0rc1")).toBe(true);
  });
  it("supports Poetry constraints", () => {
    expect(sat("1.9.0", "^1.2")).toBe(true);
    expect(sat("2.0.0", "^1.2")).toBe(false);
    expect(sat("0.2.5", "^0.2.3")).toBe(true);
    expect(sat("0.3.0", "^0.2.3")).toBe(false);
    expect(sat("1.2.9", "~1.2.3")).toBe(true);
    expect(sat("1.3.0", "~1.2.3")).toBe(false);
    expect(sat("5.0", "*")).toBe(true);
    expect(sat("1.5", "^1.0 || ^3.0")).toBe(true);
    expect(sat("2.5", "^1.0 || ^3.0")).toBe(false);
    expect(sat("1.2.3", "1.2.3")).toBe(true);
  });
  it("detects exact pins", () => {
    expect(exactPin(parseSpecifiers("==1.2.3")!)).toBe("1.2.3");
    expect(exactPin(parseSpecifiers(">=1.2")!)).toBeUndefined();
  });
  it("rejects garbage", () => {
    expect(parseSpecifiers(">=what ever")).toBeUndefined();
  });
});
