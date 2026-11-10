'use strict';
// Bridge for the T计划 main window. The page cannot touch Node or Electron;
// it can only send the commands and questions listed here. API keys go in
// through saveProfile and never come back out.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('tplan', {
  get: () => ipcRenderer.invoke('app:get'),
  dispatch: (type, payload) => ipcRenderer.invoke('core:dispatch', { type, payload: { ...payload, src: 'main' } }),
  query: (name, args) => ipcRenderer.invoke('app:query', name, args),
  action: (name, arg) => ipcRenderer.send('app:action', name, arg),
  importData: () => ipcRenderer.invoke('console:import'),
  exportData: () => ipcRenderer.invoke('console:export-data'),
  onUpdate: on('app:update'),
  onGoto: on('app:goto'),

  ai: {
    profiles: () => ipcRenderer.invoke('ai:profiles'),
    saveProfile: (input) => ipcRenderer.invoke('ai:save-profile', input),
    removeProfile: (id) => ipcRenderer.invoke('ai:remove-profile', id),
    setActive: (id) => ipcRenderer.invoke('ai:set-active', id),
    testProfile: (id) => ipcRenderer.invoke('ai:test-profile', id),
  },
  chat: {
    list: () => ipcRenderer.invoke('chat:list'),
    create: () => ipcRenderer.invoke('chat:create'),
    load: (id) => ipcRenderer.invoke('chat:load', id),
    remove: (id) => ipcRenderer.invoke('chat:remove', id),
    send: (p) => ipcRenderer.invoke('chat:send', p),
    stop: (id) => ipcRenderer.invoke('chat:stop', id),
    decide: (p) => ipcRenderer.invoke('chat:decide', p),
    onEvent: on('chat:event'),
  },
  review: {
    draft: (p) => ipcRenderer.invoke('review:draft', p),
  },
});
