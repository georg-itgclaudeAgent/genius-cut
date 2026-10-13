import { describe, it, expect } from "vitest";
import { cutTabBusy, whileBusy } from "./busy";

describe("the Cut tab's busy flag (read by the assistant bridge)", () => {
  it("is set while an operation runs, also when it fails, and while any of several overlap", async () => {
    expect(cutTabBusy()).toBe(false);
    let release!: () => void;
    const a = whileBusy(() => new Promise<void>((r) => { release = r; }));
    const b = whileBusy(async () => { throw new Error("refused"); }).catch((e) => e);
    expect(cutTabBusy()).toBe(true);
    expect((await b).message).toBe("refused");
    expect(cutTabBusy()).toBe(true);
    release();
    await a;
    expect(cutTabBusy()).toBe(false);
  });
});
