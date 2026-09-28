// A room project = a base room + an append-only log of changes. The room file MSL loads
// (Codes/<output>.gml) is a build product: compile() replays the log over the base.
//
//   base.vanilla   a room exported from the untouched game (cache/assets/rooms/<name>.json)
//   base.file      a room JSON checked into the mod (path relative to the mod root)
//   base.sha       sha1 of the base's canonical JSON; a mismatch means the game (or the
//                  file) changed under the project -- replay still runs, and every op
//                  whose `expect` no longer holds is reported instead of applied blind
//
// Each log entry is one user-visible change (one drag, one delete, one agent batch) by one
// author. Undo pops the author's last entry when it is still the tail, otherwise appends
// the inverse -- so an agent never has history rewritten under it. Revs are never reused:
// a rev missing from the log was undone.
import { applyAll, OpError, type Op } from "./ops.ts";
import { cloneRoom, type FileStyle, type Room } from "./room.ts";

export const PROJECT_FORMAT = "svre-room/1";

export type Base = { vanilla: string; sha: string } | { file: string; sha: string };

export interface Entry {
  rev: number;
  by: string;
  at: string; // ISO time
  label: string;
  note?: string;
  ops: Op[];
  undoOf?: number; // set when this entry is the inverse of an earlier one
}

export interface Note {
  id: string;
  by: string;
  at: string;
  x: number;
  y: number;
  text: string;
}

export interface Project {
  format: typeof PROJECT_FORMAT;
  output: string; // Codes/<output>.gml
  base: Base;
  style: FileStyle; // line endings of the compiled file
  nextRev: number;
  nextId: number; // instance-id high-water mark; ids handed out are never reused
  compiled: { rev: number; hash: string } | null;
  notes: Note[];
  log: Entry[];
}

export const headRev = (p: Project) => (p.log.length ? p.log[p.log.length - 1].rev : 0);

export interface ReplayProblem {
  rev: number;
  opIndex: number;
  message: string;
}

// Replay the log. Entries whose ops fail are skipped as a whole (an entry is atomic) and
// reported; `strict` throws on the first one instead.
export function compile(base: Room, project: Project, strict = false): { room: Room; problems: ReplayProblem[] } {
  const room = cloneRoom(base);
  const problems: ReplayProblem[] = [];
  for (const e of project.log) {
    try {
      applyAll(room, e.ops);
    } catch (err) {
      const msg = err instanceof OpError ? err.message : String(err);
      if (strict) throw new OpError(err instanceof OpError ? err.code : "invalid", `rev ${e.rev}: ${msg}`);
      problems.push({ rev: e.rev, opIndex: -1, message: msg });
    }
  }
  return { room, problems };
}

// the canonical form hashed into base.sha: key order as in the file, no whitespace
export const canonical = (room: Room) => JSON.stringify(room);

// Project files are written with one log entry / note per line, so git diffs of a
// project read as "these changes were added".
export function serializeProject(p: Project): string {
  const head = { ...p, notes: undefined, log: undefined };
  const lines = JSON.stringify(head, null, 2).split("\n");
  lines.pop(); // closing brace
  const body = (key: string, items: unknown[]) =>
    items.length ? `  "${key}": [\n${items.map((x) => "    " + JSON.stringify(x)).join(",\n")}\n  ]` : `  "${key}": []`;
  return lines.join("\n") + ",\n" + body("notes", p.notes) + ",\n" + body("log", p.log) + "\n}\n";
}

export function parseProject(text: string): Project {
  const p = JSON.parse(text) as Project;
  if (p.format !== PROJECT_FORMAT) throw new Error(`not a ${PROJECT_FORMAT} project (format=${(p as any).format})`);
  return p;
}
