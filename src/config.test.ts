import { buildUrlFragment, parseConfig, readParams, resolveConfig } from "./config";

describe("config URL fragments", () => {
  it("normalizes a complete magic link URL fragment", () => {
    expect(
      parseConfig("#hs=matrix.example/&user=tot&pass=secret&room=!abc%3Amatrix.example"),
    ).toEqual({
      homeserver: "https://matrix.example",
      user: "tot",
      password: "secret",
      room: "!abc:matrix.example",
    });
  });

  it("rejects incomplete URL fragments", () => {
    expect(parseConfig("#hs=matrix.example&user=tot")).toBeNull();
  });

  it("round-trips generated URL fragments through the reader", () => {
    const fields = {
      homeserver: "matrix.example",
      user: "tot",
      password: "secret value",
      room: "",
    };
    expect(readParams(buildUrlFragment(fields))).toEqual(fields);
  });

  it("saves a complete URL fragment and reuses it when an installed app launches without one", () => {
    const storage = memoryStorage();
    const first = resolveConfig("#hs=matrix.example&user=tot&pass=secret", storage);
    const installedLaunch = resolveConfig("", storage);

    expect(first.fromStorage).toBe(false);
    expect(installedLaunch).toMatchObject({
      config: {
        homeserver: "https://matrix.example",
        user: "tot",
        password: "secret",
      },
      fromStorage: true,
    });
  });

  it("does not hide partial setup URL fragments behind a saved link", () => {
    const storage = memoryStorage();
    resolveConfig("#hs=matrix.example&user=tot&pass=secret", storage);

    expect(resolveConfig("#hs=other.example", storage)).toMatchObject({
      config: null,
      params: {
        homeserver: "other.example",
      },
      fromStorage: false,
    });
  });
});

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  } as Storage;
}
