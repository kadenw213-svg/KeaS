// The setup screens' only way to reach the app: a fixed list of calls, each returning { ok, value } or { ok, error }.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (arg) => ipcRenderer.invoke(name, arg);
contextBridge.exposeInMainWorld('keas', {
  state: call('state'),
  drives: call('drives'),
  pickFolder: call('pickFolder'),
  checkFolder: call('checkFolder'),
  saveSetup: call('saveSetup'),
  start: call('start'),
  tsStatus: call('ts:status'),
  tsInstall: call('ts:install'),
  tsLogin: call('ts:login'),
  tsFunnel: call('ts:funnel'),
  terms: call('terms'),
  ownerCreate: call('owner:create'),
  ownerTotp: call('owner:totp'),
  finish: call('finish'),
  setTheme: call('setTheme'),
  openExternal: call('openExternal'),
  openFolder: call('openFolder'),
  onProgress: (cb) => {
    const fn = (_e, line) => cb(line);
    ipcRenderer.on('progress', fn);
    return () => ipcRenderer.removeListener('progress', fn);
  },
});
