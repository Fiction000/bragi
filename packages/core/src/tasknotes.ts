// TaskNotes (Obsidian notes, one per task) carry the due date and the kanban card id of the work.
// An article is linked to them by the ids its own files mention (the patterns in the `taskIds` setting, e.g. TASK-303). Read-only.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSettings } from './config.ts';

export type TaskNote = { key: string | null; kanban: string | null; status: string | null; due: string | null };

const field = (front: string, name: string) => {
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(front);
  const value = m?.[1].trim().replace(/^["']|["']$/g, '');
  return value ? value : null;
};

export function parseTaskNote(text: string): TaskNote | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!front) return null;
  const due = field(front, 'due');
  return { key: field(front, 'key'), kanban: field(front, 'kanban'), status: field(front, 'status'), due: due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null };
}

export async function loadTaskNotes(dir: string): Promise<TaskNote[]> {
  const notes: TaskNote[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      const handle = await fs.open(path.join(dir, name), 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
        const note = parseTaskNote(buffer.subarray(0, bytesRead).toString('utf8'));
        if (note && (note.key || note.kanban)) notes.push(note);
      } finally { await handle.close(); }
    } catch { /* an unreadable note is skipped */ }
  }
  return notes;
}

/** Every id the text mentions. With no `taskIds` pattern configured nothing is a task id, so articles are not linked to task notes. */
export const mentionedIds = (text: string, patterns: RegExp[] = loadSettings().taskIdPatterns) => patterns.flatMap((re) => [...text.matchAll(new RegExp(re.source, 'g'))].map((m) => m[0]));

const FINISHED = new Set(['done', 'cancelled', 'canceled']);

/**
 * The note an article is about: the one whose key or kanban id its files mention most (both ids of one note
 * add up, so an incidental mention of another card loses). Finished notes are ignored. Its due date, if it has one.
 */
export function dueFromNotes(mentions: string[], notes: TaskNote[]): { due: string; from: string } | null {
  const counts = new Map<string, number>();
  for (const id of mentions) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best: { score: number; note: TaskNote } | null = null;
  for (const note of notes) {
    if (note.status && FINISHED.has(note.status.toLowerCase())) continue;
    const score = (note.key ? (counts.get(note.key) ?? 0) : 0) + (note.kanban ? (counts.get(note.kanban) ?? 0) : 0);
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && (note.due ?? '9999') < (best.note.due ?? '9999'))) best = { score, note };
  }
  return best?.note.due ? { due: best.note.due, from: best.note.key ?? best.note.kanban ?? 'TaskNote' } : null;
}
