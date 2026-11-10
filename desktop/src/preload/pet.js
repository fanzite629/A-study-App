'use strict';
// Narrow bridge for the pet window. The page cannot touch Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('petApi', {
  setHit: (v) => ipcRenderer.send('pet:hit', !!v),
  dragStart: () => ipcRenderer.send('pet:drag', 'start'),
  dragEnd: () => ipcRenderer.send('pet:drag', 'end'),
  contextMenu: () => ipcRenderer.send('pet:menu'),
  wantFocus: () => ipcRenderer.send('pet:focus', 'want'),
  releaseFocus: () => ipcRenderer.send('pet:focus', 'release'),
  rendered: (info) => ipcRenderer.send('pet:rendered', info),
  dispatch: (type, payload) => ipcRenderer.invoke('core:dispatch', { type, payload }),
  action: (name, arg) => ipcRenderer.send('app:action', name, arg),
  onLayout: on('pet:layout'),
  onPack: on('pet:pack'),
  onMode: on('pet:mode'),
  onView: on('pet:view'),
  onEvent: on('pet:event'),
  onAppear: on('pet:appear'),
  onFocusGranted: on('pet:focus-granted'),
});
