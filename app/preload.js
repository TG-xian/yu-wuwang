const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('yw', {
  /** 只读平台标识（渲染层据此决定输出菜单形态；Windows 走原静态清单） */
  platform: process.platform,
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
  /** B 站音源：统一返回 { ok, data } / { ok:false, error } */
  bili: {
    userVideos: (q) => ipcRenderer.invoke('bili:user-videos', q),
    userProfile: (q) => ipcRenderer.invoke('bili:user-profile', q),
    season: (q) => ipcRenderer.invoke('bili:season', q),
    ranking: () => ipcRenderer.invoke('bili:ranking'),
    recommend: (q) => ipcRenderer.invoke('bili:recommend', q),
    searchVideo: (q) => ipcRenderer.invoke('bili:search-video', q),
    searchUser: (q) => ipcRenderer.invoke('bili:search-user', q),
    info: (input) => ipcRenderer.invoke('bili:info', input),
    playurl: (q) => ipcRenderer.invoke('bili:playurl', q),
    lyrics: (q) => ipcRenderer.invoke('bili:lyrics', q),
    qrGenerate: () => ipcRenderer.invoke('bili:qr-generate'),
    qrPoll: (key) => ipcRenderer.invoke('bili:qr-poll', key),
    sessionGet: () => ipcRenderer.invoke('bili:session-get'),
    sessionSave: (text) => ipcRenderer.invoke('bili:session-save', text),
    sessionClear: () => ipcRenderer.invoke('bili:session-clear'),
  },
  enginePort: 47800
});
