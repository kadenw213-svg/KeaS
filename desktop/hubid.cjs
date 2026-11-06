// Is the Kea Hub answering on this PC really ours? Another Windows account can start a program on 127.0.0.1:4860
// while the Hub is down. Before KeaS uses that Hub or sends it a password, the Hub signs a random nonce with its
// signing key (GET /v1/identity), and KeaS checks the signature against the key in the Hub's data folder, which only
// this Windows account (and SYSTEM and Administrators) can read.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** The Hub's public key, from the signing key file in its data folder (null if it isn't there or can't be read). */
function hubPublicKey(dataDir) {
  try { return crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(path.join(dataDir, 'hub-signing-key.pem')))); } catch { return null; }
}

/** True only when the Hub on `port` proves it holds the signing key in `dataDir`. */
async function verifyHubIdentity(port, dataDir, { timeoutMs = 3000, fetchFn = fetch } = {}) {
  if (!dataDir) return false;
  const pub = hubPublicKey(dataDir);
  if (!pub) return false;
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/v1/identity?nonce=${nonce}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = await r.json();
    if (typeof j?.sig !== 'string' || j.sig.length > 200) return false;
    return crypto.verify(null, Buffer.from(`kea-hub-identity:v1:${nonce}`), pub, Buffer.from(j.sig, 'base64url'));
  } catch {
    return false;
  }
}

module.exports = { hubPublicKey, verifyHubIdentity };
