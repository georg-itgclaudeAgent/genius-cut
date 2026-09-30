import { describe, it, expect } from "vitest";
import { cepHost, HostUnavailable } from "./host";

describe("cepHost", () => {
  it("a missing gcut* function (Phase C not installed) is HostUnavailable", async () => {
    const host = cepHost(async () => "__GCUT_MISSING__");
    await expect(host.findClip("take3")).rejects.toBeInstanceOf(HostUnavailable);
  });

  it("the host's Error: convention becomes a plain error", async () => {
    const host = cepHost(async () => "Error: No active sequence");
    await expect(host.findClip(null)).rejects.toThrow("No active sequence");
  });

  it("parses the JSON the host returns", async () => {
    const host = cepHost(async () => JSON.stringify({ found: true, name: "take3.mp4" }));
    await expect(host.findClip("take3")).resolves.toMatchObject({ found: true, name: "take3.mp4" });
  });

  it("quotes clip names safely into the ExtendScript call", async () => {
    let script = "";
    const host = cepHost(async (s) => { script = s; return "{}"; });
    await host.findClip('he said "cut"\\ok');
    const arg = script.slice(script.indexOf("gcutFindClip(", 30) + "gcutFindClip(".length, script.lastIndexOf(") :"));
    expect(JSON.parse(JSON.parse(arg))).toBe('he said "cut"\\ok');
  });
});
