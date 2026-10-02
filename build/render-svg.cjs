// Rasterize SVGs with Electron's Chromium (vector-rendered at each target size, so small
// sizes come out properly hinted instead of downscaled). Writes <svg-name>-<size>.png.
// usage: electron build/render-svg.cjs <out-dir> <sizes,comma,separated> <file.svg>...
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const [outDir, sizeArg, ...files] = process.argv.slice(process.defaultApp ? 2 : 1);
  const sizes = sizeArg.split(",").map(Number);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html,<!doctype html><title>r</title>");
  for (const file of files) {
    const src = "data:image/svg+xml;base64," + fs.readFileSync(file).toString("base64");
    for (const s of sizes) {
      const url = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
        const c = document.createElement("canvas"); c.width = c.height = ${s};
        c.getContext("2d").drawImage(img, 0, 0, ${s}, ${s});
        return c.toDataURL("image/png");
      })()`);
      const name = path.basename(file, ".svg") + "-" + s + ".png";
      fs.writeFileSync(path.join(outDir, name), Buffer.from(url.split(",")[1], "base64"));
    }
  }
  app.quit();
});
