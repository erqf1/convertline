'use strict';

// Schmale Brücke zwischen Oberfläche und Hauptprozess (keine Node-APIs im Renderer).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, cb) => {
  const f = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, f);
  return () => ipcRenderer.removeListener(channel, f);
};

contextBridge.exposeInMainWorld('api', {
  info: () => invoke('app:info'),
  hardware: () => invoke('app:hardware'),
  getSettings: () => invoke('settings:get'),
  setSettings: (s) => invoke('settings:set', s),
  initialFiles: () => invoke('app:initial-files'),
  onOpenFiles: (cb) => on('app:open-files', cb),
  onClosing: (cb) => on('app:closing', cb),
  onSystemTheme: (cb) => on('app:system-theme', cb),
  closeNow: () => invoke('app:close-now'),
  updateReady: () => ipcRenderer.send('app:update-ready'),
  setProgress: (ratio, title) => invoke('app:progress', ratio, title),

  openDialog: (opts) => invoke('file:open-dialog', opts),
  pickFolder: (opts) => invoke('file:pick-folder', opts),
  expand: (paths) => invoke('file:expand', paths),
  probe: (file, kind) => invoke('file:probe', file, kind),
  pathForFile: (file) => webUtils.getPathForFile(file),
  startDrag: (file) => ipcRenderer.send('file:drag', file),

  runJob: (job) => invoke('job:run', job),
  cancelJob: (id) => invoke('job:cancel', id),
  cancelAll: () => invoke('job:cancel-all'),
  onProgress: (cb) => on('job:progress', cb),

  openExternal: (url) => invoke('shell:open-external', url),
  reveal: (p) => invoke('shell:reveal', p),
  openPath: (p) => invoke('shell:open', p),
});
