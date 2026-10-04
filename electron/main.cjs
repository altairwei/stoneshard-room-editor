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
let menuState = { theme: "dark", zmode: "game", tool: "select", toggles: {}, mode: "welcome", project: null, recent: [], lang: "zh" };
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
const VIEW_TOGGLES = [
  ["snap", "吸附 (S)"],
  ["hidden", "隐形对象 (Shift+H)"],
  ["collision", "碰撞"],
  ["markers", "标记"],
  ["grid", "网格 (G)"],
  ["notes", "便签"],
];
const TOOLS = [
  ["select", "选择 (V)"],
  ["hand", "抓手 (H)"],
  ["place", "放置 (P)"],
  ["collision", "碰撞矩形 (C)"],
  ["barrier", "屏障涂刷 (B)"],
  ["zone", "区域 (T)"],
  ["marker", "标记 (M)"],
  ["note", "便签 (N)"],
];

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
  const devItems = DEV
    ? [
        { label: "开发", submenu: [{ role: "reload", label: "重新加载" }, { role: "toggleDevTools", label: "开发者工具" }] },
      ]
    : [];
  const template = [
    {
      label: "文件",
      submenu: [
        // A project IS the working directory, so these are the first thing in the menu --
        // and they stay enabled with nothing open, because that is the welcome page.
        { label: "新建项目…", click: () => send("project.new") },
        { label: "打开项目…", accelerator: "CmdOrCtrl+K CmdOrCtrl+O", click: () => send("project.open") },
        {
          label: "最近打开",
          enabled: recent.length > 0,
          submenu: recent.map((r) => ({
            // no digit accelerators: CmdOrCtrl+1 is 实际像素, and a path is not a
            // keyboard target anyway
            label: r.exists ? `${r.name}  (${r.path})` : `${r.name}  (${r.path}) — 文件夹不在了`,
            click: () => send(RECENT_MENU_PREFIX + r.path),
          })),
        },
        { label: "关闭项目", enabled: !!proj, click: () => send("project.close") },
        { type: "separator" },
        { label: "新建房间…", accelerator: "CmdOrCtrl+N", enabled: ready(s), click: () => send("file.new") },
        { label: "打开原版房间（只读）…", accelerator: "CmdOrCtrl+O", enabled: ready(s), click: () => send("file.vanilla") },
        { type: "separator" },
        { label: "导入 sprite…", enabled: ready(s), click: () => send("file.importSprite") },
        { type: "separator" },
        { label: "编译", accelerator: "CmdOrCtrl+S", enabled: ready(s), click: () => send("file.compile") },
        { type: "separator" },
        {
          label: "打开 mod 目录",
          // the path comes from the pushed state, not from a cached fetch of our own
          enabled: !!proj?.exists,
          click: () => shell.openPath(proj?.path ?? ""),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", click: () => send("edit.undo") },
        { label: "重做", accelerator: "CmdOrCtrl+Y", click: () => send("edit.redo") },
        { type: "separator" },
        { label: "查找实例", accelerator: "CmdOrCtrl+F", click: () => send("edit.find") },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "主题：白天", type: "radio", checked: s.theme === "light", click: () => send("view.theme.light") },
        { label: "主题：黑夜", type: "radio", checked: s.theme !== "light", click: () => send("view.theme.dark") },
        { type: "separator" },
        // each language names itself, so these need no translation of their own; the shell
        // reloads the page on pick, which re-localizes everything (?lang= is read by api()
        // at call time -- the same reason the browser dropdown re-paints in place)
        {
          label: "界面语言",
          submenu: [
            { label: "中文", type: "radio", checked: s.lang === "zh", click: () => send("lang.set.zh") },
            { label: "English", type: "radio", checked: s.lang === "en", click: () => send("lang.set.en") },
            { label: "Русский", type: "radio", checked: s.lang === "ru", click: () => send("lang.set.ru") },
          ],
        },
        { type: "separator" },
        { label: "顺序：游戏（游戏内真实遮挡）", type: "radio", checked: s.zmode !== "static", click: () => send("view.zmode.game") },
        { label: "顺序：静态（UTMT 对账视图）", type: "radio", checked: s.zmode === "static", click: () => send("view.zmode.static") },
        { type: "separator" },
        ...VIEW_TOGGLES.map(([key, label]) => ({
          label,
          type: "checkbox",
          checked: !!s.toggles?.[key],
          click: () => send(`view.toggle.${key}`),
        })),
        { type: "separator" },
        // the project's diagnostics; the same two panes the status bar's count opens
        // the accelerator toggles (matching the renderer's own binding); the two entries
        // below it land on a specific pane instead
        { label: "问题与日志", accelerator: "CmdOrCtrl+Shift+M", click: () => send("view.panel.toggle") },
        { label: "只看问题", click: () => send("view.panel.problems") },
        { label: "只看日志", click: () => send("view.panel.log") },
        { type: "separator" },
        { label: "放大", accelerator: "CmdOrCtrl+=", click: () => send("view.zoomIn") },
        { label: "缩小", accelerator: "CmdOrCtrl+-", click: () => send("view.zoomOut") },
        { label: "适配窗口", accelerator: "CmdOrCtrl+0", click: () => send("view.fit") },
        { label: "实际像素", accelerator: "CmdOrCtrl+1", click: () => send("view.one") },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "工具",
      submenu: TOOLS.map(([kind, label]) => ({
        label,
        type: "radio",
        checked: s.tool === kind,
        click: () => send(`tool.${kind}`),
      })),
    },
    ...devItems,
    {
      label: "帮助",
      submenu: [
        // machine-level only (game data / UTMT / cache / decompiled source): this is not
        // project setup, and the game gets updated while the app does not
        { label: "本机设置…", click: () => send("help.setup") },
        { type: "separator" },
        {
          label: "关于 Stoneshard Room Editor",
          click: () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: "关于",
              message: `Stoneshard Room Editor v${app.getVersion()}`,
              // from the pushed snapshot: the shell holds no path of its own to go stale
              detail: `后端：${baseUrl}\n项目：${menuState.project?.path ?? "（未打开项目）"}\n模式：${DEV ? "开发（vite HMR）" : "打包（内嵌后端 + dist）"}`,
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
          const help = (Menu.getApplicationMenu()?.items ?? []).find((i) => i.label === "帮助");
          console.log(`SMOKE MENU ${JSON.stringify((help?.submenu?.items ?? []).map((i) => i.label ?? i.type))}`);
          const png = (await win.webContents.capturePage()).toPNG();
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
      // createDirectory is what makes this a "new folder" dialog too: 打开项目 and 新建项目
      // are the same picker with a different title
      const r = await dialog.showOpenDialog(win, {
        title: title || "选择文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      return r.canceled ? null : r.filePaths[0];
    });
    // the welcome page's recent rows: show a project folder in Explorer/Finder
    ipcMain.handle("svre:reveal-path", async (_e, p) => {
      if (typeof p === "string" && p) shell.showItemInFolder(p);
    });
    ipcMain.handle("svre:pick-file", async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "选择 Stoneshard 数据文件",
        filters: [{ name: "Stoneshard 数据文件", extensions: ["win"] }],
        properties: ["openFile"],
      });
      return r.canceled ? null : r.filePaths[0];
    });
    buildMenu(menuState);
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
