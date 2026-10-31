// Boards that are not on first paint load in their own chunk. `lazyNamed(() => import("../components/X"), "Y")` is a
// drop-in for the named component Y: it renders nothing until the chunk arrives.
import { Component, lazy, Suspense } from "react";
import type { ComponentType, ReactNode } from "react";

// A tab left open across a deploy asks for chunk hashes that no longer exist. Reload once to pick up the new build;
// the sessionStorage stamp stops a loop when the chunk really is unavailable (the error boundary then shows).
const RELOAD_KEY = "dr_chunk_reload", RELOAD_WINDOW_MS = 60_000;

/** Reloads the page unless it already did so in the last minute; false when it did not reload. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (last && Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { return false; }
  window.location.reload();
  return true;
}

// When main.tsx's vite:preloadError handler has started a reload, Vite resolves the import with undefined: wait for it.
const retryOnce = <M,>(load: () => Promise<M>) =>
  load().then((m) => m ?? new Promise<M>(() => {})).catch(() => new Promise<M>((ok, fail) => setTimeout(() => load().then(ok, fail), 500)))
    .catch((err: unknown) => (reloadForNewBuild() ? new Promise<M>(() => {}) : Promise.reject(new ChunkError(err))));

class ChunkError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); this.name = "ChunkError"; }
}

/** A chunk that could not load costs only its own piece of the page (many sit outside the panel boundaries); any other
 *  error goes on to the nearest ErrorBoundary. */
class ChunkBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { if (error instanceof ChunkError) console.error("A part of the page could not load:", error.message); }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.state.error instanceof ChunkError) return null;
    throw this.state.error;
  }
}

export function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K): M[K] {
  const L = lazy(() => retryOnce(load).then((m) => ({ default: m[name] as unknown as ComponentType<object> })));
  const C = (props: object) => <ChunkBoundary><Suspense fallback={null}><L {...props} /></Suspense></ChunkBoundary>;
  C.displayName = `Lazy(${String(name)})`;
  return C as unknown as M[K];
}
