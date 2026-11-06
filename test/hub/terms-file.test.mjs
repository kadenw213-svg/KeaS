import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';

const shipped = JSON.parse(readFileSync(new URL('../../hub/terms/terms.json', import.meta.url), 'utf8'));

test('the terms file: published once, again when an update changes it, and owner-published terms stay until then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kea-terms-file-'));
  const termsFile = join(dir, 'terms.json');
  const NEW = ['phone-number', 'notifications', 'supporters'];
  const before = { ...shipped, sections: shipped.sections.filter((s) => !NEW.includes(s.id)) };
  writeFileSync(termsFile, JSON.stringify(before));
  const open = () => createHub({ dataDir: dir, termsFile, log: false });
  const versions = (hub) => hub.h.all('SELECT n, sections FROM terms_versions ORDER BY n');
  try {
    let hub = open();
    assert.equal(versions(hub).length, 1);
    await hub.close();

    hub = open();
    assert.equal(versions(hub).length, 1, 'same file: nothing new');
    // The owner publishes a correction from the console: kept across restarts while the file is unchanged.
    hub.h.run('INSERT INTO terms_versions (label,title,summary,sections,published_at) VALUES (?,?,?,?,?)', 'owner', before.title, '', JSON.stringify(before.sections.map((s) => (s.id === 'law' ? { ...s, body: `${s.body} (corrected)` } : s))), Date.now());
    await hub.close();
    hub = open();
    assert.equal(versions(hub).length, 2);
    await hub.close();

    // An update ships the phone number, notifications and supporter sections: published, and they're the only new ones
    // (so people agree again to only those).
    writeFileSync(termsFile, JSON.stringify(shipped));
    hub = open();
    const all = versions(hub);
    assert.equal(all.length, 3);
    const ids = (v) => JSON.parse(v.sections).map((s) => s.id);
    assert.deepEqual(ids(all[2]).filter((id) => !ids(all[0]).includes(id)), NEW);
    const changed = JSON.parse(all[2].sections).filter((s) => { const o = JSON.parse(all[0].sections).find((x) => x.id === s.id); return o && (o.body !== s.body || o.title !== s.title); });
    assert.deepEqual(changed.map((s) => s.id), [], 'no existing section changed');
    await hub.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
