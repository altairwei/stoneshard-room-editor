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
  // native folder/file pickers. The titles are the caller's: the same folder dialog serves
  // both project pickers (createDirectory is what makes it a new-folder dialog), and the
  // file picker gets its title + filter name from the wizard.
  pickDir: (title) => ipcRenderer.invoke("svre:pick-dir", title),
  pickFile: (title, filterName) => ipcRenderer.invoke("svre:pick-file", title, filterName),
  // reveal a project folder in Explorer/Finder (the welcome page's recent rows)
  revealPath: (p) => ipcRenderer.invoke("svre:reveal-path", p),
});
