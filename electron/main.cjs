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
let menuState = { theme: "dark", zmode: "game", tool: "select", toggles: {} };
let modDirCache = null;

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
    await waitForHttp(`${url}/api/rooms`);
    return url;
  }
  const { startSvreServer } = require("../dist-server/standalone.cjs");
  const { port } = await startSvreServer({ root: ROOT, staticDir: path.join(ROOT, "dist") });
  return `http://127.0.0.1:${port}`;
}

async function modDir() {
  if (!modDirCache) {
    const cfg = await (await fetch(`${baseUrl}/api/config`)).json();
    modDirCache = cfg.modDir;
  }
  return modDirCache;
}

const send = (id) => win?.webContents.send("svre:menu", id);
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
  menuState = s;
  const devItems = DEV
    ? [
        { label: "开发", submenu: [{ role: "reload", label: "重新加载" }, { role: "toggleDevTools", label: "开发者工具" }] },
      ]
    : [];
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "新建房间…", accelerator: "CmdOrCtrl+N", click: () => send("file.new") },
        { label: "打开原版房间（只读）…", accelerator: "CmdOrCtrl+O", click: () => send("file.vanilla") },
        { type: "separator" },
        { label: "导入 sprite…", click: () => send("file.importSprite") },
        { type: "separator" },
        { label: "编译", accelerator: "CmdOrCtrl+S", click: () => send("file.compile") },
        { type: "separator" },
        {
          label: "打开 mod 目录",
          click: async () => shell.openPath(await modDir()),
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
        {
          label: "关于 Stoneshard Room Editor",
          click: async () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: "关于",
              message: `Stoneshard Room Editor v${app.getVersion()}`,
              detail: `后端：${baseUrl}\nmod 目录：${await modDir()}\n模式：${DEV ? "开发（vite HMR）" : "打包（内嵌后端 + dist）"}`,
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
    webPreferences: {
      preload: process.env.SVRE_APP_NO_PRELOAD ? undefined : path.join(__dirname, "preload.cjs"), // escape hatch for bisecting
      contextIsolation: true,
      spellcheck: false,
      // an editor must keep painting while the user is in UTMT/the game; also, hidden
      // windows otherwise throttle rAF+timers and this app's render heartbeat misbehaves
      backgroundThrottling: false,
    },
  });
  win.loadURL(process.env.SVRE_APP_URL || baseUrl + (process.env.SVRE_APP_QUERY ?? ""));
  if (SMOKE) {
    win.webContents.on("render-process-gone", (_e, d) => console.log(`SMOKE renderer gone: ${JSON.stringify(d)}`));
    win.webContents.on("unresponsive", () => console.log("SMOKE renderer unresponsive"));
    win.webContents.on("preload-error", (_e, p, e) => console.log(`SMOKE preload error at ${p}: ${e?.message ?? e}`));
    win.webContents.on("console-message", (_e, _l, msg) => { if (!msg.startsWith("[vite]")) console.log(`SMOKE page: ${msg.slice(0, 200)}`); });
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const probe = await Promise.race([
            win.webContents.executeJavaScript(
              `JSON.stringify({ bridge: typeof window.svreHost, ready: document.readyState, title: document.title, bodyClass: document.body?.className ?? null, bNew: document.getElementById("b-new") ? getComputedStyle(document.getElementById("b-new")).display : null, loadState: document.getElementById("load-state")?.textContent ?? null })`
            ),
            new Promise((res) => setTimeout(() => res("WEDGED"), 6000)),
          ]);
          console.log(`SMOKE PROBE ${probe}`);
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
    buildMenu(menuState);
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
