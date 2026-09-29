# sv-room-editor

StoneShard 专用房间编辑器，**人和 agent 共用一份文档**。读写的是 MSL 的房间 JSON
（`Msl.AddRoomJson` 吃的那种、约定用 `.gml` 后缀装在 mod 的 `Codes/` 下），按游戏自己的
规则把房间画出来。P0 渲染保真度已对游戏截图验证过（见文末）。

## 模型

房间 = **基底 + 追加式操作日志**，存在 mod 的 `rooms/<name>.room.json`（进 git）：

- 基底是一个原版房间的导出（`cache/assets/rooms/`，1067 个全量缓存，游戏更新后重新 extract）。
- 日志里每条条目是一次改动（一次拖动、一次删除、一批 agent 操作），带作者、时间、注释。
- 每个操作（op）只有六种：`add / delete / set / relayer / room / layer`，都带 `expect`
  乐观锁——目标被别人动过就拒（409），agent 的过期编辑不会落在人类改过的东西上。
- `Codes/<name>.gml` 是**编译产物**：`compile` 重放日志到基底上写出来，MSL 读它。
  没人手改它；磁盘上的文件和上次编译不一致 = 漂移（drift），要么 `adopt` 把外部改动
  记成一条日志，要么强制覆盖。

dev server（Vite 中间件）是文档的唯一持有者。浏览器是视图+命令客户端；agent 走
HTTP/`svre` CLI。同一套 op、同一套规则、同一份撤销历史（撤销按作者：agent 不会
撤销人类的活，反之亦然）。

## 跑起来

```bash
npm install
npm run extract     # 首次或游戏更新后：从 vallina.win 导出资产缓存（几分钟，约 435 MB）
npm run dev         # http://localhost:5178/?room=r_sv_hut_inside1
```

`svre.config.json`（不进 git 的路径在 `svre.config.local.json` 覆盖）：

| 键 | 含义 |
|---|---|
| `modDir` | mod 源码目录；房间工程在 `<modDir>/rooms/`，编译产物在 `<modDir>/Codes/` |
| `assetsDir` | 资产缓存（游戏美术）。**必须在 git 和任何 mod 目录树之外** |
| `sourceDir` | 反编译源码（`gml_Object_*_Create_0.gml` 等），供事件扫描用 |
| `vanillaWin` | 未改动的原版 data 文件（`data.win` 是 patch 产物，不能用） |
| `utmtCli` | `UndertaleModCli.exe` |

## 人：浏览器

| 操作 | 效果 |
|---|---|
| 单击 / Shift+单击 / 空白处拖动 | 选中 / 加选 / 框选 |
| 拖动选中的实例 | 移动；默认按 26px 吸附**位移量**，Alt 临时自由 |
| 中键、右键拖动或空格拖动；滚轮 | 平移；缩放 |
| 右键单击 | 在那个位置留便签（agent 也读得到） |
| 方向键 / Shift+方向键 | 微调 1px / 一格 |
| Del · Ctrl+D · Ctrl+C/V · Ctrl+A | 删除 · 原地复制 · 复制粘贴 · 全选当前图层 |
| Ctrl+Z / Ctrl+Y · Ctrl+S | 撤销 / 重做（只动自己的条目）· 编译 |
| Ctrl+K 或「对象」页签 | 搜对象放置，Esc 结束 |
| 「历史」页签 | 所有人的改动日志（点一条高亮它碰的实例）+ 便签管理 |
| 新建… | 从原版房间派生新房间（全量复制或只留控制器） |

agent 改动到达时页面弹 toast 并刷新；agent 的选区以橙色框显示。顶栏的 ⚠ 提示
漂移/基底变更；漂移时给「采纳」按钮。

## agent：svre CLI

```bash
python cli/svre.py rooms                          # 状态一览（未编译/漂移/生成器归属）
python cli/svre.py import r_sv_hut_inside1        # 把现有 Codes 文件变成工程（基底自动推断）
python cli/svre.py describe r_sv_hut_inside1      # 概况 + 门链 + 问题
python cli/svre.py grid r_sv_hut_inside1 10,4,30,20
python cli/svre.py query r_sv_hut_inside1 --object o_chest
python cli/svre.py apply r_x --ops ops.json --label "..." --by claude
python cli/svre.py compile r_x
python cli/svre.py render r_x out.png --zoom 2 --grid --labels
python cli/svre.py --help                         # 全部命令 + op 词汇表
```

配套技能 `.claude/skills/stoneshard-room-editor`（在 mod 仓库里）教 agent 完整工作流。

## 存盘的保证

- **没改过的房间编译逐字节不变**：JSON 版式与导出器一致，换行符与末尾换行按原文件
  保留；导入时验证"基底+日志重放 == 磁盘字节"，不等就拒绝。
- **key 顺序不动**：`AddRoomJson` 按位置读 JSON，新建实例的字段顺序照抄导出器。
- 顶层 `game_objects` 与图层实例按 id 保持同步。
- **冲突保护**：op 级 `expect`；磁盘漂移不静默覆盖；撤销只追加逆操作不改写历史。

```bash
python test/e2e_edit.py    # HTTP 全套（导入/字节一致/apply/409/撤销/漂移/采纳）+ 浏览器拖拽/WS/编译
python test/smoke_cli.py   # CLI 全命令冒烟
node test/diff_rooms.ts    # 四个生成器产出 diff→重放→序列化逐字节一致
```

## 画面从哪来

| 决定画面的东西 | 编辑器从哪拿 |
|---|---|
| 位置 / 缩放 / 帧 / 颜色 | 房间 JSON |
| sprite、原点、裁边 | `sprites.json`：data.win 里的贴图页矩形，贴图页原样导出 |
| 绘制顺序 | depth 大的先画。实例初始深度是图层深度；Create 链改了 depth 的以 Create 为准（`create.json`） |
| 画不画 | 对象 `visible`（或 Create 覆盖）且图层 `is_visible`；**Draw 只画悬停高亮的对象（门、梯子、炉灶）静止时什么也不画**，图烘焙在墙 sprite 里 |
| 烙进背景的贴花 | `scr_bgRenderAdd` 的对象画在 o_background_render 的深度（135 或 125） |

`create.json` 是 `extract/scan-create.mjs` 对反编译源码的静态扫描：沿父链重放
`event_inherited()`，只认覆盖九成五场景的几种写法；认不出的标未知、回退图层深度、
检查器写明，不猜。Step_0 同法：每帧重写 depth 的以 Step 为准（门族 `-y - start_depth`）。
房间 CC 里改的 `start_depth` 还没读，留给 P3。

## 已知不在画面里的东西

- **野外的底层草地和树林**：运行时由 `o_biome_switcher` 生成。
- **C# 事后补进房间的实例**（如 `o_sv_house01` 的外壳）。
- **mod 自建的 sprite 和对象**：资产缓存只来自原版。但探针实证过：mod 对象在
  `AddRoomJson` **之前** `AddObject` 注册就能进房间 JSON，不会被丢。
- 玩家、雾、光照。

## P0 保真度验证（2026-09-28）

`r_sv_hut_mid`（室外）与 `r_sv_hut_inside1`（室内，游戏内传送截图）逐像素比对：
房间数据里的每一件东西——sprite、帧、位置、遮挡顺序——与游戏一致；室内在拟合掉
全局光照增益后 **100% 像素误差 ≤ 6**，几何逐像素一致。
