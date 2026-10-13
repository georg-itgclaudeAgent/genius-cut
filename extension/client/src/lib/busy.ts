/**
 * Whether the Cut tab is in the middle of something that reads or changes the timeline (Analyse,
 * Apply, Restore, Close gap). The assistant bridge refuses its act tools meanwhile.
 */
let running = 0;

export async function whileBusy<T>(fn: () => Promise<T>): Promise<T> {
  running++;
  try {
    return await fn();
  } finally {
    running--;
  }
}

export const cutTabBusy = (): boolean => running > 0;
