// Is the server answering on this PC really ours? Another Windows account can start a program on 127.0.0.1:4860
// while ours is down. Before KeaS uses that server or sends it anything, the server signs a random nonce with its key
// (GET /v1/identity), and KeaS checks the signature against the key in the data folder, which only this Windows account
// (and SYSTEM and Administrators) can read.
//   - A KeaS server: server-identity.pem, signing `kea-server-identity:<serverId>:<nonce>` (docs/protocol.md 2.1).
//   - A Kea Hub (KeaS 0.5, accounts not moved yet): hub-signing-key.pem, signing `kea-hub-identity:v1:<nonce>`.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const keyIn = (dataDir, file) => { try { return crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(path.join(dataDir, file)))); } catch { return null; } };
/** The Hub's public key, from the signing key file in its data folder (null if it isn't there or can't be read). */
const hubPublicKey = (dataDir) => keyIn(dataDir, 'hub-signing-key.pem');
/** The KeaS server's public key and id, from its identity key file (null when there's none yet). */
function serverIdentity(dataDir) {
  const pub = keyIn(dataDir, 'server-identity.pem');
  if (!pub) return null;
  const x = pub.export({ format: 'jwk' }).x;
  return { publicKey: pub, x, serverId: crypto.createHash('sha256').update(Buffer.from(x, 'base64url')).digest('base64url').slice(0, 22) };
}

/** True only when the server on `port` proves it holds the key in `dataDir`. */
async function verifyHubIdentity(port, dataDir, { timeoutMs = 3000, fetchFn = fetch } = {}) {
  if (!dataDir) return false;
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/v1/identity?nonce=${nonce}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = await r.json();
    if (typeof j?.sig !== 'string' || j.sig.length > 200) return false;
    const sig = Buffer.from(j.sig, 'base64url');
    if (j.serverId) {
      const me = serverIdentity(dataDir);
      return !!me && j.serverId === me.serverId && crypto.verify(null, Buffer.from(`kea-server-identity:${me.serverId}:${nonce}`), me.publicKey, sig);
    }
    const pub = hubPublicKey(dataDir);
    return !!pub && crypto.verify(null, Buffer.from(`kea-hub-identity:v1:${nonce}`), pub, sig);
  } catch {
    return false;
  }
}

module.exports = { hubPublicKey, serverIdentity, verifyHubIdentity };
