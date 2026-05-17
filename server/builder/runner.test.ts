import { describe, expect, test } from "bun:test";
import { tmuxSocket } from "./runner.ts";

describe("tmuxSocket", () => {
  test("returns tib-mimule for mimule tenant", () => {
    expect(tmuxSocket("mimule")).toBe("tib-mimule");
  });

  test("returns tib-acme for acme tenant", () => {
    expect(tmuxSocket("acme")).toBe("tib-acme");
  });

  test("returns tib-<id> for any tenant id", () => {
    expect(tmuxSocket("t-alpha")).toBe("tib-t-alpha");
    expect(tmuxSocket("t-beta")).toBe("tib-t-beta");
    expect(tmuxSocket("my-org")).toBe("tib-my-org");
  });
});
