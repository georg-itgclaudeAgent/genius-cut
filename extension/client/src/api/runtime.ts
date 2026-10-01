/** Picks the real CEP wiring inside Premiere, or the sample-data mock (browser or preview build). */
import { createBackend } from "./backend";
import { cepHost } from "./host";
import { mockHost, mockTransport } from "./mock";
import { evalScript, isCEP, logPath, nodeTransport, readToken, spawnBackend } from "./cep";
import { pickMode } from "../lib/mode";

export const mode = pickMode({ inPremiere: isCEP(), previewBuild: import.meta.env.VITE_GENIUSCUT_PREVIEW === "1" });

export const runtime = mode === "live"
  ? {
      mode,
      isSample: false,
      backend: createBackend({ transport: nodeTransport, token: readToken }),
      host: cepHost(evalScript),
      spawn: spawnBackend,
      logPath,
    }
  : {
      mode,
      isSample: true,
      backend: createBackend({ transport: mockTransport, token: () => "sample" }),
      host: mockHost,
      spawn: () => {},
      logPath: () => "(sample mode)",
    };
