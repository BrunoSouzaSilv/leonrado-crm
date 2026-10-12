const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aviaSetup", {
  salvar: (cfg) => ipcRenderer.invoke("avia:save-config", cfg),
});
