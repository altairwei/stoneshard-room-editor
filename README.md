# sv-room-editor

StoneShard 专用房间编辑器。读写的是 MSL 的房间 JSON（`Msl.AddRoomJson` 吃的那种、
约定用 `.gml` 后缀装在 mod 的 `Codes/` 下），按游戏自己的规则把房间画出来。

当前阶段：**P1：编辑核心**。P0 渲染保真度已经对游戏截图验证过（见文末）。

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

## 操作

| 操作 | 效果 |
|---|---|
| 单击 / Shift+单击 / 空白处拖动 | 选中 / 加选 / 框选 |
| 拖动选中的实例 | 移动；默认按 26px 吸附**位移量**（保留原有的格内偏移），按住 Alt 临时自由 |
| 中键、右键或按住空格拖动；滚轮 | 平移；以光标为中心缩放 |
| 方向键 / Shift+方向键 | 微调 1px / 一格 |
| Del · Ctrl+D · Ctrl+C / Ctrl+V · Ctrl+A | 删除 · 原地复制偏移一格 · 复制粘贴到光标处 · 全选当前图层 |
| Ctrl+Z / Ctrl+Y · Ctrl+S | 撤销 / 重做 · 保存 |
| Ctrl+K 或「对象」页签 | 搜对象、按家族筛（家具/建筑/门/碰撞），单击后在房间里单击放置，Esc 结束 |
| 检查器 | 改 x/y/缩放/旋转/帧/颜色/creation code、换图层；多选时改的是全部选中项 |
| 图层面板 | 单击图层名 = 设为当前图层（新对象放这里）；点圆点 = 显隐 |
| F · 1 · G · H · S | 适配 · 1:1 · 网格 · 隐形对象 · 吸附 |

### 存盘的保证

- **没改过的房间存盘逐字节不变**：JSON 版式与导出器一致，换行符（CRLF/LF）和末尾换行按原文件保留。`test/e2e_edit.py` 断言这一点。
- **key 顺序不动**：`AddRoomJson` 是按位置读 JSON 的，新建实例的字段顺序照抄导出器。
- 顶层 `game_objects` 按 instance_id 与图层实例保持同步（MSL 对 GMS2 忽略它，但文件不该自相矛盾）。
- **冲突保护**：保存时带上打开时的文件哈希；磁盘文件若被别人改过（另一个会话、生成器），服务器拒绝写入（409），编辑器里的改动保留。
- 由 `tools/` 下生成器产出的房间文件，顶部会显示警告：重新运行生成器会覆盖在编辑器里保存的修改。

```bash
python test/e2e_edit.py   # 对临时副本跑一遍编辑、撤销、放置、保存、冲突，不碰真 mod
```

## 画面从哪来

| 决定画面的东西 | 编辑器从哪拿 |
|---|---|
| 位置 / 缩放 / 帧 / 颜色 | 房间 JSON |
| sprite、原点、裁边 | `sprites.json`：data.win 里的贴图页矩形，贴图页原样导出 |
| 绘制顺序 | depth 大的先画。实例初始深度是图层深度；如果对象的 Create 链里改了 depth（`o_barrier` 一族的 `-y + 18` 等），以 Create 为准。见 `create.json` |
| 画不画 | 对象的 `visible`（或 Create 里的覆盖）且图层 `is_visible`；另外 **Draw 事件只画悬停高亮的对象（门、梯子、炉灶）在静止画面里什么也不画**，它们的图烘焙在墙和背景 sprite 里 |
| 烙进背景的贴花 | `scr_bgRenderAdd` 的对象画在 o_background_render 的深度（135 或 125） |

`create.json` 是 `extract/scan-create.mjs` 对反编译源码做的静态扫描：沿父链重放 `event_inherited()`，只认覆盖了九成五以上场景的几种写法。认不出的对象标为未知，回退到图层深度，并在检查器里写明，不猜。Step_0 也按同样办法扫：在 Step 里每帧重写 depth 的对象，以 Step 为准，例如门族的 `depth = -y - start_depth`。但房间 CC 里改的 `start_depth` 还没读，留给 P3。

## 已知不在画面里的东西

这些不是编辑器画错了，而是它们不在房间数据里：

- **野外的底层草地和树林**：运行时由 `o_biome_switcher` 按群系生成。
- **C# 事后补进房间的实例**，例如 StoneValley 的 `o_sv_house01`。原因是 `AddRoomJson` 解析不到 mod 自建对象，会静默丢弃，只能事后用 `AddGameObject` 补。
- **mod 自建的 sprite 和对象**：资产缓存只来自原版。
- 玩家、雾、光照。

## P0 保真度验证（2026-09-28）

在 `r_sv_hut_mid` 上，拿游戏内截图（1920×1080，2 倍像素）和编辑器同一镜头下的渲染逐块对比：房间数据里的每一件东西，sprite、帧、位置、遮挡顺序都与游戏一致，剩下的差异是镜头估计的几像素偏移。差异只出现在上一节列出的那几类东西上。

室内（`r_sv_hut_inside1`，同日）：在游戏里用 `room sv_hut_inside1` 传送进去截图，与编辑器 2 倍渲染对齐比对。把游戏室内光照当作一次全局的逐通道增益（约 ×0.90 / ×0.83 / ×0.72）拟合掉之后，**100% 像素误差在 6 以内**，几何上逐像素一致。
