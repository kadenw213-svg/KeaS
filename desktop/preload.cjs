// The setup screens' only way to reach the app: a fixed list of calls, each returning { ok, value } or { ok, error }.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (arg) => ipcRenderer.invoke(name, arg);
contextBridge.exposeInMainWorld('keas', {
  openPayroll: call('payroll:open'),
  payrollSettings: call('payroll:settings'),
  payrollLocalSignIn: call('payroll:localSignIn'),
  payrollHubKey: call('payroll:hubKey'),
  payrollRepinHub: call('payroll:repinHub'),
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
  tsFunnelOff: call('ts:funnelOff'),
  terms: call('terms'),
  ownerCreate: call('owner:create'),
  ownerTotp: call('owner:totp'),
  finish: call('finish'),
  updateState: call('update:state'),
  checkUpdates: call('update:check'),
  installUpdate: call('update:install'),
  onUpdate: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('update', fn);
    return () => ipcRenderer.removeListener('update', fn);
  },
  setTheme: call('setTheme'),
  openExternal: call('openExternal'),
  openFolder: call('openFolder'),
  bootStatus: call('boot:status'),
  bootApply: call('boot:apply'),
  bootRemove: call('boot:remove'),
  onNavigate: (cb) => {
    const fn = (_e, view) => cb(view);
    ipcRenderer.on('navigate', fn);
    return () => ipcRenderer.removeListener('navigate', fn);
  },
  onProgress: (cb) => {
    const fn = (_e, line) => cb(line);
    ipcRenderer.on('progress', fn);
    return () => ipcRenderer.removeListener('progress', fn);
  },
});
