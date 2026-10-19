export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

export interface RegistryChoice {
  base: string;
  scoped: Record<string, string>;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Validates a registry base URL. Only https is allowed, except for explicitly allow-listed hosts
 * (localhost mirrors). Credentials embedded in the URL are rejected so they never leak into logs
 * or requests.
 */
export function checkRegistryUrl(raw: string, allowInsecureHosts: readonly string[]): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `invalid registry URL "${raw}"` };
  }
  if (url.username || url.password) return { ok: false, reason: "registry URLs with embedded credentials are not used" };
  if (url.protocol === "http:") {
    if (!allowInsecureHosts.includes(url.hostname)) {
      return { ok: false, reason: `plain http is only allowed for: ${allowInsecureHosts.join(", ") || "(none)"}` };
    }
  } else if (url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return { ok: true, url };
}

/** Builds the packument URL; scoped names keep the "@" and encode the "/" like npm does. */
export function packumentUrl(base: URL, name: string): string {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) throw new Error(`invalid package name "${name}"`);
  const encoded = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  return new URL(encoded, base).toString();
}

export function registryFor(name: string, choice: RegistryChoice): string {
  if (name.startsWith("@")) {
    const scope = name.split("/")[0];
    if (choice.scoped[scope]) return choice.scoped[scope];
  }
  return choice.base;
}
