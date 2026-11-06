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
  const before = { ...shipped, sections: shipped.sections.filter((s) => s.id !== 'parent-sign-off') };
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

    // An update ships the parent sign-off section: published, and it's the only new section.
    writeFileSync(termsFile, JSON.stringify(shipped));
    hub = open();
    const all = versions(hub);
    assert.equal(all.length, 3);
    const ids = (v) => JSON.parse(v.sections).map((s) => s.id);
    assert.deepEqual(ids(all[2]).filter((id) => !ids(all[0]).includes(id)), ['parent-sign-off']);
    await hub.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
