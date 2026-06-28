import { oldestFirstToPrependOrder } from "./app";

describe("oldestFirstToPrependOrder", () => {
  it("reverses oldest-first history so repeated prepend keeps chronological order", () => {
    expect(oldestFirstToPrependOrder(["oldest", "middle", "newest"])).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("does not mutate the caller's history batch", () => {
    const batch = ["oldest", "newest"];
    oldestFirstToPrependOrder(batch);
    expect(batch).toEqual(["oldest", "newest"]);
  });
});
