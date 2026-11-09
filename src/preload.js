// The bridge between the pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionShare', {
  selectionDone: (sel) => ipcRenderer.send('selection:done', sel),
  selectionCancel: () => ipcRenderer.send('selection:cancel'),
  onRegion: (cb) => ipcRenderer.on('region:update', (_e, r) => cb(r)),
  onZoomCommand: (cb) => ipcRenderer.on('zoom:command', (_e, cmd) => cb(cmd)),
  zoomChanged: (level) => ipcRenderer.send('zoom:changed', level),
  onZoomLevel: (cb) => ipcRenderer.on('zoom:level', (_e, level) => cb(level)),
  onQuality: (cb) => ipcRenderer.on('quality', (_e, q) => cb(q)),
  captureInfo: (info) => ipcRenderer.send('capture:info', info),
  hideMirror: () => ipcRenderer.send('mirror:hide'),
  selfTestFrames: (n, bright, cyan) => ipcRenderer.send('selftest:frames', n, bright, cyan),
});
