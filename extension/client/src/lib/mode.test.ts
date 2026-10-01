import { describe, it, expect } from "vitest";
import { pickMode } from "./mode";

describe("pickMode", () => {
  it("inside Premiere, a normal build uses the real backend and timeline", () => {
    expect(pickMode({ inPremiere: true, previewBuild: false })).toBe("live");
  });
  it("inside Premiere, a preview build runs on sample data and never starts a backend", () => {
    expect(pickMode({ inPremiere: true, previewBuild: true })).toBe("preview");
  });
  it("in a browser it's always sample data", () => {
    expect(pickMode({ inPremiere: false, previewBuild: false })).toBe("browser");
    expect(pickMode({ inPremiere: false, previewBuild: true })).toBe("browser");
  });
});
