// The cross-version compatibility matrix for Kea (PC and phone), KeaS and KeaC: which repos and releases, the cells,
// and running each cell in a child process of its own (test/compat/cell.mjs). The same file is in Kea, KeaS and KeaC
// (test/compat/harness.mjs): keep them the same.
//
// Each repo's copy finds the other two as siblings (../Kea, ../KeaS, ../KeaC next to its own repo), or at
// KEA_COMPAT_KEA_DIR, KEA_COMPAT_KEAS_DIR and KEA_COMPAT_KEAC_DIR. "Current" is a repo's working tree; a previous
// release is read with `git show` from that repo (read only: nothing in it changes) into a folder in the temp folder,
// kept there by commit (kea-compat-<repo>-<commit>), like KeaC's test/keas05.mjs. A missing repo or commit skips its
// cells with the reason.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const SELF = resolve(HERE, '..', '..');
const selfName = (() => {
  try {
    return { kea: 'Kea', keas: 'KeaS', keac: 'KeaC' }[JSON.parse(readFileSync(join(SELF, 'package.json'), 'utf8')).name] || null;
  } catch {
    return null;
  }
})();
const dirOf = (name, env) => process.env[env] || (selfName === name ? SELF : join(dirname(SELF), name));
export const DIRS = { kea: dirOf('Kea', 'KEA_COMPAT_KEA_DIR'), keas: dirOf('KeaS', 'KEA_COMPAT_KEAS_DIR'), keac: dirOf('KeaC', 'KEA_COMPAT_KEAC_DIR') };

// The previous releases tested against (commits in each repo).
export const RELEASES = {
  keac: [
    { label: '0.3.0', commit: '73e0ec7', has: { profilePatch: true } },
    { label: '0.2.0', commit: '2c1d1a0', has: { profilePatch: false } },
  ],
  keas: [{ label: '0.8.0', commit: '70cf250' }],
  kea: [{ label: '0.84.0', commit: '29ad5d8' }],
};
// What a release needs to run here (folders and files; read with git show).
const PATHS = {
  keac: ['server', 'vendor', 'package.json'],
  keas: ['hub', 'org', 'server/lib', 'shared', 'package.json'],
  kea: ['electron', 'mobile/src', 'src/lib', 'package.json', 'mobile/android/app/src/main/java/com/kea/scholar/Hub.java', 'mobile/android/app/src/main/java/com/kea/scholar/Orgs.java'],
};
const MARKER = { keac: 'server/index.mjs', keas: 'hub/index.mjs', kea: 'electron/hub.cjs' };
const isRepo = (d) => existsSync(join(d, '.git'));
const versionOf = (d) => {
  try {
    return JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};

/** A release's files in a temp folder (made once per commit), or { error }. */
export function extract(repo, commit) {
  const src = DIRS[repo];
  if (!isRepo(src)) return { error: `no ${repo} git repo at ${src}` };
  const out = join(tmpdir(), `kea-compat-${repo}-${commit}`);
  if (existsSync(join(out, 'complete'))) return { dir: out };
  const ls = spawnSync('git', ['-C', src, 'ls-tree', '-r', '-z', '--name-only', commit, '--', ...PATHS[repo]], { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, windowsHide: true });
  if (ls.status !== 0) return { error: `commit ${commit} isn't in ${src}: ${String(ls.stderr).trim()}` };
  const files = ls.stdout.split('\0').filter(Boolean);
  // One git process for every file: cat-file --batch answers "<sha> blob <size>\n<bytes>\n" for each "<commit>:<path>".
  const r = spawnSync('git', ['-C', src, 'cat-file', '--batch'], { input: files.map((f) => `${commit}:${f}\n`).join(''), maxBuffer: 1024 ** 3, windowsHide: true });
  if (r.status !== 0) return { error: `git cat-file failed in ${src}` };
  rmSync(out, { recursive: true, force: true });
  const buf = r.stdout;
  let at = 0;
  for (const f of files) {
    const nl = buf.indexOf(10, at);
    const head = buf.subarray(at, nl).toString();
    const m = /^\S+ blob (\d+)$/.exec(head);
    if (!m) return { error: `git cat-file: unexpected "${head}" for ${f}` };
    const size = Number(m[1]);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    mkdirSync(dirname(join(out, f)), { recursive: true });
    writeFileSync(join(out, f), body);
    at = nl + 1 + size + 1;
  }
  if (!existsSync(join(out, MARKER[repo]))) return { error: `${commit} has no ${MARKER[repo]}` };
  writeFileSync(join(out, 'complete'), `${files.length} files from ${repo} ${commit}\n`);
  return { dir: out };
}

/** The x-kea-client value the phone's Hub.java and Orgs.java send (a literal, or Kea-Phone/<Kea's version>). */
export function phoneHeaders(dir) {
  const one = (file) => {
    let src = '';
    try {
      src = readFileSync(join(dir, 'mobile/android/app/src/main/java/com/kea/scholar', file), 'utf8');
    } catch {
      return null;
    }
    const m = /setRequestProperty\(\s*"x-kea-client"\s*,\s*([^;]+)\);/i.exec(src);
    if (!m) return null;
    const expr = m[1].trim();
    if (/^"[^"]*"$/.test(expr)) return expr.slice(1, -1);
    if (/Kea-Phone\//.test(expr)) return `Kea-Phone/${versionOf(dir)}`;
    // (A helper that builds it, Hub.client(ctx): "Kea-Phone/" + the app's versionName, which is Kea's package.json version.)
    if (/\bclient\(/.test(expr)) {
      let hub = '';
      try {
        hub = readFileSync(join(dir, 'mobile/android/app/src/main/java/com/kea/scholar/Hub.java'), 'utf8');
      } catch {}
      if (/"Kea-Phone\/"/.test(hub)) return `Kea-Phone/${versionOf(dir)}`;
    }
    return expr;
  };
  return { hub: one('Hub.java'), orgs: one('Orgs.java') };
}

/** Current (working tree) and previous versions of a repo: [{ label, dir } | { label, error }]. */
function versions(repo) {
  const cur = DIRS[repo];
  const out = [existsSync(join(cur, MARKER[repo])) ? { label: `current ${versionOf(cur)}`, dir: cur, current: true } : { label: 'current', error: `no ${repo} at ${cur}` }];
  for (const rel of RELEASES[repo]) {
    const x = extract(repo, rel.commit);
    out.push({ label: rel.label, commit: rel.commit, has: rel.has, ...(x.error ? { error: x.error } : { dir: x.dir }) });
  }
  return out;
}

/** Every cell of the matrix: { id, group, flow, spec } or { id, group, skip }. */
export function matrix() {
  const keaNeeds = !existsSync(join(DIRS.kea, 'node_modules', 'esbuild')) ? `no node_modules/esbuild in ${DIRS.kea} (npm install there)` : null;
  const [keaCur, keaPrev] = versions('kea');
  const [keacCur, ...keacPrev] = versions('keac');
  const [keasCur, keasPrev] = versions('keas');
  const client = (v, kind) => (v.error ? v : { ...v, kind, ...(kind === 'phone' ? { phoneHeader: phoneHeaders(v.dir) } : {}) });
  const cells = [];
  const add = (group, flow, c, keac, keas = null) => {
    const id = `${group}: ${c.kind === 'phone' ? 'phone' : 'Kea'} ${c.label} x ${keas ? `KeaS ${keas.label} (KeaC ${keac.label})` : `KeaC ${keac.label}`}`;
    const missing = [c, keac, keas].filter(Boolean).find((x) => x.error)?.error || (c.kind === 'phone' || flow === 'pc-keas' ? keaNeeds : null);
    if (missing) return cells.push({ id, group, skip: missing });
    cells.push({ id, group, flow, spec: { flow, client: c, keac, keas, keaDir: DIRS.kea } });
  };
  for (const kind of ['pc', 'phone']) {
    const g = kind === 'pc' ? 'Kea PC -> KeaC' : 'Kea phone -> KeaC';
    const cur = client(keaCur, kind), prev = client(keaPrev, kind);
    add(g, `${kind}-keac`, cur, keacCur);
    for (const p of keacPrev) add(g, `${kind}-keac`, cur, p);
    add(g, `${kind}-keac`, prev, keacCur);
  }
  for (const kind of ['pc', 'phone']) {
    const g = kind === 'pc' ? 'Kea PC -> KeaS' : 'Kea phone -> KeaS';
    const cur = client(keaCur, kind), prev = client(keaPrev, kind);
    add(g, `${kind}-keas`, cur, keacCur, keasCur);
    add(g, `${kind}-keas`, cur, keacCur, keasPrev);
    add(g, `${kind}-keas`, prev, keacCur, keasCur);
  }
  // KeaS -> KeaC (driven by the current Kea PC joining an organization).
  const pc = client(keaCur, 'pc');
  add('KeaS -> KeaC', 'pc-keas', pc, keacCur, keasCur);
  for (const p of keacPrev) add('KeaS -> KeaC', 'pc-keas', pc, p, keasCur);
  add('KeaS -> KeaC', 'pc-keas', pc, keacCur, keasPrev);
  return cells;
}

/** The protocol cell: current client and servers only. */
export function protocolCell() {
  const [keaCur] = [versions('kea')[0]];
  const keacCur = versions('keac')[0], keasCur = versions('keas')[0];
  const miss = [keaCur, keacCur, keasCur].find((x) => x.error)?.error || (!existsSync(join(DIRS.kea, 'node_modules', 'esbuild')) ? `no node_modules/esbuild in ${DIRS.kea}` : null);
  if (miss) return { skip: miss };
  return { spec: { flow: 'protocol', client: { ...keaCur, kind: 'pc', phoneHeader: phoneHeaders(keaCur.dir) }, keac: keacCur, keas: keasCur, keaDir: DIRS.kea } };
}

/** Runs one cell's spec in a child process: { steps, fatal, ms }. Identical specs run once. */
const runs = new Map();
export function runSpec(spec, { timeoutMs = 120_000 } = {}) {
  const key = JSON.stringify(spec);
  if (runs.has(key)) return runs.get(key);
  const p = gate(() => new Promise((done) => {
    const dir = mkdtempSync(join(tmpdir(), 'kea-compat-run-'));
    const specFile = join(dir, 'spec.json'), outFile = join(dir, 'out.json');
    writeFileSync(specFile, JSON.stringify(spec));
    const t0 = Date.now();
    let log = '';
    const child = spawn(process.execPath, [join(HERE, 'cell.mjs'), specFile, outFile], {
      cwd: dir,
      env: { ...process.env, NODE_PATH: join(DIRS.kea, 'node_modules'), KEAC_RELEASE_FEEDS: '0', KEAS_RELEASE_FEEDS: '0', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (log = (log + d).slice(-8000)));
    child.stderr.on('data', (d) => (log = (log + d).slice(-8000)));
    // (Settles exactly once: when the cell exits, when it couldn't be started, or a few seconds after it was killed
    // for taking too long even if its exit never comes, so a stuck cell is a failure with its log, never a hang.)
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      let res;
      try {
        res = JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        res = { steps: [], fatal: `the cell ${why} without a result:\n${log}` };
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      done({ ...res, ms: Date.now() - t0, log });
    };
    let grace = null;
    const timer = setTimeout(() => {
      log += `\n(compat: timed out after ${timeoutMs} ms; killed pid ${child.pid})`;
      child.kill();
      grace = setTimeout(() => finish('was killed after a timeout'), 5000);
    }, timeoutMs);
    child.on('error', (e) => {
      log += `\n(compat: couldn't run the cell: ${e?.message || e})`;
      finish('could not start');
    });
    child.on('exit', (code) => finish(`exited (${code})`));
  }));
  runs.set(key, p);
  return p;
}
// A few cells at a time.
const LIMIT = Math.max(2, Math.min(6, Number(process.env.KEA_COMPAT_JOBS) || Math.floor(cpus().length / 2)));
let active = 0;
const queue = [];
function gate(fn) {
  return new Promise((res, rej) => {
    const go = () => {
      active++;
      fn().then(res, rej).finally(() => {
        active--;
        queue.shift()?.();
      });
    };
    active < LIMIT ? go() : queue.push(go);
  });
}

/** Asserts a cell's steps: every step passed (skipped ones say why). Returns a one-line summary. */
export function summary(res) {
  return res.steps.map((s) => `${s.skip ? 'SKIP' : s.ok ? 'ok' : 'FAIL'} ${s.name}${s.skip ? ` (${s.skip})` : ''}`).join('; ');
}
