// The cross-version compatibility matrix (test/compat/harness.mjs): Kea PC and phone against KeaC and KeaS, and KeaS
// against KeaC, each pair as current x current, current client x previous server(s), previous client x current
// server. Every cell runs real servers on 127.0.0.1 port 0 with scratch data, in a child process of its own.
// The same file is in Kea, KeaS and KeaC: keep them the same. The version contract is test/compat/protocol.test.mjs.
//   node --test test/compat/compat.test.mjs        (KEA_COMPAT_ONLY=<text> runs only cells whose name has it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrix, runSpec, summary } from './harness.mjs';

const only = process.env.KEA_COMPAT_ONLY || '';
const cells = matrix().filter((c) => !only || c.id.includes(only));
// (Started together, a few at a time; each test waits for its own.)
const started = new Map(cells.filter((c) => c.spec).map((c) => [c.id, runSpec(c.spec)]));

for (const c of cells) {
  test(c.id, { skip: c.skip || false, timeout: 600_000 }, async (t) => {
    const res = await started.get(c.id);
    assert.equal(res.fatal, null, res.fatal);
    assert.ok(res.steps.length, `no steps ran\n${res.log}`);
    for (const s of res.steps) {
      if (s.skip) t.diagnostic(`skipped ${s.name}: ${s.skip}${s.observed ? ` (observed: ${JSON.stringify(s.observed)})` : ''}`);
      else if (s.ok && s.detail !== undefined) t.diagnostic(`${s.name}: ${JSON.stringify(s.detail)}`);
    }
    const failed = res.steps.filter((s) => s.ok === false);
    assert.deepEqual(failed.map((s) => s.name), [], `${summary(res)}\n\n${failed.map((s) => `${s.name}: ${s.error}${s.data ? `\n  data: ${JSON.stringify(s.data)}` : ''}`).join('\n\n')}`);
  });
}
