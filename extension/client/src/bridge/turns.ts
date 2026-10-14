/**
 * The assistant's undo stack. One turn = one undo: an act call of its own, or every act call of one
 * Go in the panel (begin … end: a group). Each sequence has its own stack (the last MAX_TURNS turns),
 * persisted in %APPDATA%/itGenius/genius-cut/turns.json so Undo survives a panel reload; Phase 1's
 * single-action entries load as groups of one. Pure logic; the file is injected.
 */
export const MAX_TURNS = 20;

export interface TurnAction {
  tool: string;
  args: unknown;
  /** What it did, in a line ("Added 2 markers: Intro, Pricing"). */
  summary: string;
  /** The host's undo record (pure data), handed back to gcutToolUndo as it came. */
  undo: unknown;
  /** {oldId: [newIds]} for the clips whose ids this call changed (act tools that move or replace clips). */
  idMap?: Record<string, string[]>;
}

export interface Turn {
  id: string;
  /** ISO time the turn began. */
  at: string;
  sequenceId: string;
  /** Its actions' summaries, in order. */
  summary: string;
  /** Oldest first; Undo reverses them newest first. */
  actions: TurnAction[];
}

export interface TurnStore {
  /** The file's text, or null when there is none. */
  read(): string | null;
  write(text: string): void;
}

export type Turns = ReturnType<typeof createTurns>;

/** A turn as saved, or a Phase 1 entry ({tool, args, summary, undo}) as a group of one. */
function loaded(x: any): Turn | null {
  if (!x || typeof x !== "object") return null;
  if (Array.isArray(x.actions)) return x as Turn;
  const { tool, args, summary, undo, ...rest } = x;
  return { ...rest, summary, actions: [{ tool, args, summary, undo }] } as Turn;
}

const summaryOf = (actions: TurnAction[]) => actions.map((a) => a.summary).join("; ");

export function createTurns(store: TurnStore, now: () => Date = () => new Date()) {
  let stacks: Record<string, Turn[]> = {};
  try {
    const text = store.read();
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [seq, list] of Object.entries(parsed)) {
        if (Array.isArray(list)) stacks[seq] = list.map(loaded).filter((t): t is Turn => t !== null);
      }
    }
  } catch {
    stacks = {}; // unreadable: start empty rather than refuse to start
  }
  let n = 0;
  /** The group begun and not yet ended: its id and start time. */
  let group: { id: string; at: string } | null = null;
  const save = () => store.write(JSON.stringify(stacks));
  const newId = (at: Date) => `${at.getTime().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const find = (sequenceId: string, id: string) => (stacks[sequenceId] ?? []).find((t) => t.id === id);

  return {
    /** Record a successful act call: into the open group, else as a turn of its own. Saved at once. */
    push(a: TurnAction & { sequenceId: string }): Turn {
      const { sequenceId, ...action } = a;
      const stack = (stacks[sequenceId] ??= []);
      let turn = group ? find(sequenceId, group.id) : undefined;
      if (!turn) {
        const at = now();
        turn = { id: group ? group.id : newId(at), at: group ? group.at : at.toISOString(), sequenceId, summary: "", actions: [] };
        stack.push(turn);
        if (stack.length > MAX_TURNS) stack.splice(0, stack.length - MAX_TURNS);
      }
      turn.actions.push(action);
      turn.summary = summaryOf(turn.actions);
      save();
      return turn;
    },
    /** Start a group: every act call until end() is one turn. Returns its id. */
    begin(): string {
      const at = now();
      group = { id: newId(at), at: at.toISOString() };
      return group.id;
    },
    /** Close the group; the turn it made, if any act call ran. */
    end(): Turn | undefined {
      if (!group) return undefined;
      const id = group.id;
      group = null;
      for (const stack of Object.values(stacks)) {
        const t = stack.find((x) => x.id === id);
        if (t) return t;
      }
      return undefined;
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
    /** Remove that turn's newest action (once undone); the turn goes with its last one. */
    dropNewest(sequenceId: string, id: string): void {
      const turn = find(sequenceId, id);
      if (!turn) return;
      turn.actions.pop();
      if (!turn.actions.length) return this.pop(sequenceId, id);
      turn.summary = summaryOf(turn.actions);
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
