import { clearSession, loadSession, saveSession } from "./session";

describe("session storage", () => {
  it("round-trips a saved session for the same homeserver and user", () => {
    const storage = memoryStorage();
    saveSession(
      "https://matrix.example",
      "tot",
      { accessToken: "abc", userId: "@tot:matrix.example", deviceId: "DEV1" },
      storage,
    );

    expect(loadSession("https://matrix.example", "tot", storage)).toEqual({
      accessToken: "abc",
      userId: "@tot:matrix.example",
      deviceId: "DEV1",
    });
  });

  it("scopes sessions per homeserver and user", () => {
    const storage = memoryStorage();
    saveSession(
      "https://a.example",
      "tot",
      { accessToken: "a", userId: "@tot:a.example" },
      storage,
    );

    expect(loadSession("https://a.example", "other", storage)).toBeNull();
    expect(loadSession("https://b.example", "tot", storage)).toBeNull();
  });

  it("returns null for malformed or partial stored data", () => {
    const storage = memoryStorage();
    storage.setItem("minimatrix.session.https://matrix.example|tot", "{ not json");
    expect(loadSession("https://matrix.example", "tot", storage)).toBeNull();

    saveSession(
      "https://matrix.example",
      "tot",
      { accessToken: "", userId: "@tot:matrix.example" },
      storage,
    );
    expect(loadSession("https://matrix.example", "tot", storage)).toBeNull();
  });

  it("clears a saved session", () => {
    const storage = memoryStorage();
    saveSession(
      "https://matrix.example",
      "tot",
      { accessToken: "abc", userId: "@tot:matrix.example" },
      storage,
    );
    clearSession("https://matrix.example", "tot", storage);
    expect(loadSession("https://matrix.example", "tot", storage)).toBeNull();
  });
});

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  } as Storage;
}
