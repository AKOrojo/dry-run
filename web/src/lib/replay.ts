// Replay plays back recorded agent sessions only (dryrun/agent/replay.py), matched on the exact question.

/** Whether to say why Ask is off: Replay is on and the box holds a question that was not recorded. */
export const replayHint = (provider: string, q: string, recorded: string[]) => provider === "replay" && q.trim() !== "" && !recorded.includes(q);
