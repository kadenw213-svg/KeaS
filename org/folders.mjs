// Shared work folders: files an organization keeps together, synced to everyone it's shared with (Kea mirrors each
// folder into Documents/<Org>/<Folder>/). Mounted by mountOrg (./index.mjs) when the host gives it a folderDir.
//
// - Access is view, edit or manage, given to a person, a role or everyone in the organization. Someone's access is
//   the highest of their own grant, their roles' grants and the org-wide grant. Owners, and people whose role has
//   folders.manage (org-wide), manage every folder. Someone who isn't an active member gets nothing, whatever their
//   grants say. Whoever makes a folder manages it (an ordinary grant, so it can be changed), and a folder always keeps
//   at least one manage grant.
// - Claude: each folder says whether Claude may use its files (on by default), and each file can override it
//   (org_folder_files.claude NULL: as the folder). Only managers change it. Files with Claude off still download.
// - Deleting a folder puts it in the bin for 30 days; an owner can restore it. After that it and its files go.
// - The files themselves go through handle() (the host routes GET/PUT/DELETE /v1/orgs/:id/folders/:fid/files/<path>
//   to it, beside its own /v1/files): the same rules as a member's files area (versions, ETag, If-Match,
//   If-None-Match, x-kea-sha256, path checks, the size limit, 507 when full).
// - Storage: the host's folderQuota(orgId) -> { limit, used } in bytes. Without one, the organization's
//   sharedFilesGb setting (5 GB by default) against everything its folders hold (the bin included).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

export const ACCESS_LEVELS = ['view', 'edit', 'manage'];
const RANK = { view: 1, edit: 2, manage: 3 };
const top = (a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a);
export const FOLDER_KEEP_DAYS = 30;
const DAY = 86400_000;
const NOTICE_GAP = 3600_000;
const MAX_FOLDERS = 500;
const MAX_GRANTS = 1000;
/** The raw file URL a host routes to handle(): /v1/orgs/<org id>/folders/<folder id>/files/<path>. */
export const FOLDER_FILE_URL = /^\/v1\/orgs\/([^/]+)\/folders\/([^/]+)\/files\/(.+)$/;
const FILE_METHODS = new Set(['GET', 'PUT', 'DELETE']);
const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
/**
 * Is this request a shared folder file (for handle)? { orgId, folderId, path } (path null when it doesn't decode), or
 * null. Only GET, PUT and DELETE: PATCH …/files/claude is a JSON route.
 */
export function matchFolderFile(method, pathname) {
  if (!FILE_METHODS.has(method)) return null;
  const m = FOLDER_FILE_URL.exec(pathname);
  if (!m) return null;
  return { orgId: decode(m[1]) ?? '', folderId: decode(m[2]) ?? '', path: decode(m[3]) };
}

// ---------- paths (the same rules as /v1/files) ----------
const SEGMENT = /^[\p{L}\p{N} ._()+@,'&!~-]{1,120}$/u;
function plainDecoded(seg) {
  let d = seg;
  if (seg.includes('~')) { try { d = seg.replace(/~([0-9a-f]+)~/g, (_, x) => String.fromCodePoint(parseInt(x, 16))); } catch { return false; } }
  if (!d || d === '.' || d === '..' || d.trim() === '') return false;
  if (/[\\/:\x00-\x1f\x7f]/.test(d)) return false;
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(d)) return false;
  return true;
}
/** Names Kea keeps for itself in a mirrored folder (.kea-project.json and the like). */
const keptName = (seg) => /^\.kea-/i.test(seg);
/** A folder file's path, checked (or an HttpError 400 saying why). */
export function checkFolderPath(p, bad) {
  if (typeof p !== 'string' || !p) bad('Say which file: a path inside the shared folder.');
  if (p.length > 500) bad('That path is too long.');
  const parts = p.split('/');
  if (parts.length > 12 || parts.some((s) => !SEGMENT.test(s) || s === '.' || s === '..' || s.trim() !== s || !plainDecoded(s))) bad('That file path has characters shared folders don’t allow.');
  if (parts.some(keptName)) bad('Names starting with .kea- are kept for Kea’s own use. Pick another name.');
  return parts.join('/');
}
/** A folder's name: it becomes a folder on people's computers, so the same rules as one path segment. */
function folderName(v, V, bad) {
  const n = V.name(v, 'Name', { min: 1, max: 80 });
  if (!SEGMENT.test(n) || !plainDecoded(n) || /[. ]$/.test(n) || keptName(n)) bad('A shared folder’s name can have letters, numbers, spaces and . _ ( ) + @ , \' & ! ~ -, and can’t end with a dot.');
  return n;
}
const etagVersion = (v) => { const m = /^"?(\d+)"?$/.exec(String(v ?? '').trim()); return m ? Number(m[1]) : null; };
const fmtSize = (b) => (b >= 1024 ** 3 ? `${Math.round((b / 1024 ** 3) * 10) / 10} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

/**
 * Mounts the folder routes on R (the org guard). folderDir: where blobs go (one folder per organization).
 * folderQuota(orgId) -> { limit, used }. limits: { maxFileBytes, maxFilesPerFolder }. check({ me, orgId, folderId,
 * method, size, phase }): the host's own limits on a file call (rate limits, free disk, daily budgets), called with
 * phase 'start' (before anything is read or sent; for GET the file's size, for PUT what it announced or 0),
 * 'arrived' (PUT: the whole body is here) and 'saved' (PUT: it's stored); it throws to refuse.
 */
export function mountFolders(core, { R, folderDir, folderQuota = null, limits = {}, check = null }) {
  const { h, now, audit, notify, identity, V, HttpError, bad, forbidden, notFound, tx, asOrg, J } = core;
  const maxFileBytes = limits.maxFileBytes ?? 64 * 1024 ** 2;
  const maxFilesPerFolder = limits.maxFilesPerFolder ?? 20_000;
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const orgDir = (oid) => join(folderDir, sha(`org:${oid}`).slice(0, 32));
  const blobPath = (oid, blob) => join(orgDir(oid), blob);

  // ---------- storage ----------
  const orgBytes = (oid) => h.get('SELECT COALESCE(SUM(f.size),0) AS n FROM org_folder_files f JOIN org_folders d ON d.id = f.folder_id WHERE d.org_id = ?', oid).n;
  const defaultQuota = (oid) => {
    const o = core.loadOrg(oid);
    const gb = o ? core.orgSettings(o).sharedFilesGb : 0;
    return { limit: Math.round((typeof gb === 'number' && gb >= 0 ? gb : 5) * 1024 ** 3), used: orgBytes(oid) };
  };
  const quotaNow = (oid) => {
    const q = (folderQuota ?? defaultQuota)(oid) || {};
    return { limit: Math.max(0, Number(q.limit) || 0), used: Math.max(0, Number(q.used) || 0) };
  };

  // ---------- the bin ----------
  let lastPurge = -Infinity;
  /** Folders in the bin longer than FOLDER_KEEP_DAYS: gone, files and all. Returns how many. */
  function purgeDeleted({ force = false } = {}) {
    if (!force && now() - lastPurge < 3600_000) return 0;
    lastPurge = now();
    const old = h.all('SELECT id, org_id FROM org_folders WHERE deleted_at IS NOT NULL AND deleted_at <= ?', now() - FOLDER_KEEP_DAYS * DAY);
    for (const f of old) {
      const blobs = h.all('SELECT blob FROM org_folder_files WHERE folder_id = ?', f.id).map((r) => r.blob);
      tx(() => {
        h.run('DELETE FROM org_folder_files WHERE folder_id = ?', f.id);
        h.run('DELETE FROM org_folder_access WHERE folder_id = ?', f.id);
        h.run('DELETE FROM org_folders WHERE id = ?', f.id);
      });
      for (const b of blobs) rm(blobPath(f.org_id, b), { force: true }).catch(() => {});
      audit(null, 'folder.purge', f.id, { orgId: f.org_id }, null);
    }
    return old.length;
  }

  // ---------- access ----------
  /** What the caller's membership says about every folder: owner, folders.manage (org-wide), their role ids. */
  const viewer = (x) => ({
    id: x.who.id, owner: !!x.owner, all: x.eff.owner || x.eff.map.get('folders.manage') === true,
    roles: new Set(h.all('SELECT role_id FROM org_role_assignments WHERE org_id = ? AND account_id = ?', x.o.id, x.who.id).map((r) => r.role_id)),
  });
  /** The same for any member (null when they aren't an active member). */
  const viewerOf = (oid, aid) => {
    const m = core.memberRow(oid, aid);
    if (!m || m.status !== 'active') return null;
    const eff = core.effOf(oid, aid, undefined, m);
    return { id: aid, owner: eff.owner, all: eff.owner || eff.map.get('folders.manage') === true, roles: new Set(h.all('SELECT role_id FROM org_role_assignments WHERE org_id = ? AND account_id = ?', oid, aid).map((r) => r.role_id)) };
  };
  const grantsOf = (fid) => h.all('SELECT subject_kind, subject_id, access FROM org_folder_access WHERE folder_id = ?', fid);
  /** 'view' | 'edit' | 'manage' | null, from the folder's grants (rows) for one viewer. */
  function accessFrom(v, rows) {
    if (!v) return null;
    if (v.all) return 'manage';
    let a = null;
    for (const g of rows) {
      if ((g.subject_kind === 'account' && g.subject_id === v.id) || (g.subject_kind === 'role' && v.roles.has(g.subject_id)) || g.subject_kind === 'org') a = top(a, g.access);
    }
    return a;
  }
  const folderRow = (oid, fid, { deleted = false } = {}) => h.get(`SELECT * FROM org_folders WHERE id = ? AND org_id = ? AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL`, fid, oid);
  /** The org, the folder and my access to it, or 404 (a folder I can't see isn't there) or 403 (not enough access). */
  function folderFor(oid, fid, me, need = 'view') {
    const x = asOrg(oid, me);
    const f = folderRow(x.o.id, String(fid)) ?? notFound('No such shared folder.');
    const access = accessFrom(viewer(x), grantsOf(f.id));
    if (!access) notFound('No such shared folder.');
    if (RANK[access] < RANK[need]) {
      if (need === 'edit') forbidden('You can only view this shared folder. Ask whoever manages it to let you edit.');
      forbidden('Only people who manage this shared folder can do that.');
    }
    return { x, f, access };
  }

  // ---------- answers ----------
  const statsOf = (oid) => new Map(h.all('SELECT f.folder_id AS id, COUNT(*) AS n, COALESCE(SUM(f.size),0) AS size FROM org_folder_files f JOIN org_folders d ON d.id = f.folder_id WHERE d.org_id = ? GROUP BY f.folder_id', oid).map((r) => [r.id, r]));
  const folderOut = (f, access, stats = statsOf(f.org_id)) => {
    const s = stats.get(f.id);
    return {
      id: f.id, orgId: f.org_id, name: f.name, access, claude: !!f.claude, size: s?.size ?? 0, fileCount: s?.n ?? 0,
      updatedAt: Math.max(f.updated_at || 0, f.created_at), createdAt: f.created_at, createdBy: f.created_by ?? null,
      ...(f.deleted_at != null ? { deletedAt: f.deleted_at, purgeAt: f.deleted_at + FOLDER_KEEP_DAYS * DAY } : {}),
    };
  };
  const fileOut = (r, f, names) => ({
    path: r.path, size: r.size, version: r.version, sha256: r.sha256, updatedAt: r.updated_at,
    updatedBy: r.updated_by ?? null, updatedByName: r.updated_by ? names.get(r.updated_by) ?? null : null,
    claude: r.claude == null ? !!f.claude : !!r.claude, claudeOverride: r.claude == null ? null : !!r.claude,
  });
  function accessOut(f) {
    const oid = f.org_id;
    const rows = grantsOf(f.id);
    const roles = new Map(h.all('SELECT id, name, template_key, abilities FROM org_roles WHERE org_id = ?', oid).map((r) => [r.id, r]));
    const people = core.profilesOf(rows.filter((g) => g.subject_kind === 'account').map((g) => g.subject_id));
    const order = { org: 0, role: 1, account: 2 };
    const grants = rows
      .filter((g) => g.subject_kind !== 'role' || roles.has(g.subject_id))
      .map((g) => ({
        kind: g.subject_kind, id: g.subject_kind === 'org' ? null : g.subject_id, access: g.access,
        name: g.subject_kind === 'org' ? null : g.subject_kind === 'role' ? roles.get(g.subject_id).name : people.get(g.subject_id)?.name ?? null,
        ...(g.subject_kind === 'account' ? { member: core.memberRow(oid, g.subject_id)?.status === 'active' } : {}),
      }))
      .sort((a, b) => order[a.kind] - order[b.kind] || String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.id).localeCompare(String(b.id)));
    // Who manages every folder anyway: owners, and roles with folders.manage.
    const owners = core.ownersOf(oid);
    const op = core.profilesOf(owners);
    const manageRoles = [...roles.values()].filter((r) => r.template_key === 'owner' || J(r.abilities, []).includes('folders.manage'));
    return {
      folderId: f.id, grants,
      alwaysManage: { owners: owners.map((id) => ({ id, name: op.get(id)?.name ?? null })), roles: manageRoles.map((r) => ({ id: r.id, name: r.name })) },
    };
  }

  // ---------- notices ----------
  /** A new file: everyone else who can see the folder hears about it, at most once an hour per folder. */
  function tellAboutNewFile(x, f, path) {
    const t = now();
    if (f.notified_at != null && t - f.notified_at < NOTICE_GAP) return;
    const r = h.run('UPDATE org_folders SET notified_at = ? WHERE id = ? AND (notified_at IS NULL OR notified_at <= ?)', t, f.id, t - NOTICE_GAP);
    if (!Number(r.changes)) return;
    const rows = grantsOf(f.id);
    const by = x.who.name || 'Someone';
    for (const m of h.all("SELECT account_id FROM org_members WHERE org_id = ? AND status = 'active' LIMIT 5000", f.org_id)) {
      if (m.account_id === x.who.id) continue;
      if (!accessFrom(viewerOf(f.org_id, m.account_id), rows)) continue;
      notify(m.account_id, 'folder', `New files in ${f.name}`, `${by} added ${path.split('/').pop()} to ${f.name} (${x.o.name}). Kea brings shared files to your computer.`, { data: { orgId: f.org_id, folderId: f.id, path } });
    }
  }

  // ---------- routes ----------
  const bump = (fid) => h.run('UPDATE org_folders SET updated_at = ? WHERE id = ?', now(), fid);
  const sameName = (oid, name, except = null) => h.get('SELECT id FROM org_folders WHERE org_id = ? AND deleted_at IS NULL AND lower(name) = lower(?) AND id != ?', oid, name, except ?? '');
  const nameTaken = (name) => { throw new HttpError(409, `There’s already a shared folder called ${name} here. Pick another name.`); };

  // The folders I can see (with ?deleted=1, owners: the bin).
  R('GET', '/v1/orgs/:id/folders', ({ me, params, query }) => {
    purgeDeleted();
    const x = asOrg(params.id, me);
    const v = viewer(x);
    const stats = statsOf(x.o.id);
    const q = quotaNow(x.o.id);
    if (query.deleted === '1' || query.deleted === 'true') {
      if (!x.owner) forbidden('Only an owner of the organization can see deleted shared folders.');
      return { folders: h.all('SELECT * FROM org_folders WHERE org_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', x.o.id).map((f) => folderOut(f, 'manage', stats)), quota: q };
    }
    const all = h.all('SELECT * FROM org_folders WHERE org_id = ? AND deleted_at IS NULL ORDER BY lower(name), id', x.o.id);
    const grants = new Map();
    for (const g of h.all('SELECT a.* FROM org_folder_access a JOIN org_folders f ON f.id = a.folder_id WHERE f.org_id = ? AND f.deleted_at IS NULL', x.o.id)) {
      if (!grants.has(g.folder_id)) grants.set(g.folder_id, []);
      grants.get(g.folder_id).push(g);
    }
    const folders = [];
    for (const f of all) { const a = accessFrom(v, grants.get(f.id) ?? []); if (a) folders.push(folderOut(f, a, stats)); }
    return { folders, canCreate: v.all || x.s.folders.anyoneCreates !== false, quota: q };
  });

  R('POST', '/v1/orgs/:id/folders', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me);
    const v = viewer(x);
    if (!v.all && x.s.folders.anyoneCreates === false) core.deny('folders.manage');
    const name = folderName(body.name, V, bad);
    const claude = body.claude == null ? true : V.bool(body.claude, 'Claude may use these files');
    if (sameName(x.o.id, name)) nameTaken(name);
    if (h.get('SELECT COUNT(*) AS n FROM org_folders WHERE org_id = ?', x.o.id).n >= MAX_FOLDERS) bad(`This organization has the most shared folders it can have (${MAX_FOLDERS}). Delete some first.`);
    const fid = core.id();
    tx(() => {
      h.run('INSERT INTO org_folders (id,org_id,name,created_by,created_at,claude,updated_at) VALUES (?,?,?,?,?,?,?)', fid, x.o.id, name, x.who.id, now(), claude ? 1 : 0, now());
      h.run("INSERT INTO org_folder_access (folder_id,subject_kind,subject_id,access) VALUES (?,'account',?,'manage')", fid, x.who.id);
    });
    audit(x.who.id, 'folder.create', fid, { orgId: x.o.id, name }, ip);
    return { status: 201, body: { folder: folderOut(folderRow(x.o.id, fid), 'manage') } };
  });

  R('PATCH', '/v1/orgs/:id/folders/:fid', ({ me, params, body, ip }) => {
    const { x, f, access } = folderFor(params.id, params.fid, me, 'manage');
    const name = body.name == null ? f.name : folderName(body.name, V, bad);
    const claude = body.claude == null ? !!f.claude : V.bool(body.claude, 'Claude may use these files');
    if (name !== f.name && sameName(f.org_id, name, f.id)) nameTaken(name);
    h.run('UPDATE org_folders SET name = ?, claude = ?, updated_at = ? WHERE id = ?', name, claude ? 1 : 0, now(), f.id);
    if (name !== f.name) audit(x.who.id, 'folder.rename', f.id, { orgId: f.org_id, from: f.name, to: name }, ip);
    if (claude !== !!f.claude) audit(x.who.id, 'folder.claude', f.id, { orgId: f.org_id, claude }, ip);
    return { folder: folderOut(folderRow(f.org_id, f.id), access) };
  });

  // Into the bin: gone for everyone, kept FOLDER_KEEP_DAYS days for an owner to restore.
  R('DELETE', '/v1/orgs/:id/folders/:fid', ({ me, params, ip }) => {
    const { x, f } = folderFor(params.id, params.fid, me, 'manage');
    const t = now();
    h.run('UPDATE org_folders SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?', t, x.who.id, t, f.id);
    audit(x.who.id, 'folder.delete', f.id, { orgId: f.org_id, name: f.name }, ip);
    return { ok: true, deletedAt: t, purgeAt: t + FOLDER_KEEP_DAYS * DAY };
  });

  R('POST', '/v1/orgs/:id/folders/:fid/restore', ({ me, params, ip }) => {
    const x = asOrg(params.id, me);
    if (!x.owner) forbidden('Only an owner of the organization can bring back a deleted shared folder.');
    const f = folderRow(x.o.id, String(params.fid), { deleted: true }) ?? notFound('That shared folder isn’t in the deleted folders (after 30 days they’re gone for good).');
    if (sameName(x.o.id, f.name)) throw new HttpError(409, `There’s a shared folder called ${f.name} again. Rename that one first, then bring this one back.`);
    h.run('UPDATE org_folders SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?', now(), f.id);
    audit(x.who.id, 'folder.restore', f.id, { orgId: f.org_id, name: f.name }, ip);
    return { folder: folderOut(folderRow(x.o.id, f.id), 'manage') };
  });

  R('GET', '/v1/orgs/:id/folders/:fid/access', ({ me, params }) => accessOut(folderFor(params.id, params.fid, me, 'manage').f));

  // Replaces who has what: grants [{ kind: 'account' | 'role' | 'org', id, access: 'view' | 'edit' | 'manage' }].
  R('PUT', '/v1/orgs/:id/folders/:fid/access', ({ me, params, body, ip }) => {
    const { x, f } = folderFor(params.id, params.fid, me, 'manage');
    const oid = f.org_id;
    if (!Array.isArray(body.grants) || body.grants.length > MAX_GRANTS) bad(`Send grants: a list (at most ${MAX_GRANTS}) of { kind, id, access }.`);
    const next = new Map();
    const before = grantsOf(f.id);
    // (Someone who left keeps a grant already given, so a list sent back as it came is fine; it does nothing for them.)
    const had = new Set(before.filter((g) => g.subject_kind === 'account').map((g) => g.subject_id));
    for (const g of body.grants) {
      const o = V.obj(g);
      const kind = V.enum(o.kind, 'kind', ['account', 'role', 'org']);
      const access = V.enum(o.access, 'access', ACCESS_LEVELS);
      let sid = '*';
      if (kind === 'account') {
        sid = V.str(o.id, 'Person', { min: 1, max: 200 });
        if (!had.has(sid) && !core.memberRow(oid, sid)) bad('Someone in that list isn’t in this organization.');
      } else if (kind === 'role') {
        sid = V.str(o.id, 'Role', { min: 1, max: 200 });
        core.roleRow(oid, sid);
      }
      const k = `${kind}:${sid}`;
      next.set(k, { kind, sid, access: top(next.get(k)?.access ?? null, access) });
    }
    if (![...next.values()].some((g) => g.access === 'manage')) bad('A shared folder needs at least one person or role who manages it. Give someone else Manage first.');
    tx(() => {
      h.run('DELETE FROM org_folder_access WHERE folder_id = ?', f.id);
      for (const g of next.values()) h.run('INSERT INTO org_folder_access (folder_id,subject_kind,subject_id,access) VALUES (?,?,?,?)', f.id, g.kind, g.sid, g.access);
      bump(f.id);
    });
    const brief = (rows) => rows.map((g) => `${g.subject_kind ?? g.kind}:${g.subject_id ?? g.sid}=${g.access}`).sort();
    audit(x.who.id, 'folder.access', f.id, { orgId: oid, before: brief(before), after: brief([...next.values()]) }, ip);
    return accessOut(folderRow(oid, f.id));
  });

  // The files list: the /v1/files shape (used, quota, now, files, next with ?limit=), plus each file's resolved claude,
  // its own override, and who changed it last; and the folder itself.
  R('GET', '/v1/orgs/:id/folders/:fid/files', ({ me, params, query }) => {
    const { f, access } = folderFor(params.id, params.fid, me, 'view');
    const prefix = String(query.prefix ?? '');
    const since = Number(query.since) || 0;
    const paged = query.limit != null;
    const n = paged ? Math.min(5000, Math.max(1, Number(query.limit) || 1000)) : -1;
    const rows = h.all('SELECT * FROM org_folder_files WHERE folder_id = ? AND substr(path, 1, length(?)) = ? AND updated_at > ? AND path > ? ORDER BY path LIMIT ?', f.id, prefix, prefix, since, String(query.after ?? ''), paged ? n + 1 : -1);
    const more = paged && rows.length > n;
    if (more) rows.length = n;
    const names = core.names(f.org_id);
    const q = quotaNow(f.org_id);
    return {
      used: q.used, quota: q.limit, now: now(), folder: folderOut(f, access),
      files: rows.map((r) => fileOut(r, f, names)),
      ...(paged ? { next: more ? rows[rows.length - 1].path : null } : {}),
    };
  });

  R('PATCH', '/v1/orgs/:id/folders/:fid/files/claude', ({ me, params, body, ip }) => {
    const { x, f } = folderFor(params.id, params.fid, me, 'manage');
    const path = checkFolderPath(body.path, bad);
    if (!('claude' in body) || (body.claude !== null && typeof body.claude !== 'boolean')) bad('Send claude: true, false, or null (as the folder says).');
    const r = h.get('SELECT * FROM org_folder_files WHERE folder_id = ? AND path = ?', f.id, path) ?? notFound('No such file.');
    const v = body.claude == null ? null : body.claude ? 1 : 0;
    h.run('UPDATE org_folder_files SET claude = ?, updated_at = ? WHERE folder_id = ? AND path = ?', v, now(), f.id, path);
    bump(f.id);
    audit(x.who.id, 'folder.file_claude', f.id, { orgId: f.org_id, path, claude: body.claude }, ip);
    return { file: fileOut(h.get('SELECT * FROM org_folder_files WHERE folder_id = ? AND path = ?', f.id, path), f, core.names(f.org_id)) };
  });

  // ---------- the files themselves ----------
  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const answer = (res, status, payload, headers = {}) => { res.writeHead(status, { ...JSON_HEADERS, ...headers }); res.end(JSON.stringify(payload)); return status; };
  const reserved = new Map();
  /**
   * GET (view), PUT and DELETE (edit) of one file, streamed. me: the signed-in caller (as the org routes get it).
   * Errors are thrown as the host's HttpError (with extra fields, like the router's); answers are written to res.
   * Returns the status sent.
   */
  async function handle(req, res, me, orgId, folderId, rawPath, t0 = Date.now()) { // eslint-disable-line no-unused-vars
    const method = req.method;
    if (!FILE_METHODS.has(method)) throw new HttpError(405, 'Not found.');
    purgeDeleted();
    const { x, f } = folderFor(String(orgId ?? ''), String(folderId ?? ''), me, method === 'GET' ? 'view' : 'edit');
    const oid = f.org_id;
    const path = checkFolderPath(rawPath, bad);
    const hook = (phase, size) => check?.({ me, orgId: oid, folderId: f.id, method, size, phase });
    const row = h.get('SELECT * FROM org_folder_files WHERE folder_id = ? AND path = ?', f.id, path);
    if (method === 'GET') {
      if (!row) notFound('No such file.');
      if (etagVersion(req.headers['if-none-match']) === row.version) { res.writeHead(304, { etag: `"${row.version}"` }); res.end(); return 304; }
      hook('start', row.size);
      res.writeHead(200, {
        'content-type': 'application/octet-stream', 'content-length': row.size, etag: `"${row.version}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'x-kea-sha256': row.sha256, 'x-kea-claude': (row.claude == null ? f.claude : row.claude) ? '1' : '0',
      });
      await pipeline(createReadStream(blobPath(oid, row.blob)), res);
      return 200;
    }
    const conflict = () => { throw new HttpError(412, 'This file was changed on another device. Get the newest copy first.', { version: row?.version ?? null }); };
    const ifMatch = req.headers['if-match'];
    if (ifMatch != null && (ifMatch === '*' ? !row : etagVersion(ifMatch) !== row?.version)) conflict();
    if (req.headers['if-none-match'] === '*' && row) conflict();
    if (method === 'DELETE') {
      if (!row) notFound('No such file.');
      hook('start', 0);
      tx(() => { h.run('DELETE FROM org_folder_files WHERE folder_id = ? AND path = ?', f.id, path); bump(f.id); });
      await rm(blobPath(oid, row.blob), { force: true });
      audit(x.who.id, 'folder.file_delete', f.id, { orgId: oid, path }, null);
      return answer(res, 200, { ok: true });
    }
    // PUT
    const tooBig = `Files can be at most ${Math.round(maxFileBytes / 1024 ** 2)} MB.`;
    const declared = Number(req.headers['content-length']);
    const known = Number.isFinite(declared) && declared >= 0;
    if (known && declared > maxFileBytes) throw new HttpError(413, tooBig);
    if (!row && h.get('SELECT COUNT(*) AS n FROM org_folder_files WHERE folder_id = ?', f.id).n >= maxFilesPerFolder) throw new HttpError(507, `This shared folder holds the most files it can (${maxFilesPerFolder.toLocaleString('en-US')}). Delete some to add more.`, { storageFull: true, tooManyFiles: true });
    const mine = known ? declared : 0;
    // Full (or over): nothing is deleted, and a file can still be replaced by one no bigger. Uploads to the same
    // organization still arriving count too, so parallel uploads can't all fit.
    const checkRoom = (size, before) => {
      const q = quotaNow(oid);
      const used = q.used - before + ((reserved.get(oid) || 0) - mine);
      if (used + size > q.limit && size > before) {
        throw new HttpError(507, q.limit
          ? `${x.o.name}’s shared folders are full (${fmtSize(q.limit)}). Delete some shared files, or ask the organization’s owner for more room.`
          : `${x.o.name} has no room for shared files on this server. Ask the organization’s owner.`, { storageFull: true, used: q.used, quota: q.limit });
      }
    };
    checkRoom(mine, row?.size ?? 0);
    hook('start', mine);
    reserved.set(oid, (reserved.get(oid) || 0) + mine);
    const dir = orgDir(oid);
    const blob = randomUUID();
    const tmp = join(dir, `${blob}.tmp`);
    try {
      await mkdir(dir, { recursive: true });
      const hasher = createHash('sha256');
      let size = 0;
      const meter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; if (size > maxFileBytes) return cb(new HttpError(413, tooBig)); hasher.update(chunk); cb(null, chunk); } });
      await pipeline(req, meter, createWriteStream(tmp));
      checkRoom(size, row?.size ?? 0);
      hook('arrived', size);
      await rename(tmp, join(dir, blob));
      const version = (row?.version ?? 0) + 1;
      const hash = hasher.digest('hex');
      let latest;
      try {
        tx(() => {
          const live = h.get('SELECT 1 FROM org_folders WHERE id = ? AND deleted_at IS NULL', f.id);
          if (!live) notFound('No such shared folder.');
          const cur = h.get('SELECT version, size FROM org_folder_files WHERE folder_id = ? AND path = ?', f.id, path);
          if ((cur?.version ?? 0) !== (row?.version ?? 0)) conflict();
          checkRoom(size, cur?.size ?? 0);
          h.run(`INSERT INTO org_folder_files (folder_id,path,blob,size,version,sha256,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(folder_id,path) DO UPDATE SET blob=excluded.blob, size=excluded.size, version=excluded.version, sha256=excluded.sha256, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
          f.id, path, blob, size, version, hash, now(), x.who.id);
          bump(f.id);
          latest = h.get('SELECT * FROM org_folder_files WHERE folder_id = ? AND path = ?', f.id, path);
        });
      } catch (e) { await rm(join(dir, blob), { force: true }); throw e; }
      if (row) await rm(blobPath(oid, row.blob), { force: true });
      try { hook('saved', size); } catch {}
      if (!row) { try { tellAboutNewFile(x, folderRow(oid, f.id) ?? f, path); } catch (e) { console.error(e); } }
      return answer(res, row ? 200 : 201, { path, version, size, sha256: hash, claude: latest.claude == null ? !!f.claude : !!latest.claude }, { etag: `"${version}"` });
    } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
    finally {
      const left = (reserved.get(oid) || 0) - mine;
      if (left > 0) reserved.set(oid, left); else reserved.delete(oid);
    }
  }

  // ---------- accounts and organizations going away ----------
  // (Forgetting an account: mountOrg's forgetAccount clears its grants and its name on files and folders.)
  /** Rows of an organization that is being deleted (inside the host's transaction); then removeOrgFiles. */
  function forgetOrg(oid) {
    h.run('DELETE FROM org_folder_files WHERE folder_id IN (SELECT id FROM org_folders WHERE org_id = ?)', oid);
    h.run('DELETE FROM org_folder_access WHERE folder_id IN (SELECT id FROM org_folders WHERE org_id = ?)', oid);
    h.run('DELETE FROM org_folders WHERE org_id = ?', oid);
  }
  /** The organization's blobs on disk (after forgetOrg's transaction committed). */
  const removeOrgFiles = (oid) => rm(orgDir(oid), { recursive: true, force: true });

  return {
    handle, match: matchFolderFile, url: FOLDER_FILE_URL, purgeDeleted: () => purgeDeleted({ force: true }), forgetOrg, removeOrgFiles,
    /** Bytes one organization's shared folders hold (the bin included). */
    bytesOf: orgBytes,
    quotaOf: quotaNow,
  };
}
