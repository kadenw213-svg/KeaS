// A new Ed25519 private key as PKCS#8 PEM (what a Kea Hub keeps in hub-signing-key.pem).
import { generateKeyPairSync } from 'node:crypto';
export const newKeyPem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
