// Minimal, whitelisted bridge between the sandboxed UI and the game service.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saturn', {
  call: async (method, ...args) => {
    const r = await ipcRenderer.invoke('saturn:call', method, args);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  },
  exportSave: () => ipcRenderer.invoke('saturn:export'),
  importSave: () => ipcRenderer.invoke('saturn:import'),
});
