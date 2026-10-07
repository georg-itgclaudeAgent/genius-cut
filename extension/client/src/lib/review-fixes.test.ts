/** Regression tests for the panel review (C1, I3, I5). I1/I2/I4 are covered where they live. */
import { describe, it, expect } from "vitest";
import { round3 } from "./review";
import { clipProblem } from "./clip";
import { cepHost, HostUnavailable } from "../api/host";

describe("C1: round3 matches Python round(x, 3)", () => {
  it.each([
    [0.0625, 0.062],   // exact tie → half-even
    [10.0625, 10.062],
    [0.1875, 0.188],   // exact tie, odd digit → up to even
    [1.0005, 1.0],     // not a tie: the double is just below .0005
    [0.0635, 0.064],   // the double is just above .0635 (Python agrees: 0.064)
    [12.3456, 12.346],
    [7, 7],
  ])("%d → %d", (x, want) => {
    expect(round3(x)).toBe(want);
  });
});

const CLIP: Parameters<typeof clipProblem>[0] = { found: true, name: "a.mp4", speed: 1 };

describe("I5: clips Phase 1 can't trim correctly are refused before analysis", () => {
  it("a normal clip is fine", () => expect(clipProblem(CLIP)).toBeNull());
  it("a clip that wasn't found", () => expect(clipProblem({ ...CLIP, found: false })).toMatch(/No matching clip/));
  it("a sped-up or slowed clip", () => expect(clipProblem({ ...CLIP, speed: 1.5 })).toMatch(/150%/));
  it("a reversed clip", () => expect(clipProblem({ ...CLIP, speed: -1 })).toMatch(/reversed/));
});

describe("I3: only a genuinely missing gcut* function means 'Phase C not installed'", () => {
  it("wraps each call in a typeof probe", async () => {
    let script = "";
    await cepHost(async (s) => { script = s; return "{}"; }).snapshotSelection("x");
    expect(script).toMatch(/^typeof gcutSnapshotSelection === "function"/);
  });
  it("the missing-function sentinel is HostUnavailable", async () => {
    await expect(cepHost(async () => "__GCUT_MISSING__").snapshotSelection("x")).rejects.toBeInstanceOf(HostUnavailable);
  });
  it("a runtime ExtendScript error is a real error, not 'arrives with Phase C'", async () => {
    const err = await cepHost(async () => "EvalScript error.").snapshotSelection("x").catch((e) => e);
    expect(err).not.toBeInstanceOf(HostUnavailable);
    expect(err.message).toMatch(/Premiere script failed/);
  });
  it("normal output that happens to contain 'is undefined' is parsed, not misread", async () => {
    const out = JSON.stringify({ found: false, message: "clip is undefined" });
    await expect(cepHost(async () => out).snapshotSelection("x")).resolves.toMatchObject({ message: "clip is undefined" });
  });
});
