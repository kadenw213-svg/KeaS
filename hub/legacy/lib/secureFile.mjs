// Secret files the Hub makes (its signing key, the owner key): readable by the account running the Hub only.
// On Linux and macOS the file mode (0600) does that. On Windows the mode is ignored, so the file's ACL is set instead
// with icacls: inherited entries removed, full control for the account running the Hub and for SYSTEM, nobody else.
// (The KeaS desktop also locks down the whole data folder; this never loosens anything it set.)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// (Full paths: a Git or MSYS whoami earlier on PATH takes different arguments.)
const sys32 = (exe) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);

let sid = null;
function currentSid() {
  if (sid) return sid;
  // "DOMAIN\user","S-1-5-21-..."
  const out = execFileSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  if (!m) throw new Error('no SID');
  return (sid = m[1]);
}

/** Restricts an existing file to the current account (and SYSTEM on Windows). Returns true when it worked. */
export function restrictFile(file) {
  if (process.platform !== 'win32') return true;
  try {
    execFileSync(sys32('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${currentSid()}:F`, '/grant:r', '*S-1-5-18:F'], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
    return true;
  } catch (e) {
    console.warn(`Kea Hub warning: couldn't limit who can read ${file} (${e.message}). Keep the Hub's data folder private.`);
    return false;
  }
}

/** Writes a new secret file, readable by the current account only. */
export function writeSecretFile(file, data) {
  writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  restrictFile(file);
}
