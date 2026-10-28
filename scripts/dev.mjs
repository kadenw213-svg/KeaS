// `npm run dev`: the org server (127.0.0.1:4850) and the Vite dev server (proxying /v1 to it) together.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const procs = [
  ['server', [process.execPath, 'server/index.mjs']],
  ['web', [process.execPath, vite, 'web']],
].map(([name, [cmd, ...args]]) => {
  const p = spawn(cmd, args, { stdio: 'inherit', env: process.env });
  p.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code ?? 'signal'}); stopping the rest.`);
    stop(code ?? 1);
  });
  return p;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode == null) p.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
console.log('[dev] Open the web app at the Vite URL below (API is proxied to http://127.0.0.1:4850).');
