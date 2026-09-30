import { useCallback, useEffect, useRef, useState } from "react";
import { ensureBackend, type BackendState } from "../lib/lifecycle";
import { runtime } from "../api/runtime";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Find or start the backend, keep polling while the model loads, and allow a retry. */
export function useBackend() {
  const [state, setState] = useState<BackendState | { kind: "checking" }>({ kind: "checking" });
  const alive = useRef(true);

  const connect = useCallback(async () => {
    setState({ kind: "checking" });
    let s = await ensureBackend({ health: runtime.backend.health, spawn: runtime.spawn, sleep });
    // First run downloads ~3 GB, so "starting" can last minutes; keep checking quietly.
    while (alive.current && s.kind === "starting") {
      setState(s);
      await sleep(2000);
      s = await ensureBackend({ health: runtime.backend.health, spawn: () => {}, sleep, attempts: 1 });
    }
    if (alive.current) setState(s);
  }, []);

  useEffect(() => {
    alive.current = true;
    connect();
    return () => { alive.current = false; };
  }, [connect]);

  return { state, retry: connect };
}
