/** Picks the real CEP wiring inside Premiere, or the sample-data mock (browser or preview build). */
import { createBackend } from "./backend";
import { cepHost, hostCaller } from "./host";
import { mockCallHost, mockHost, mockTransport } from "./mock";
import { dataDir, evalScript, isCEP, killProcess, logPath, node, nodeTransport, readToken, spawnBackend } from "./cep";
import { fileTurnStore, type TurnStore } from "../bridge/turns";
import { pickMode } from "../lib/mode";

export const mode = pickMode({ inPremiere: isCEP(), previewBuild: import.meta.env.VITE_GENIUSCUT_PREVIEW === "1" });

export const runtime = mode === "live"
  ? {
      mode,
      isSample: false,
      backend: createBackend({ transport: nodeTransport, token: readToken }),
      host: cepHost(evalScript),
      /** The gcutTool* host functions (the instruction run's and the bridge's tool table). */
      callHost: hostCaller(evalScript),
      /** The undo stack's file: %APPDATA%/itGenius/genius-cut/turns.json. */
      turnStore: (): TurnStore => fileTurnStore(node("fs"), node("path"), node("path").join(dataDir(), "turns.json")),
      spawn: spawnBackend,
      kill: killProcess,
      logPath,
    }
  : {
      mode,
      isSample: true,
      backend: createBackend({ transport: mockTransport, token: () => "sample" }),
      host: mockHost,
      callHost: mockCallHost,
      turnStore: (): TurnStore => { let text: string | null = null; return { read: () => text, write: (t: string) => { text = t; } }; },
      spawn: () => {},
      kill: (_pid: number) => {},
      logPath: () => "(sample mode)",
    };
