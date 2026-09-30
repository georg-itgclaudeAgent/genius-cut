/** Picks the real CEP wiring inside Premiere, or the sample-data mock in a browser. */
import { createBackend } from "./backend";
import { cepHost } from "./host";
import { mockHost, mockTransport } from "./mock";
import { evalScript, isCEP, logPath, nodeTransport, readToken, spawnBackend } from "./cep";

const inPremiere = isCEP();

export const runtime = inPremiere
  ? {
      isSample: false,
      backend: createBackend({ transport: nodeTransport, token: readToken }),
      host: cepHost(evalScript),
      spawn: spawnBackend,
      logPath,
    }
  : {
      isSample: true,
      backend: createBackend({ transport: mockTransport, token: () => "sample" }),
      host: mockHost,
      spawn: () => {},
      logPath: () => "(sample mode)",
    };
