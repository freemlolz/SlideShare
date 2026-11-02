const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slideSyncDesktop', {
  readPolls() {
    const result = ipcRenderer.sendSync('slidesync:read-polls');
    if (result.error) throw new Error(result.error);
    return result.value;
  },
  writePolls(serialized) { return ipcRenderer.invoke('slidesync:write-polls', serialized); },
});
