const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('yw', {
  onEngineStatus: (cb) => ipcRenderer.on('engine-status', (_e, p) => cb(p)),
  onEngineFailed: (cb) => ipcRenderer.on('engine-failed', (_e, p) => cb(p)),
  status: () => ipcRenderer.invoke('engine:status'),
  getCookie: () => ipcRenderer.invoke('api:cookie'),
  saveCookie: (cookie) => ipcRenderer.invoke('login:save-cookie', cookie),
  winControl: (action) => ipcRenderer.send('win:' + action),
  onWinMaxed: (cb) => ipcRenderer.on('win:maxed', (_e, v) => cb(v)),
  scanLocal: (opts) => ipcRenderer.invoke('local:scan', opts || {}),
  libraryGet: () => ipcRenderer.invoke('library:get'),
  libraryAdd: () => ipcRenderer.invoke('library:add'),
  libraryAddPath: (paths) => ipcRenderer.invoke('library:add-path', paths),
  libraryRemove: (dir) => ipcRenderer.invoke('library:remove', dir),
  /** 拖拽的 File 对象 → 磁盘路径（必须在渲染进程侧解析） */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  onTrayCmd: (cb) => ipcRenderer.on('tray-cmd', (_e, cmd) => cb(cmd)),
  enginePort: 47800
});
