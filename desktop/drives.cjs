// Which drives can hold the Hub's data. Only drives inside this PC: a cloud drive's virtual drive (Google Drive,
// OneDrive, Dropbox, Box...), a network drive, a removable drive or a CD isn't offered, and a folder on one is refused
// (the database on a synced or network drive gets corrupted, and the task that starts the Hub before sign-in can't
// reach a network drive at all).
'use strict';
const { execFile } = require('child_process');
const path = require('path');

const CLOUD = /google\s*drive|onedrive|dropbox|\bbox\b|icloud|mega|pcloud|sync\.com|nextcloud|owncloud/i;
const TYPES = { 2: 'a removable drive', 4: 'a network drive', 5: 'a CD or DVD drive', 6: 'a RAM disk' };

/** Why a drive can't hold the Hub's data (null: it can). d: { driveType, fileSystem, label, provider }. */
function driveProblem(d = {}) {
  if (d.label && CLOUD.test(d.label)) return `${d.label} is a cloud drive (its files sync somewhere else)`;
  if (d.provider) return 'it’s a network drive';
  if (TYPES[d.driveType]) return `it’s ${TYPES[d.driveType]}`;
  return null;
}

/** Win32_LogicalDisk rows (PowerShell's JSON: one object or a list) -> { [letter]: { driveType, fileSystem, label, provider } }. */
function parseLogicalDisks(json) {
  let rows;
  try { rows = JSON.parse(json || '[]'); } catch { return {}; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const out = {};
  for (const r of rows) {
    const letter = String(r.DeviceID || '').replace(':', '').toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    out[letter] = { driveType: Number(r.DriveType) || 0, fileSystem: r.FileSystem || null, label: r.VolumeName || null, provider: r.ProviderName || null };
  }
  return out;
}

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let cache = null;
/** What Windows says about each drive (read only), cached for half a minute. */
function logicalDisks() {
  if (cache && Date.now() - cache.at < 30_000) return Promise.resolve(cache.v);
  return new Promise((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem,VolumeName,ProviderName | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      const v = err ? {} : parseLogicalDisks(stdout);
      if (!err) cache = { at: Date.now(), v };
      resolve(v);
    });
  });
}

module.exports = { driveProblem, parseLogicalDisks, logicalDisks };
