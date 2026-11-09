// The bridge between the pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionShare', {
  selectionDone: (sel) => ipcRenderer.send('selection:done', sel),
  selectionCancel: () => ipcRenderer.send('selection:cancel'),
  onRegion: (cb) => ipcRenderer.on('region:update', (_e, r) => cb(r)),
});
