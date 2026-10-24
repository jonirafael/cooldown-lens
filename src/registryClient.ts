import * as fs from "fs/promises";
import * as path from "path";
import { Limiter } from "./core/limiter";
import type { PackageTimes } from "./core/versions";
import { packumentUrl } from "./core/registryUrl";
import { extractPypiTimes, normalizePyName, pypiJsonUrl } from "./core/python";

/** Which registry protocol to speak: npm packuments or the PyPI JSON API. */
export type Ecosystem = "npm" | "pypi";

interface CacheEntry {
  fetchedAt: number;
  registry: string;
  data: PackageTimes;
}

export interface RegistryClientOptions {
  storageDir?: string;
  ttlMs: () => number;
  offline: () => boolean;
  timeoutMs: () => number;
  concurrency: () => number;
  log: (msg: string) => void;
  /** User-Agent header (defaults to the VS Code extension's). */
  userAgent?: string;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly kind: "offline" | "notFound" | "network" | "invalid",
  ) {
    super(message);
  }
}

const MAX_BYTES = 80 * 1024 * 1024;

/**
 * Fetches package metadata (only the `time`, `dist-tags` and deprecation info are kept) with an
 * in-memory + on-disk cache, request de-duplication and a concurrency limit. No credentials are
 * ever sent: requests carry no Authorization header and no cookies.
 */
export class RegistryClient {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PackageTimes>>();
  private readonly limiter: Limiter;
  private loaded = false;
  private saveTimer: NodeJS.Timeout | undefined;
  requests = 0;
  cacheHits = 0;

  constructor(private readonly opts: RegistryClientOptions) {
    this.limiter = new Limiter(opts.concurrency());
  }

  get pending(): number {
    return this.limiter.pending;
  }

  private key(registry: string, name: string, ecosystem: Ecosystem): string {
    return ecosystem === "npm" ? `${registry}|${name}` : `pypi|${registry}|${normalizePyName(name)}`;
  }

  private get cacheFile(): string | undefined {
    return this.opts.storageDir ? path.join(this.opts.storageDir, "registry-cache.json") : undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.cacheFile;
    if (!file) return;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) if (v && v.data && v.fetchedAt) this.memory.set(k, v);
    } catch {
      /* no cache yet */
    }
  }

  private scheduleSave(): void {
    const file = this.cacheFile;
    if (!file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(Object.fromEntries(this.memory)), "utf8");
      } catch (e) {
        this.opts.log(`cache write failed: ${(e as Error).message}`);
      }
    }, 2000);
  }

  async clear(): Promise<void> {
    this.memory.clear();
    const file = this.cacheFile;
    if (file) await fs.rm(file, { force: true });
  }

  /** Returns cached data when fresh (or when offline), otherwise fetches. */
  async get(
    registry: string,
    name: string,
    force = false,
    ecosystem: Ecosystem = "npm",
  ): Promise<{ data: PackageTimes; fromCache: boolean; fetchedAt: number }> {
    await this.load();
    const key = this.key(registry, name, ecosystem);
    const cached = this.memory.get(key);
    const offline = this.opts.offline();
    if (cached && (offline || (!force && Date.now() - cached.fetchedAt < this.opts.ttlMs()))) {
      this.cacheHits++;
      return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    if (offline) throw new RegistryError(`offline mode: ${name} is not cached yet`, "offline");

    let p = this.inflight.get(key);
    if (!p) {
      this.limiter.concurrency = this.opts.concurrency();
      p = this.limiter.run(() => this.fetchPackument(registry, name, ecosystem)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      const data = await p;
      const entry = { fetchedAt: Date.now(), registry, data };
      this.memory.set(key, entry);
      this.scheduleSave();
      return { data, fromCache: false, fetchedAt: entry.fetchedAt };
    } catch (e) {
      // Network trouble: fall back to stale cache rather than showing nothing.
      if (cached && e instanceof RegistryError && e.kind === "network") {
        this.opts.log(`using stale cache for ${name}: ${e.message}`);
        return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
      }
      throw e;
    }
  }

  private async fetchPackument(registry: string, name: string, ecosystem: Ecosystem): Promise<PackageTimes> {
    let url: string;
    try {
      url = ecosystem === "pypi" ? pypiJsonUrl(new URL(registry), name) : packumentUrl(new URL(registry), name);
    } catch (e) {
      throw new RegistryError((e as Error).message, "invalid");
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs());
    this.requests++;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": this.opts.userAgent ?? "cooldown-lens-vscode" },
        redirect: "follow",
        credentials: "omit",
        signal: ctrl.signal,
      });
      if (res.status === 404) throw new RegistryError(`${name} not found on ${registry}`, "notFound");
      if (!res.ok) throw new RegistryError(`${registry} answered HTTP ${res.status} for ${name}`, "network");
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_BYTES) throw new RegistryError(`metadata for ${name} is too large (${len} bytes)`, "invalid");
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new RegistryError(`metadata for ${name} is too large`, "invalid");
      const json = JSON.parse(text);
      if (ecosystem === "pypi") {
        try {
          return extractPypiTimes(json);
        } catch (e) {
          throw new RegistryError(`${name}: ${(e as Error).message}`, "invalid");
        }
      }
      return extractTimes(json);
    } catch (e) {
      if (e instanceof RegistryError) throw e;
      if (e instanceof SyntaxError) throw new RegistryError(`invalid JSON for ${name}`, "invalid");
      throw new RegistryError(`${name}: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message}`, "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function extractTimes(doc: unknown): PackageTimes {
  if (!doc || typeof doc !== "object") throw new RegistryError("unexpected registry response", "invalid");
  const d = doc as { time?: Record<string, unknown>; "dist-tags"?: Record<string, unknown>; versions?: Record<string, { deprecated?: unknown }> };
  const time: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.time ?? {})) if (typeof v === "string") time[k] = v;
  // Registries without `time` still list versions; keep them so we can say "no timestamp".
  for (const v of Object.keys(d.versions ?? {})) if (!(v in time)) time[v] = "";
  const distTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(d["dist-tags"] ?? {})) if (typeof v === "string") distTags[k] = v;
  const deprecated = Object.entries(d.versions ?? {})
    .filter(([, m]) => m && typeof m.deprecated === "string" && m.deprecated.length > 0)
    .map(([v]) => v);
  return { time, distTags, deprecated };
}
