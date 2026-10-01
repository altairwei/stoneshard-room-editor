// Renderer bridge: the native menu in, menu checkmark state out. contextIsolation
// stays on -- the page only ever sees this one object.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("svreHost", {
  isElectron: true,
  onMenu: (cb) => ipcRenderer.on("svre:menu", (_e, id) => cb(id)),
  pushState: (s) => ipcRenderer.send("svre:state", s),
  // custom titlebar: pop the application menu at the ☰ button's position
  popupMenu: (x, y) => ipcRenderer.send("svre:menu-popup", { x, y }),
  // ...and run the window controls (max state comes back over svre:win-state)
  winControl: (action) => ipcRenderer.send("svre:win-control", action),
  onWinState: (cb) => ipcRenderer.on("svre:win-state", (_e, s) => cb(s)),
  // first-run wizard pickers (native open dialogs answered by the main process)
  pickDir: () => ipcRenderer.invoke("svre:pick-dir"),
  pickFile: () => ipcRenderer.invoke("svre:pick-file"),
});
