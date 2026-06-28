// Persisted Matrix session: the access token and device id minted at the first
// password login. Reusing them on later launches keeps each install on a single
// device instead of having the homeserver mint a fresh one (and a dangling,
// never-revoked access token) on every app open — and means the account
// password is sent over the wire once, not on every launch.

export interface Session {
  accessToken: string;
  deviceId?: string;
  userId: string;
}

interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "minimatrix.session.";

// Scoped per homeserver+user so two different accounts on one device don't
// clobber each other's token.
function storageKey(baseUrl: string, user: string): string {
  return `${PREFIX}${baseUrl}|${user}`;
}

export function loadSession(
  baseUrl: string,
  user: string,
  storage = defaultStorage(),
): Session | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(baseUrl, user));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.accessToken || !parsed.userId) return null;
    return { accessToken: parsed.accessToken, userId: parsed.userId, deviceId: parsed.deviceId };
  } catch {
    return null;
  }
}

export function saveSession(
  baseUrl: string,
  user: string,
  session: Session,
  storage = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(baseUrl, user), JSON.stringify(session));
  } catch {
    // Storage disabled (private/restricted context): we just log in fresh next
    // launch instead of reusing the token. No worse than the old behaviour.
  }
}

export function clearSession(baseUrl: string, user: string, storage = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(baseUrl, user));
  } catch {
    // Nothing to do; a stale entry is harmless and gets overwritten on re-login.
  }
}

function defaultStorage(): SessionStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
