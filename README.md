# sv-room-editor

StoneShard 专用房间编辑器，**人和 agent 共用一份文档**。读写的是 MSL 的房间 JSON
（`Msl.AddRoomJson` 吃的那种），按游戏自己的规则把房间画出来。
P0 渲染保真度已对游戏截图验证过（见文末）。

## 模型

房间 = **基底 + 追加式操作日志**，存在 mod 的 `rooms/<name>.room.json`（进 git）：

- 基底是一个原版房间的导出（`cache/assets/rooms/`，1067 个全量缓存，游戏更新后重新 extract）。
- 日志里每条条目是一次改动（一次拖动、一次删除、一批 agent 操作），带作者、时间、注释。
- 每个操作（op）只有六种：`add / delete / set / relayer / room / layer`，都带 `expect`
  乐观锁——目标被别人动过就拒（409），agent 的过期编辑不会落在人类改过的东西上。
  `relayer` 也兼任**调序**：`layer` 写它自己那层、`before` 写同层另一个实例的 id，
  就是把它挪到锚点前面（数组顺序 = 游戏内创建顺序，同深度时后画的盖住先画的）。
- `rooms/<name>.compiled.json` 是**编译快照**：`compile` 重放日志到基底上写出来。
  没人手改它；磁盘上的文件和上次编译不一致 = 漂移（drift），要么 `adopt` 把外部改动
  记成一条日志，要么强制覆盖。
- `<Mod>.Rooms.g.cs` 是**生成的运输形态**：每个快照嵌成一个 raw string const（C# 11，
  打包器的 Roslyn 4.7 实测支持）加 `SvGeneratedRooms.Register()`，房间 JSON 就这样
  随程序集进 `.sml`——不用再伪装成 `.gml` 给 `ModFiles.GetCode` 读（打包器也只收
  `Codes/*.gml`，别的扩展名根本不进包，实测）。GENERATED，别手改；server 启动和每次
  compile/import/adopt 时从快照自愈重写（有漂移的快照会卡住整个重写，防止把篡改进构建）。

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
| `modDir` | mod 源码目录；房间工程与编译快照在 `<modDir>/rooms/`，生成的 `<Mod>.Rooms.g.cs` 在根目录 |
| `assetsDir` | 资产缓存（游戏美术）。**必须在 git 和任何 mod 目录树之外** |
| `sourceDir` | 反编译源码（`gml_Object_*_Create_0.gml` 等），供事件扫描用 |
| `vanillaWin` | 未改动的原版 data 文件（`data.win` 是 patch 产物，不能用） |
| `utmtCli` | `UndertaleModCli.exe` |

## 人：浏览器

| 操作 | 效果 |
|---|---|
| 工具箱（画布左沿）：V 选择 · H 抓手 · P 放置 · C 碰撞涂刷 · T 区域 · M 标记 · N 便签 | 便签工具单击 = 留便签，拖动 = 平移；P 没选过对象时先开「对象」页签 |
| C 碰撞矩形：拖动 | 拖出一个 o_hut_wall 碰撞矩形（红色戳；边吸附格线 = scale 恒为整数格数，与原版数据一致——原版 78% 是缩放矩形；单击 = 光标下那格）；改动用选中后的八柄 resize，删除用 Del |
| B 屏障涂刷：拖动 / Alt+拖动 | 刷/擦 o_projectileBarrier 屏障格（挡箭/投掷物；按原版 sprite 显示，与 UTMT 一致；与碰撞格按家族分别去重，可共存同格） |
| T 区域：拖动 | 拖出一个纯色盒功能对象（oCameraStatic、trigger、surface……与尺寸手柄同一套像素判据，选项栏下拉换对象）；边吸附格线，单击 = 光标下那格 |
| M 标记：单击 | 放出生点/灯光/路标等功能标记（选项栏下拉换对象），吸附格点 |
| o_barrier_marker 的呈现 | 它可见且 sprite 是纯绿方块，但游戏里总被它注释的 -y 墙体盖住看不见 → 画布按**隐形对象**处理：真实绿色 sprite 按原样显示（默认显示、Shift+H 可关）、可点选、可八柄 resize——不用菱形替代。被碰撞格压住时先关「碰撞格」再点（通用带状优先级） |
| 功能对象的落点图层 | 自动归位：已有同类的层 → o_hut_wall 进碰撞层 → o_projectileBarrier 进 Projectiles 层（没有则碰撞层） → 相机盒进相机层 → c_zone 进 Surfaces → 当前层 |
| 「图层」页签（默认） | 每个实例一行 = Photoshop 意义的图层：缩略图、id、位置、Create 深度徽标；拖动行调遮挡顺序（同组 = 同层调序，跨组 = 换层，拖到组头 = 该层最前）；眼睛 = 编辑器内隐藏（不进游戏）；单击选中，双击聚焦 |
| 「层组」页签 | GameMaker 图层（分组）：放置目标层与整层显隐 |
| 单击 / Shift+单击 / 空白处拖动 | 选中 / 加选 / 框选（点选取最上层：碰撞格/隐藏盒/标记盖住家具，要搬被盖住的家具先在「层组」页签把对应整层眼睛关掉） |
| 拖动选中的实例 | 移动；吸附开时**落点**对齐最近格角（起点的微小偏差被一并吸收），Alt/关吸附 = 整像素自由 |
| 拖动选中覆盖矩形的八个手柄（碰撞/触发区/墙面等纯色盒） | 改长宽；吸附开时**按整格增减**（scale 恒为整数格数，与游戏数据一致；可视框不再贴格线），原点同时就近落格角、吃掉初始偏差；Alt/关吸附 = 整像素自由 |
| 抓手工具、中键、右键拖动或空格拖动；滚轮 | 平移；缩放 |
| 右键单击 | 在那个位置留便签（agent 也读得到） |
| 方向键 / Shift+方向键 | 微调 1px / 一格 |
| Del · Ctrl+D · Ctrl+C/V · Ctrl+A | 删除 · 原地复制 · 复制粘贴 · 全选当前图层 |
| Ctrl+Z / Ctrl+Y · Ctrl+S | 撤销 / 重做（只动自己的条目）· 编译 |
| Ctrl+K 或「对象」页签 | 搜对象放置，Esc 结束 |
| + / − · F / Ctrl+0 适配 · 1 / Ctrl+1 实际像素 | 缩放步进；选项栏右侧下拉选预设 |
| S 吸附 · Shift+H 隐形对象 · G 网格 | 显示/编辑开关（选项栏的图标按钮） |
| 画布上沿/左沿的标尺 | 世界像素刻度；蓝色区段 = 房间范围，蓝线 = 光标 |
| 「历史」页签 | 所有人的改动日志（点一条高亮它碰的实例）+ 便签管理 |
| 新建… | 从原版房间派生新房间（全量复制或只留控制器） |

agent 改动到达时页面弹 toast 并刷新；agent 的选区以橙色框显示。选项栏下方的横幅
（banner）提示漂移/基底变更；漂移时给「采纳」按钮。右侧「属性」面板可折叠（记住状态）。

## agent：svre CLI

```bash
python cli/svre.py rooms                          # 状态一览（未编译/漂移/生成器归属）
python cli/svre.py import r_sv_hut_inside1        # 把遗留的 Codes/r_x.gml 变成工程（基底自动推断）
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
  保留；导入时验证"基底+日志重放 == 磁盘字节"，不等就拒绝；`Rooms.g.cs` 里的 const
  与快照逐字节相等（e2e 钉死）。
- **key 顺序不动**：`AddRoomJson` 按位置读 JSON，新建实例的字段顺序照抄导出器。
- 顶层 `game_objects` 与图层实例按 id 保持同步。
- **冲突保护**：op 级 `expect`；磁盘漂移不静默覆盖；撤销只追加逆操作不改写历史。

```bash
python test/e2e_edit.py    # HTTP 全套（导入/字节一致/apply/409/撤销/漂移/采纳）+ 浏览器拖拽/WS/编译
python test/smoke_cli.py   # CLI 全命令冒烟 + Rooms.g.cs 生成/自愈
node test/diff_rooms.ts    # 四个编译快照 diff→重放→序列化逐字节一致
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

**mod 自建资产**的单一事实源是 mod 根目录的 **`assets.json`**（编辑器拥有的声明式
清单），它有两个消费者，结构上不可能漂移：

- 编辑器读取渲染：`server/modassets.ts` 扫 `Sprites/<name>_<N>.png`（第 N 帧；裸
  `<name>.png` 单帧）得尺寸与帧表，再叠加 assets.json 里的对象注册
  （sprite/parent/visible/persistent/awake/collision）与 sprite 原点/margin 覆盖。
  每张 PNG 自成一个伪贴图页（页号 ≥ 1,000,000），走与原版完全相同的 Frame/纹理管线。
- 游戏注册：同一份 manifest 被确定性地生成成 `<Mod>.Assets.g.cs`（
  `SvGeneratedAssets.Register()`，命名参数与属性赋值两种风格按字段集选择），
  mod 的 `PatchMod()` 里手写一行调用，排在 AddRoomJson/AddNewEvent 之前
  （`RequireObjectInstances` 照旧兜底）。**编辑器自愈**：任何一次扫描（server 启动、
  `/api/mod-assets`、房间 compile）发现 .g.cs 与 manifest 不一致就重写它；
  也可显式 `svre assets sync`。
- 校验随扫描发生：sprite 没有 PNG、parent 不在原版对象表、没写 visible（MSL 默认
  false）都会进响应的 `warnings`。
- mod 对象的 Create 事实沿父链取（父链是原版的，`from` 标注保持真实来源）；
  create.json 只扫原版，不猜 mod 对象的运行时行为。
- 端点：`GET /api/mod-assets`（每次请求重扫+自愈）、`POST /api/mod-assets/sync`、
  `GET /mod-assets/pages/<i>.png`（no-store）。
- 例外通道：需要计算逻辑的注册（非常量）继续手写 C#——编辑器看不到它，这是划好的
  边界。

## 已知不在画面里的东西

- **野外的底层草地和树林**：运行时由 `o_biome_switcher` 生成。
- **C# 事后补进房间的实例**（如运行时 `instance_create` 出来的东西）。
- 玩家、雾、光照。

## P0 保真度验证（2026-09-28）

`r_sv_hut_mid`（室外）与 `r_sv_hut_inside1`（室内，游戏内传送截图）逐像素比对：
房间数据里的每一件东西——sprite、帧、位置、遮挡顺序——与游戏一致；室内在拟合掉
全局光照增益后 **100% 像素误差 ≤ 6**，几何逐像素一致。
