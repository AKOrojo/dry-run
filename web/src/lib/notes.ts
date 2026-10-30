// The user's own notes on a run's timeline, kept in this browser only (localStorage, one key per run).
import { useSyncExternalStore } from "react";

export type Note = { id: string; t_s: number; text: string };

const key = (runId: string) => `dr_notes_${runId}`;
const cache = new Map<string, Note[]>();
const subs = new Set<() => void>();
const NONE: Note[] = [];

function load(runId: string): Note[] {
  const hit = cache.get(runId);
  if (hit) return hit;
  let notes: Note[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(key(runId)) ?? "[]");
    if (Array.isArray(raw)) notes = raw.filter((n) => n && typeof n.text === "string" && typeof n.t_s === "number" && typeof n.id === "string");
  } catch { /* storage blocked or bad JSON: start empty */ }
  cache.set(runId, notes);
  return notes;
}
function save(runId: string, notes: Note[]) {
  cache.set(runId, notes);
  try { localStorage.setItem(key(runId), JSON.stringify(notes)); } catch { /* kept for this page view only */ }
  subs.forEach((f) => f());
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useNotes = (runId?: string) => useSyncExternalStore(subscribe, () => (runId ? load(runId) : NONE));

export function addNote(runId: string, t_s: number, text: string) {
  const note = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, t_s, text };
  save(runId, [...load(runId), note].sort((a, b) => a.t_s - b.t_s));
}
export function removeNote(runId: string, id: string) {
  save(runId, load(runId).filter((n) => n.id !== id));
}
