'use strict';
// Bridge for the T计划 main window (currently the desktop dev console).
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('tplan', {
  get: () => ipcRenderer.invoke('console:get'),
  dispatch: (type, payload) => ipcRenderer.invoke('core:dispatch', { type, payload: { ...payload, src: 'main' } }),
  importData: () => ipcRenderer.invoke('console:import'),
  exportData: () => ipcRenderer.invoke('console:export-data'),
  exportDiagnostics: () => ipcRenderer.invoke('console:export-diagnostics'),
  action: (name, arg) => ipcRenderer.send('app:action', name, arg),
  onUpdate: on('console:update'),
  onLog: on('console:log'),
  onGoto: on('console:goto'),
});
