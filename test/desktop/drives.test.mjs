// Drives that can't hold a Hub (a cloud drive's virtual drive, a network, removable or CD drive) aren't offered, and a
// folder on one is refused (audit 2, 1.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../desktop/drives.cjs');

test('cloud, network, removable and CD drives are not for the Hub; drives inside the PC are', () => {
  const disks = d.parseLogicalDisks(JSON.stringify([
    { DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS', VolumeName: 'Windows', ProviderName: null },
    { DeviceID: 'D:', DriveType: 3, FileSystem: 'NTFS', VolumeName: 'Data', ProviderName: null },
    { DeviceID: 'G:', DriveType: 3, FileSystem: 'FAT32', VolumeName: 'Google Drive', ProviderName: null },
    { DeviceID: 'O:', DriveType: 3, FileSystem: 'NTFS', VolumeName: 'OneDrive - Contoso', ProviderName: null },
    { DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT', VolumeName: 'USB', ProviderName: null },
    { DeviceID: 'Z:', DriveType: 4, FileSystem: 'NTFS', VolumeName: 'share', ProviderName: '\\\\nas\\share' },
    { DeviceID: 'R:', DriveType: 5, FileSystem: null, VolumeName: null, ProviderName: null },
  ]));
  assert.equal(d.driveProblem(disks.C), null);
  assert.equal(d.driveProblem(disks.D), null);
  assert.match(d.driveProblem(disks.G), /Google Drive is a cloud drive/);
  assert.match(d.driveProblem(disks.O), /cloud drive/);
  assert.match(d.driveProblem(disks.E), /removable/);
  assert.match(d.driveProblem(disks.Z), /network/);
  assert.match(d.driveProblem(disks.R), /CD/);
  assert.equal(d.driveProblem(undefined), null, 'unknown: left to the folder check');
  // PowerShell gives one object, not a list, when there's one drive; and garbage gives nothing.
  assert.deepEqual(Object.keys(d.parseLogicalDisks('{"DeviceID":"C:","DriveType":3}')), ['C']);
  assert.deepEqual(d.parseLogicalDisks('not json'), {});
});

test('this PC’s drives can be read (read only)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const disks = await d.logicalDisks();
  assert.equal(typeof disks, 'object');
  if (disks.C) assert.equal(d.driveProblem(disks.C), null);
});
