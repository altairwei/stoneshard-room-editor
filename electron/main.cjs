// Stoneshard Room Editor -- Electron main process.
//
// The app is the same web bundle the browser uses; this shell provides the native
// menu and owns the backend lifecycle:
//   dev   (SVRE_APP_DEV=1)  spawn `npx vite --port 5186` and load it (HMR for working
//                           on the client; 5186 so the user's own dev server on 5178
//                           is never touched)
//   prod  (default)         serve dist/ from the standalone backend
//                           (dist-server/standalone.cjs, built by `npm run build:app`)
//
// Menus are native; every menu click is just an action id sent to the renderer
// ("svre:menu"), where the same functions the buttons/keys use live. The renderer
// pushes a compact state snapshot back ("svre:state") so checkmarks/radios stay
// honest. Buttons that moved into menus keep their place in plain browsers -- the
// body.electron class hides them only here.
//
// Smoke test: SVRE_APP_SMOKE=1 loads the app hidden, captures the page to
// SVRE_APP_SMOKE_SHOT (default D:/tmp/svre_electron_smoke.png) and quits.
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEV = !!process.env.SVRE_APP_DEV;
const SMOKE = !!process.env.SVRE_APP_SMOKE;
const SMOKE_SHOT = process.env.SVRE_APP_SMOKE_SHOT || "D:/tmp/svre_electron_smoke.png";
const DEV_PORT = 5186;

let win = null;
let baseUrl = "";
// The renderer's snapshot of everything the native menu reflects. The shell NEVER fetches
// its own copy of anything (the old modDirCache did, and went stale on every project
// switch): whatever the page pushed last is the truth.
let menuState = { theme: "dark", zmode: "game", tool: "select", toggles: {}, mode: "welcome", project: null, recent: [], lang: "en" };
let menuKey = ""; // JSON of the last template built, so identical pushes are a no-op

// frameless chrome: the OS title bar is hidden (titleBarStyle:"hidden" keeps the native
// frame -- resize borders/snap/shadow all keep working) and the page draws its own
// #titlebar: drag region, ☰ menu popup, and the min/max/close buttons (titleBarOverlay
// was tried first but paints NOTHING on win10 19045 + electron 44 -- custom buttons it
// is, which is what VS Code does anyway).

function waitForHttp(url, tries = 120) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      fetch(url)
        .then((r) => (r.ok ? resolve() : attempt(left - 1)))
        .catch(() => {
          if (left <= 0) reject(new Error(`backend never came up at ${url}`));
          else setTimeout(() => attempt(left - 1), 500);
        });
    };
    attempt(tries);
  });
}

async function startBackend() {
  if (DEV) {
    // shell: windows can't exec the npx.cmd shim directly
    // --host 127.0.0.1: vite otherwise binds ::1 alone on windows, and both the
    // readiness probe below and the window's loadURL dial IPv4
    const child = spawn("npx vite --port 5186 --strictPort --host 127.0.0.1", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: true,
    });
    child.on("error", (e) => console.error(`vite spawn failed: ${e.message}`));
    child.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
    app.on("will-quit", () => {
      // shell:true means child is the cmd wrapper; kill the whole tree or vite leaks
      try { spawn(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: "ignore" }); } catch { /* already gone */ }
    });
    const url = `http://127.0.0.1:${DEV_PORT}`;
    // probe the setup route, not /api/rooms: a degraded backend (first run, no cache
    // yet) 503s everything else, and the window must still load so the wizard shows
    await waitForHttp(`${url}/api/setup`);
    return url;
  }
  const { startSvreServer } = require("../dist-server/standalone.cjs");
  // home = the writable profile dir: a packaged install has no repo config, so its
  // config, workdir default and asset cache all live under userData
  const { port } = await startSvreServer({ root: ROOT, staticDir: path.join(ROOT, "dist"), home: app.getPath("userData") });
  return `http://127.0.0.1:${port}`;
}

const send = (id) => win?.webContents.send("svre:menu", id);
// recent entries ride one string (a menu item carries a single channel) -- see
// RECENT_MENU_PREFIX in src/main.ts, which splits them back apart
const RECENT_MENU_PREFIX = "project.openRecent\u0000";
// Anything that needs an open document (and a healthy machine behind it) is disabled
// until the page says so. The project items stay live: the welcome page is exactly where
// they are needed.
const ready = (s) => s.mode === "ready";
// Menu labels are NOT kept here: the page pushes them (s.labels, already translated)
// along with the rest of the state, so the native menu speaks the page's language.
// This English copy is only the fallback for the very first buildMenu, before any
// page has pushed -- the ☰ cannot be clicked before then.
const DEFAULT_LABELS = {
  file: "File", edit: "Edit", view: "View", tools: "Tools", help: "Help",
  newProject: "New project…", openProject: "Open project…", recent: "Recent projects",
  closeProject: "Close project", missingFolder: "Folder no longer exists",
  newRoom: "New room…", vanillaRoom: "Open vanilla room (read-only)…",
  importSprite: "Import sprite…", compile: "Compile", openModDir: "Open mod folder",
  quit: "Quit",
  undo: "Undo", redo: "Redo", find: "Find instance",
  themeLight: "Theme: day", themeDark: "Theme: night", lang: "Interface language",
  orderGame: "Order: game (real in-game occlusion)",
  orderStatic: "Order: static (UTMT reconciliation view)",
  "toggle.snap": "Snap (S)", "toggle.hidden": "Invisible objects (Shift+H)",
  "toggle.collision": "Collision", "toggle.markers": "Marker", "toggle.grid": "Grid (G)",
  "toggle.notes": "Note",
  panelToggle: "Problems / log", panelProblems: "Problems only", panelLog: "Log only",
  zoomIn: "Zoom in", zoomOut: "Zoom out", fit: "Fit window", oneToOne: "Actual pixels",
  fullscreen: "Fullscreen",
  "tool.select": "Select (V)", "tool.hand": "Hand (H)", "tool.place": "Place (P)",
  "tool.collision": "Collision rectangle (C)", "tool.barrier": "Barrier brush (B)",
  "tool.zone": "Zone (T)", "tool.marker": "Marker (M)", "tool.note": "Note (N)",
  setup: "Local setup…", about: "About Stoneshard Room Editor", aboutTitle: "About",
  aboutBackend: "Backend: ", aboutProject: "Project: ", aboutMode: "Mode: ",
  aboutNoProject: "(no project open)",
  aboutModeDev: "dev (vite HMR)", aboutModePack: "packaged (bundled backend + dist)",
  dev: "Development", reload: "Reload", devtools: "Developer tools",
};
const VIEW_TOGGLES = ["snap", "hidden", "collision", "markers", "grid", "notes"];
const TOOLS = ["select", "hand", "place", "collision", "barrier", "zone", "marker", "note"];

function buildMenu(s) {
  // applyVisibility() pushes on every scene refresh, so this is called constantly with
  // the same content: rebuilding the whole menu each time is pure churn (and re-creating
  // accelerators). One stringify is far cheaper than the rebuild it skips.
  const key = JSON.stringify(s);
  if (key === menuKey) return;
  menuKey = key;
  menuState = s;
  const proj = s.project;
  const recent = s.recent ?? [];
  const L = { ...DEFAULT_LABELS, ...(s.labels ?? {}) };
  const devItems = DEV
    ? [
        { label: L.dev, submenu: [{ role: "reload", label: L.reload }, { role: "toggleDevTools", label: L.devtools }] },
      ]
    : [];
  const template = [
    {
      label: L.file,
      submenu: [
        // A project IS the working directory, so these are the first thing in the menu --
        // and they stay enabled with nothing open, because that is the welcome page.
        { label: L.newProject, click: () => send("project.new") },
        { label: L.openProject, accelerator: "CmdOrCtrl+K CmdOrCtrl+O", click: () => send("project.open") },
        {
          label: L.recent,
          enabled: recent.length > 0,
          submenu: recent.map((r) => ({
            // no digit accelerators: CmdOrCtrl+1 is the actual-pixel zoom, and a path is
            // not a keyboard target anyway
            label: r.exists ? `${r.name}  (${r.path})` : `${r.name}  (${r.path}) — ${L.missingFolder}`,
            click: () => send(RECENT_MENU_PREFIX + r.path),
          })),
        },
        { label: L.closeProject, enabled: !!proj, click: () => send("project.close") },
        { type: "separator" },
        { label: L.newRoom, accelerator: "CmdOrCtrl+N", enabled: ready(s), click: () => send("file.new") },
        { label: L.vanillaRoom, accelerator: "CmdOrCtrl+O", enabled: ready(s), click: () => send("file.vanilla") },
        { type: "separator" },
        { label: L.importSprite, enabled: ready(s), click: () => send("file.importSprite") },
        { type: "separator" },
        { label: L.compile, accelerator: "CmdOrCtrl+S", enabled: ready(s), click: () => send("file.compile") },
        { type: "separator" },
        {
          label: L.openModDir,
          // the path comes from the pushed state, not from a cached fetch of our own
          enabled: !!proj?.exists,
          click: () => shell.openPath(proj?.path ?? ""),
        },
        { type: "separator" },
        { role: "quit", label: L.quit },
      ],
    },
    {
      label: L.edit,
      submenu: [
        { label: L.undo, accelerator: "CmdOrCtrl+Z", click: () => send("edit.undo") },
        { label: L.redo, accelerator: "CmdOrCtrl+Y", click: () => send("edit.redo") },
        { type: "separator" },
        { label: L.find, accelerator: "CmdOrCtrl+F", click: () => send("edit.find") },
      ],
    },
    {
      label: L.view,
      submenu: [
        { label: L.themeLight, type: "radio", checked: s.theme === "light", click: () => send("view.theme.light") },
        { label: L.themeDark, type: "radio", checked: s.theme !== "light", click: () => send("view.theme.dark") },
        { type: "separator" },
        // each language names itself, so these need no translation of their own; the shell
        // reloads the page on pick, which re-localizes everything (?lang= is read by api()
        // at call time -- the same reason the browser dropdown re-paints in place)
        {
          label: L.lang,
          submenu: [
            { label: "中文", type: "radio", checked: s.lang === "zh", click: () => send("lang.set.zh") },
            { label: "English", type: "radio", checked: s.lang === "en", click: () => send("lang.set.en") },
            { label: "Русский", type: "radio", checked: s.lang === "ru", click: () => send("lang.set.ru") },
          ],
        },
        { type: "separator" },
        { label: L.orderGame, type: "radio", checked: s.zmode !== "static", click: () => send("view.zmode.game") },
        { label: L.orderStatic, type: "radio", checked: s.zmode === "static", click: () => send("view.zmode.static") },
        { type: "separator" },
        ...VIEW_TOGGLES.map((k) => ({
          label: L[`toggle.${k}`],
          type: "checkbox",
          checked: !!s.toggles?.[k],
          click: () => send(`view.toggle.${k}`),
        })),
        { type: "separator" },
        // the project's diagnostics; the same two panes the status bar's count opens
        // the accelerator toggles (matching the renderer's own binding); the two entries
        // below it land on a specific pane instead
        { label: L.panelToggle, accelerator: "CmdOrCtrl+Shift+M", click: () => send("view.panel.toggle") },
        { label: L.panelProblems, click: () => send("view.panel.problems") },
        { label: L.panelLog, click: () => send("view.panel.log") },
        { type: "separator" },
        { label: L.zoomIn, accelerator: "CmdOrCtrl+=", click: () => send("view.zoomIn") },
        { label: L.zoomOut, accelerator: "CmdOrCtrl+-", click: () => send("view.zoomOut") },
        { label: L.fit, accelerator: "CmdOrCtrl+0", click: () => send("view.fit") },
        { label: L.oneToOne, accelerator: "CmdOrCtrl+1", click: () => send("view.one") },
        { type: "separator" },
        { role: "togglefullscreen", label: L.fullscreen },
      ],
    },
    {
      label: L.tools,
      submenu: TOOLS.map((kind) => ({
        label: L[`tool.${kind}`],
        type: "radio",
        checked: s.tool === kind,
        click: () => send(`tool.${kind}`),
      })),
    },
    ...devItems,
    {
      id: "help",
      label: L.help,
      submenu: [
        // machine-level only (game data / UTMT / cache / decompiled source): this is not
        // project setup, and the game gets updated while the app does not
        { label: L.setup, click: () => send("help.setup") },
        { type: "separator" },
        {
          label: L.about,
          click: () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: L.aboutTitle,
              message: `Stoneshard Room Editor v${app.getVersion()}`,
              // from the pushed snapshot: the shell holds no path of its own to go stale
              detail: `${L.aboutBackend}${baseUrl}\n${L.aboutProject}${menuState.project?.path ?? L.aboutNoProject}\n${L.aboutMode}${DEV ? L.aboutModeDev : L.aboutModePack}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1152,
    minHeight: 720,
    show: !SMOKE,
    backgroundColor: "#1b1b1d",
    title: "Stoneshard Room Editor",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    // custom title bar: hide the OS caption, keep the native frame (resize/snap/shadow);
    // the page's #titlebar supplies drag area, ☰ menu and min/max/close
    titleBarStyle: "hidden",
    webPreferences: {
      preload: process.env.SVRE_APP_NO_PRELOAD ? undefined : path.join(__dirname, "preload.cjs"), // escape hatch for bisecting
      contextIsolation: true,
      spellcheck: false,
      // an editor must keep painting while the user is in UTMT/the game; also, hidden
      // windows otherwise throttle rAF+timers and this app's render heartbeat misbehaves
      backgroundThrottling: false,
    },
  });
  // the custom max/restore button icon follows the real window state
  win.on("maximize", () => win.webContents.send("svre:win-state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("svre:win-state", { maximized: false }));
  win.loadURL(process.env.SVRE_APP_URL || baseUrl + (process.env.SVRE_APP_QUERY ?? ""));
  if (SMOKE) {
    win.webContents.on("render-process-gone", (_e, d) => console.log(`SMOKE renderer gone: ${JSON.stringify(d)}`));
    win.webContents.on("unresponsive", () => console.log("SMOKE renderer unresponsive"));
    win.webContents.on("preload-error", (_e, p, e) => console.log(`SMOKE preload error at ${p}: ${e?.message ?? e}`));
    win.webContents.on("console-message", (_e, _l, msg) => { if (!msg.startsWith("[vite]")) console.log(`SMOKE page: ${msg.slice(0, 200)}`); });
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          // optional page poke before the capture (e.g. flip the theme for a second shot)
          if (process.env.SVRE_APP_SMOKE_EVAL) {
            await win.webContents.executeJavaScript(process.env.SVRE_APP_SMOKE_EVAL)
              .catch((e) => console.log(`SMOKE eval: ${e?.message ?? e}`));
            await new Promise((res) => setTimeout(res, 400));
          }
          const probe = await Promise.race([
            win.webContents.executeJavaScript(
              // a fresh profile now lands on the welcome page, so `mode` is the field to read
              // first: bNew/loadState only mean anything once a project is open
              `JSON.stringify({ bridge: typeof window.svreHost, ready: document.readyState, title: document.title, bodyClass: document.body?.className ?? null, mode: window.svre?.mode ?? null, project: window.svre?.project?.path ?? null, welcome: !document.getElementById("welcome")?.hidden, bNew: document.getElementById("b-new") ? getComputedStyle(document.getElementById("b-new")).display : null, loadState: document.getElementById("load-state")?.textContent ?? null })`
            ),
            new Promise((res) => setTimeout(() => res("WEDGED"), 6000)),
          ]);
          console.log(`SMOKE PROBE ${probe}`);
          // the native menu is invisible to the page, so nothing else can check it
          const items = Menu.getApplicationMenu()?.items ?? [];
          console.log(`SMOKE MENU TOP ${JSON.stringify(items.map((i) => i.label ?? i.type))}`);
          const help = items.find((i) => i.id === "help");
          console.log(`SMOKE MENU ${JSON.stringify((help?.submenu?.items ?? []).map((i) => i.label ?? i.type))}`);
          // capturePage() returns the last *presented* frame, which for a window that was never
          // shown (show: !SMOKE) can lag arbitrarily far behind the live DOM; CDP's
          // captureScreenshot composites the current state on demand.
          let png;
          try {
            win.webContents.debugger.attach("1.3");
            // the CDP capture can hang forever on a never-shown window (observed once);
            // bound it so the capturePage fallback below actually runs
            const shot = await Promise.race([
              win.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png" }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("cdp screenshot timed out")), 8000)),
            ]);
            win.webContents.debugger.detach();
            png = Buffer.from(shot.data, "base64");
          } catch (e) {
            console.log(`SMOKE cdp: ${e?.message ?? e}`);
            try { win.webContents.debugger.detach(); } catch { /* never attached */ }
            png = (await win.webContents.capturePage()).toPNG();
          }
          fs.mkdirSync(path.dirname(SMOKE_SHOT), { recursive: true });
          fs.writeFileSync(SMOKE_SHOT, png);
          console.log(`SMOKE OK shot=${SMOKE_SHOT} url=${baseUrl}`);
        } catch (e) {
          console.error(`SMOKE FAIL ${e?.message ?? e}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 4000);
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    baseUrl = await startBackend();
    console.log(`svre backend: ${baseUrl} (${DEV ? "dev" : "prod"})`);
    ipcMain.on("svre:state", (_e, s) => buildMenu(s));
    // the custom titlebar's ☰ button pops the same native menu, at the button
    ipcMain.on("svre:menu-popup", (_e, pos) => {
      const m = Menu.getApplicationMenu();
      if (m) m.popup({ window: win, x: Math.round(pos?.x ?? 0), y: Math.round(pos?.y ?? 0) });
    });
    // ...and its min/max/close buttons drive the real window
    ipcMain.on("svre:win-control", (_e, action) => {
      if (!win) return;
      if (action === "min") win.minimize();
      else if (action === "max") { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
      else if (action === "close") win.close();
    });
    // native pickers (renderer never gets raw dialog access)
    ipcMain.handle("svre:pick-dir", async (_e, title) => {
      // createDirectory is what makes this a "new folder" dialog too: Open Project and New Project
      // are the same picker with a different title (the renderer names it in the interface language)
      const r = await dialog.showOpenDialog(win, {
        title: title || "Choose folder",
        properties: ["openDirectory", "createDirectory"],
      });
      return r.canceled ? null : r.filePaths[0];
    });
    // the welcome page's recent rows: show a project folder in Explorer/Finder
    ipcMain.handle("svre:reveal-path", async (_e, p) => {
      if (typeof p === "string" && p) shell.showItemInFolder(p);
    });
    // the caller names the file kind (the wizard's "where is the Stoneshard data file"),
    // so the picker can speak the interface language like everything else
    ipcMain.handle("svre:pick-file", async (_e, title, filterName) => {
      const r = await dialog.showOpenDialog(win, {
        title: title || "Choose the Stoneshard data file",
        filters: [{ name: filterName || "Stoneshard data file", extensions: ["win"] }],
        properties: ["openFile"],
      });
      return r.canceled ? null : r.filePaths[0];
    });
    buildMenu(menuState);
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
