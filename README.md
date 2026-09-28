# sv-room-editor

StoneShard 专用房间编辑器。读写的是 MSL 的房间 JSON（`Msl.AddRoomJson` 吃的那种、
约定用 `.gml` 后缀装在 mod 的 `Codes/` 下），按游戏自己的规则把房间画出来。

当前阶段：**P0：只读查看器**。它的作用是验证渲染保真度（见文末）。

## 跑起来

```bash
npm install
npm run extract     # 首次或游戏更新后：从 vallina.win 导出资产缓存（几分钟，约 435 MB）
npm run dev         # http://localhost:5178/?room=r_sv_hut_inside1.gml
```

路径都在 `svre.config.json`。本机要改路径时，写一个 `svre.config.local.json` 覆盖，这个文件不入库。

| 键 | 含义 |
|---|---|
| `modDir` | mod 源码目录；房间从 `<modDir>/Codes/*.gml` 列出 |
| `assetsDir` | 资产缓存（游戏美术）。**必须在 git 和任何 mod 目录树之外**：MSL 会把 mod 树里任何位置的 `*.png` 打成 sprite |
| `sourceDir` | 反编译源码（`gml_Object_*_Create_0.gml` 等），供事件扫描用 |
| `vanillaWin` | 未改动的原版 data 文件（`data.win` 是 patch 产物，不能用） |
| `utmtCli` | `UndertaleModCli.exe` |

操作：滚轮以光标为中心缩放；拖动平移；单击选中实例，检查器显示该实例的全部字段，以及 depth 和可见性各自的来源；`F` 适配窗口、`1` 切到 1:1、`G` 开关网格、`Esc` 取消选择。左栏点图层可显隐。

## 画面从哪来

| 决定画面的东西 | 编辑器从哪拿 |
|---|---|
| 位置 / 缩放 / 帧 / 颜色 | 房间 JSON |
| sprite、原点、裁边 | `sprites.json`：data.win 里的贴图页矩形，贴图页原样导出 |
| 绘制顺序 | depth 大的先画。实例初始深度是图层深度；如果对象的 Create 链里改了 depth（`o_barrier` 一族的 `-y + 18` 等），以 Create 为准。见 `create.json` |
| 画不画 | 对象的 `visible`（或 Create 里的覆盖）且图层 `is_visible`；另外 **Draw 事件只画悬停高亮的对象（门、梯子、炉灶）在静止画面里什么也不画**，它们的图烘焙在墙和背景 sprite 里 |
| 烙进背景的贴花 | `scr_bgRenderAdd` 的对象画在 o_background_render 的深度（135 或 125） |

`create.json` 是 `extract/scan-create.mjs` 对反编译源码做的静态扫描：沿父链重放 `event_inherited()`，只认覆盖了九成五以上场景的几种写法。认不出的对象标为未知，回退到图层深度，并在检查器里写明，不猜。

## 已知不在画面里的东西

这些不是编辑器画错了，而是它们不在房间数据里：

- **野外的底层草地和树林**：运行时由 `o_biome_switcher` 按群系生成。
- **C# 事后补进房间的实例**，例如 StoneValley 的 `o_sv_house01`。原因是 `AddRoomJson` 解析不到 mod 自建对象，会静默丢弃，只能事后用 `AddGameObject` 补。
- **mod 自建的 sprite 和对象**：资产缓存只来自原版。
- 玩家、雾、光照。

## P0 保真度验证（2026-09-28）

在 `r_sv_hut_mid` 上，拿游戏内截图（1920×1080，2 倍像素）和编辑器同一镜头下的渲染逐块对比：房间数据里的每一件东西，sprite、帧、位置、遮挡顺序都与游戏一致，剩下的差异是镜头估计的几像素偏移。差异只出现在上一节列出的那几类东西上。
