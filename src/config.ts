// The whole app is opened from a "magic link": a single URL a parent generates
// once and saves to the toddler's home screen. Credentials live in the URL hash
// (after `#`) so they are never sent to a server or written to access logs.
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

// Read every field out of a hash, empty string when absent. Never fails.
export function readParams(hash: string): RawParams {
  const p = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return {
    homeserver: p.get("hs") ?? p.get("homeserver") ?? "",
    user: p.get("user") ?? p.get("username") ?? "",
    password: p.get("pass") ?? p.get("password") ?? "",
    room: p.get("room") ?? p.get("roomId") ?? "",
  };
}

// A usable config, or null when a required field is missing.
export function parseConfig(hash: string): Config | null {
  const raw = readParams(hash);
  const homeserver = normalizeHomeserver(raw.homeserver);
  if (!homeserver || !raw.user || !raw.password) return null;

  return {
    homeserver,
    user: raw.user,
    password: raw.password,
    room: raw.room || undefined,
  };
}

// Inverse of readParams: build the hash fragment a magic link carries.
export function buildHash(fields: RawParams): string {
  const p = new URLSearchParams();
  p.set("hs", fields.homeserver.trim());
  p.set("user", fields.user.trim());
  p.set("pass", fields.password);
  if (fields.room.trim()) p.set("room", fields.room.trim());
  return `#${p.toString()}`;
}

function normalizeHomeserver(value: string): string {
  const s = value.trim();
  if (!s) return "";
  return (/^https?:\/\//i.test(s) ? s : `https://${s}`).replace(/\/+$/, "");
}
