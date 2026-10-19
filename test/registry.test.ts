import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRegistryUrl, packumentUrl, registryFor } from "../src/core/registryUrl";
import { Limiter } from "../src/core/limiter";
import { RegistryClient, extractTimes } from "../src/registryClient";
import { formatAge, formatThreshold } from "../src/core/duration";
import { extractDependencies } from "../src/documentModel";

describe("registry URL safety", () => {
  it("accepts https and normalises the trailing slash", () => {
    const r = checkRegistryUrl("https://mirror.example.com/npm", []);
    expect(r.ok && r.url.toString()).toBe("https://mirror.example.com/npm/");
  });
  it("rejects plain http unless allow-listed", () => {
    expect(checkRegistryUrl("http://evil.example.com/", ["localhost"]).ok).toBe(false);
    expect(checkRegistryUrl("http://localhost:4873/", ["localhost"]).ok).toBe(true);
  });
  it("rejects embedded credentials and odd protocols", () => {
    expect(checkRegistryUrl("https://user:pw@r.example.com/", []).ok).toBe(false);
    expect(checkRegistryUrl("file:///etc/passwd", []).ok).toBe(false);
    expect(checkRegistryUrl("not a url", []).ok).toBe(false);
  });
  it("builds packument URLs for scoped packages and rejects path tricks", () => {
    const base = new URL("https://registry.npmjs.org/");
    expect(packumentUrl(base, "@types/node")).toBe("https://registry.npmjs.org/@types%2Fnode");
    expect(packumentUrl(new URL("https://r.example.com/api/npm/"), "react")).toBe("https://r.example.com/api/npm/react");
    expect(() => packumentUrl(base, "../../admin")).toThrow();
    expect(() => packumentUrl(base, "a/b/c")).toThrow();
  });
  it("routes scoped packages to scoped registries", () => {
    const choice = { base: "https://registry.npmjs.org/", scoped: { "@corp": "https://npm.corp.example.com/" } };
    expect(registryFor("@corp/ui", choice)).toBe("https://npm.corp.example.com/");
    expect(registryFor("react", choice)).toBe("https://registry.npmjs.org/");
  });
});

describe("Limiter", () => {
  it("never exceeds the concurrency limit", async () => {
    const lim = new Limiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        lim.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });
});

describe("RegistryClient", () => {
  afterEach(() => vi.unstubAllGlobals());
  const packument = { "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": "2026-01-01T00:00:00.000Z" }, versions: { "1.0.0": {} } };
  const opts = (offline = false) => ({ ttlMs: () => 60_000, offline: () => offline, timeoutMs: () => 1000, concurrency: () => 2, log: () => {} });

  it("caches and de-duplicates requests, without sending credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(packument), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new RegistryClient(opts());
    await Promise.all([c.get("https://registry.npmjs.org/", "a"), c.get("https://registry.npmjs.org/", "a")]);
    const again = await c.get("https://registry.npmjs.org/", "a");
    expect(again.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it("does not hit the network in offline mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = new RegistryClient(opts(true));
    await expect(c.get("https://registry.npmjs.org/", "a")).rejects.toThrow(/offline/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 404 to a notFound error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(new RegistryClient(opts()).get("https://registry.npmjs.org/", "nope")).rejects.toThrow(/not found/);
  });

  it("extractTimes keeps versions without time as unverifiable and lists deprecated ones", () => {
    const t = extractTimes({ "dist-tags": { latest: "2.0.0" }, time: { "1.0.0": "2020-01-01T00:00:00Z" }, versions: { "1.0.0": { deprecated: "old" }, "2.0.0": {} } });
    expect(t.time["2.0.0"]).toBe("");
    expect(t.deprecated).toEqual(["1.0.0"]);
  });
});

describe("formatting", () => {
  it("formats ages", () => {
    expect(formatAge(30 * 60_000)).toBe("30m");
    expect(formatAge(5 * 3_600_000)).toBe("5h");
    expect(formatAge(3 * 86_400_000)).toBe("3d");
    expect(formatAge(90 * 86_400_000)).toBe("3mo");
    expect(formatAge(800 * 86_400_000)).toBe("2.2y");
  });
  it("formats thresholds", () => {
    expect(formatThreshold(7 * 86_400_000)).toBe("7 days");
    expect(formatThreshold(36 * 3_600_000)).toBe("36 hours");
    expect(formatThreshold(90 * 60_000)).toBe("90 minutes");
    expect(formatThreshold(0)).toBe("0 (disabled)");
  });
});

describe("extractDependencies()", () => {
  it("finds all four sections with precise offsets", () => {
    const text = `{
  // comments are tolerated
  "dependencies": { "react": "^19.0.0" },
  "devDependencies": { "vitest": "3.2.0", },
  "peerDependencies": { "vue": "*" },
  "optionalDependencies": { "fsevents": "^2.3.3" },
  "overrides": { "x": "1.0.0" }
}`;
    const { entries, sections } = extractDependencies(text, ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);
    expect(entries.map((e) => `${e.section}:${e.name}@${e.spec}`)).toEqual([
      "dependencies:react@^19.0.0",
      "devDependencies:vitest@3.2.0",
      "peerDependencies:vue@*",
      "optionalDependencies:fsevents@^2.3.3",
    ]);
    const react = entries[0];
    expect(text.slice(react.valueOffset, react.valueOffset + react.valueLength)).toBe("^19.0.0");
    expect(text.slice(react.keyOffset, react.keyOffset + react.keyLength)).toBe("react");
    expect(sections).toHaveLength(4);
  });
  it("respects the configured section list", () => {
    const { entries } = extractDependencies('{"dependencies":{"a":"1"},"devDependencies":{"b":"1"}}', ["devDependencies"]);
    expect(entries.map((e) => e.name)).toEqual(["b"]);
  });
});
