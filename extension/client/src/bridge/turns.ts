/**
 * The assistant's undo stack. Phase 1: one act call = one turn. Each sequence has its own stack (the
 * last MAX_TURNS turns), persisted in %APPDATA%/itGenius/genius-cut/turns.json so Undo survives a
 * panel reload. Pure logic; the file is injected.
 */
export const MAX_TURNS = 20;

export interface Turn {
  id: string;
  /** ISO time the act call finished. */
  at: string;
  sequenceId: string;
  tool: string;
  args: unknown;
  /** What it did, in a line ("Added 2 markers: Intro, Pricing"). */
  summary: string;
  /** The host's undo record (pure data), handed back to gcutToolUndo as it came. */
  undo: unknown;
}

export interface TurnStore {
  /** The file's text, or null when there is none. */
  read(): string | null;
  write(text: string): void;
}

export type Turns = ReturnType<typeof createTurns>;

export function createTurns(store: TurnStore, now: () => Date = () => new Date()) {
  let stacks: Record<string, Turn[]> = {};
  try {
    const text = store.read();
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [seq, list] of Object.entries(parsed)) if (Array.isArray(list)) stacks[seq] = list as Turn[];
    }
  } catch {
    stacks = {}; // unreadable: start empty rather than refuse to start
  }
  let n = 0;
  const save = () => store.write(JSON.stringify(stacks));

  return {
    push(t: Omit<Turn, "id" | "at">): Turn {
      const at = now();
      const turn: Turn = { id: `${at.getTime().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                           at: at.toISOString(), ...t };
      const stack = (stacks[t.sequenceId] ??= []);
      stack.push(turn);
      if (stack.length > MAX_TURNS) stack.splice(0, stack.length - MAX_TURNS);
      save();
      return turn;
    },
    /** The newest turn on this sequence, if any. */
    latest(sequenceId: string): Turn | undefined {
      const stack = stacks[sequenceId];
      return stack && stack.length ? stack[stack.length - 1] : undefined;
    },
    /** Remove that turn (once undone). */
    pop(sequenceId: string, id: string): void {
      const stack = stacks[sequenceId];
      const i = stack ? stack.findIndex((t) => t.id === id) : -1;
      if (i < 0) return;
      stack.splice(i, 1);
      save();
    },
  };
}

/** turns.json on disk, through Node's fs. */
export function fileTurnStore(fs: any, path: any, file: string): TurnStore {
  return {
    read: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null),
    write: (text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}
