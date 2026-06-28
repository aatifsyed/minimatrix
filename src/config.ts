// The whole app is opened from a "magic link": a single URL a parent generates
// once and saves to the toddler's home screen. Credentials live in the URL
// fragment (after `#`) so they are never sent to a server or written to access
// logs.
//
// Example:
//   https://minimatrix.example/#hs=matrix.example&user=tot&pass=secret&room=!abc:matrix.example
//
// `room` is optional: when omitted we use the account's only joined room.

export interface Config {
  homeserver: string;
  user: string;
  password: string;
  room?: string;
}

// The raw, unvalidated fields exactly as they appear in the link — used to
// prefill the setup form and to build links back out.
export interface RawParams {
  homeserver: string;
  user: string;
  password: string;
  room: string;
}

export interface ResolvedConfig {
  config: Config | null;
  params: RawParams;
  urlFragment: string;
  fromStorage: boolean;
}

interface UrlFragmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SAVED_URL_FRAGMENT_KEY = "minimatrix.urlFragment";

// Read every field out of a URL fragment, empty string when absent. Never fails.
export function readParams(urlFragment: string): RawParams {
  const p = new URLSearchParams(urlFragment.startsWith("#") ? urlFragment.slice(1) : urlFragment);
  return {
    homeserver: p.get("hs") ?? p.get("homeserver") ?? "",
    user: p.get("user") ?? p.get("username") ?? "",
    password: p.get("pass") ?? p.get("password") ?? "",
    room: p.get("room") ?? p.get("roomId") ?? "",
  };
}

// A usable config, or null when a required field is missing.
export function parseConfig(urlFragment: string): Config | null {
  const raw = readParams(urlFragment);
  const homeserver = normalizeHomeserver(raw.homeserver);
  if (!homeserver || !raw.user || !raw.password) return null;

  return {
    homeserver,
    user: raw.user,
    password: raw.password,
    room: raw.room || undefined,
  };
}

export function resolveConfig(urlFragment: string, storage = defaultStorage()): ResolvedConfig {
  const params = readParams(urlFragment);
  const config = parseConfig(urlFragment);
  if (config) {
    const normalizedUrlFragment = buildUrlFragment(params);
    rememberUrlFragment(normalizedUrlFragment, storage);
    return { config, params, urlFragment: normalizedUrlFragment, fromStorage: false };
  }

  // A partial URL fragment is probably a setup form in progress; do not hide it
  // by falling back to an older saved magic link.
  if (hasAnyParam(params)) return { config: null, params, urlFragment, fromStorage: false };

  const savedUrlFragment = readSavedUrlFragment(storage);
  const savedConfig = parseConfig(savedUrlFragment);
  if (savedConfig) {
    return {
      config: savedConfig,
      params: readParams(savedUrlFragment),
      urlFragment: savedUrlFragment,
      fromStorage: true,
    };
  }

  return { config: null, params, urlFragment, fromStorage: false };
}

export function rememberUrlFragment(urlFragment: string, storage = defaultStorage()): void {
  if (!storage || !parseConfig(urlFragment)) return;
  try {
    storage.setItem(SAVED_URL_FRAGMENT_KEY, urlFragment);
  } catch {
    // Storage can be disabled in private/restricted contexts. The URL fragment
    // still works for the current page load; install fallback just won't be
    // available.
  }
}

// Inverse of readParams: build the URL fragment a magic link carries.
export function buildUrlFragment(fields: RawParams): string {
  const p = new URLSearchParams();
  p.set("hs", fields.homeserver.trim());
  p.set("user", fields.user.trim());
  p.set("pass", fields.password);
  if (fields.room.trim()) p.set("room", fields.room.trim());
  return `#${p.toString()}`;
}

function hasAnyParam(params: RawParams): boolean {
  return Boolean(params.homeserver || params.user || params.password || params.room);
}

function readSavedUrlFragment(storage?: UrlFragmentStorage): string {
  if (!storage) return "";
  try {
    return storage.getItem(SAVED_URL_FRAGMENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function defaultStorage(): UrlFragmentStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeHomeserver(value: string): string {
  const s = value.trim();
  if (!s) return "";
  return (/^https?:\/\//i.test(s) ? s : `https://${s}`).replace(/\/+$/, "");
}
