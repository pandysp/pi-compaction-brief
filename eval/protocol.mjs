// Fixed cuts make every implementation see the same source, independent of output length.
// Each implementation owns its own previous checkpoint; recent turns remain visible.
export async function replay(fixture, summarize, options) {
  const entries = [], checkpoints = [];
  let serial = 0, previous, start = 0;
  const add = (fields) => {
    const id = `e${++serial}`;
    const item = { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(serial * 1000).toISOString(), ...fields };
    entries.push(item);
    return item;
  };
  const user = text => add({ type: 'message', message: { role: 'user', content: text, timestamp: (serial + 1) * 1000 } });
  for (const step of [fixture, ...(fixture.next ? [fixture.next] : [])]) {
    step.older.forEach(user);
    const cut = entries.length;
    const recent = user(step.recent);
    const preparation = {
      firstKeptEntryId: recent.id, previousSummary: previous?.summary,
      messagesToSummarize: entries.slice(start, cut).filter(e => e.type === 'message').map(e => e.message),
      turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 0,
      fileOps: { read: new Set(), edited: new Set(), written: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1500 },
    };
    const out = await summarize(preparation, { ...options, branchEntries: entries, sessionFile: '/fictional/session.jsonl' });
    const marker = '\n</user-messages>\n\n';
    const end = out.summary.indexOf(marker);
    // v0.1.0 predates the separate written field. New candidates need no particular delimiter.
    const written = out.written ?? (end < 0 ? null : out.summary.slice(end + marker.length).split('\n<modified-files>')[0].trim());
    if (typeof written !== 'string' || !written.trim()) throw Error('Candidate must return a nonempty written brief');
    checkpoints.push({ cut: recent.id, summary: out.summary, written, recent: step.recent });
    previous = add({ type: 'compaction', summary: out.summary, firstKeptEntryId: recent.id, tokensBefore: 0, fromHook: true, details: out.details });
    start = cut;
  }
  return checkpoints;
}

export function verdict(raw, count) {
  const v = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  for (const label of ['X', 'Y']) {
    if (!Array.isArray(v[label]) || v[label].length !== count || v[label].some(b => typeof b !== 'boolean')) throw Error('Expected one boolean per rubric fact and label');
  }
  if (!['X','Y','tie','both_fail'].includes(v.preference) || typeof v.reason !== 'string' || !v.reason.trim()) throw Error('Invalid judge preference or reason');
  const ok = label => v[label].every(Boolean);
  // Facts outrank style. A compelling explanation cannot excuse a missing constraint.
  const decision = !ok('X') && !ok('Y') ? 'both_fail' : !ok('X') ? 'Y' : !ok('Y') ? 'X' : v.preference;
  return { ...v, decision };
}
export function reconcile(votes) {
  if (votes.length !== 2) throw Error('Both orders required');
  return votes[0] === votes[1] ? votes[0] : 'inconclusive';
}
