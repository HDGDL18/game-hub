const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  info: () => ipcRenderer.invoke('hub:info'),
  list: () => ipcRenderer.invoke('hub:list'),
  sync: () => ipcRenderer.invoke('hub:sync'),
  launch: (id) => ipcRenderer.invoke('hub:launch', id),
  openFolder: (id) => ipcRenderer.invoke('hub:openFolder', id),
  onProgress: (cb) => ipcRenderer.on('hub:progress', (_e, text) => cb(text)),
  onSynced: (cb) => ipcRenderer.on('hub:synced', (_e, result) => cb(result)),
});
