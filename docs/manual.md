# Stoneshard Room Editor · 手册

[README](../README.md) 是项目门面（截图、下载、快速上手）；这里是完整手册：数据模型、
编辑器操作全表、项目制、本机设置向导、打包分发、agent CLI、存盘的保证与渲染细节。

通用的 Stoneshard 房间编辑器，**人和 agent 共用一份文档**。读写的是 MSL 的房间 JSON
（`Msl.AddRoomJson` 吃的那种），按游戏自己的规则把房间画出来。
P0 渲染保真度已对游戏截图验证过（见文末）。

## 模型

房间 = **基底 + 追加式操作日志**，存在 mod 的 `rooms/<name>.room.json`（进 git）：

- 基底是一个原版房间的导出（`cache/assets/rooms/`，1067 个全量缓存，游戏更新后重新 extract）。
- 日志里每条条目是一次改动（一次拖动、一次删除、一批 agent 操作），带作者、时间、注释。
- 每个操作（op）只有六种：`add / delete / set / relayer / room / layer`，都带 `expect`
  乐观锁——目标被别人动过就拒（409），agent 的过期编辑不会落在人类改过的东西上。
  `relayer` 也兼任**调序**：`layer` 写它自己那层、`before` 写同层另一个实例的 id，
  就是把它挪到锚点前面（数组靠后 = 静态视图里画得越靠上，与 UTMT 一致；数组顺序同时也
  是游戏内创建顺序，同深度平局时后建的盖住先建的）。
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
| `modDir` | **当前项目**：一个 mod 的源码目录。房间工程与编译快照在 `<modDir>/rooms/`，生成的 `<Mod>.Rooms.g.cs` 在根目录。空 = 没有项目（欢迎页） |
| `recent` | 最近打开的项目（最新在前，上限 10）。由应用维护，手改无害 |
| `assetsDir` | 资产缓存（游戏美术）。**必须在 git 和任何 mod 目录树之外** |
| `sourceDir` | 反编译源码（`gml_Object_*_Create_0.gml` 等），供事件扫描用 |
| `vanillaWin` | 未改动的原版 data 文件（`data.win` 是 patch 产物，不能用） |
| `utmtCli` | `UndertaleModCli.exe` |

环境变量覆盖（测试 / 打包用）：`SVRE_CONFIG`（改读另一个配置文件）、`SVRE_MOD_DIR`、
`SVRE_ASSETS_DIR`。应用写配置永不碰仓库里的 `svre.config.json`：开发机落在 gitignore 的
`svre.config.local.json`，打包安装落在 userData 的 `svre.config.json`。

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
| 对象库里「＋ 导入 sprite…」（或文件菜单） | 把新画的 PNG 注册成 mod 对象：选文件（多选 = 多帧，按 `_N` 排序）→ 自动起 sprite/对象名 → parent 默认 `o_shelf`（家具深度 depth=-y；它游戏内随机选帧，多帧要固定帧就清空 parent）→ 导入后立即可摆。写 `Sprites/*.png` + `assets.json`，生成的 C# 与所有打开着的客户端自动刷新 |
| + / − · F / Ctrl+0 适配 · 1 / Ctrl+1 实际像素 | 缩放步进；选项栏右侧下拉选预设 |
| S 吸附 · Shift+H 隐形对象 · G 网格 | 显示/编辑开关（选项栏的图标按钮） |
| 画布上沿/左沿的标尺 | 世界像素刻度；蓝色区段 = 房间范围，蓝线 = 光标 |
| 「历史」页签 | 所有人的改动日志（点一条高亮它碰的实例）+ 便签管理 |
| 新建… | 从原版房间派生新房间（全量复制或只留控制器） |
| 房间下拉 →「打开原版房间…」 | 只读查看任意原版缓存房间：双序画布、图层页签、检查器、静态/游戏切换全可用；不产生工程文件，一切编辑被拒绝（要修改请用「新建…」派生）。深链 `?room=<名>&vanilla=1` |
| 顶栏右端 ☀/🌙 | 白天/黑夜界面配色切换（记住选择）：UI 与画布衬板/网格/标尺换肤；房间美术、室内墙外的黑域（房间自带背景层，游戏数据）与 render 输出（恒深色底）不随主题变 |

agent 改动到达时页面弹 toast 并刷新；agent 的选区以橙色框显示。选项栏下方的横幅
（banner）提示漂移/基底变更；漂移时给「采纳」按钮。右侧「属性」面板可折叠（记住状态）。

## 人：Electron 桌面应用

```bash
npm run build:app   # 首次或前端改动后：vite 打包 dist/ + rolldown 打包 dist-server/
npm run app         # 桌面窗口（内嵌后端，随机回环端口，与 5178 开发服务器互不干扰）
npm run app:dev     # 开发形态：壳里拉一个 vite（5186，带 HMR），调前端代码用
```

同一个网页包，壳只多加**原生菜单**；搬入菜单的按钮在 Electron 里隐藏、浏览器里照旧：

| 菜单 | 内容 |
|---|---|
| 文件 | 新建项目… · 打开项目… Ctrl+K Ctrl+O · 最近打开 ▸ · 关闭项目 —— （打开项目后）新建房间… Ctrl+N · 打开原版房间（只读）… Ctrl+O · 导入 sprite… · 编译 Ctrl+S · 打开 mod 目录 · 退出 |
| 编辑 | 撤销 Ctrl+Z · 重做 Ctrl+Y · 查找实例 Ctrl+F（聚焦实例筛选框） |
| 视图 | 主题 白天/黑夜（单选）· 顺序 游戏/静态（单选）· 吸附/隐形/碰撞/标记/网格/便签（勾选）· 放大 Ctrl+= · 缩小 Ctrl+- · 适配 Ctrl+0 · 实际像素 Ctrl+1 · 全屏 |
| 工具 | 选择/抓手/放置/碰撞矩形/屏障涂刷/区域/标记/便签（单选，与工具箱同步） |
| 开发（仅 app:dev） | 重新加载 · 开发者工具 |
| 帮助 | 本机设置… · 关于（版本、后端地址、当前项目） |

壳是 **VS Code 式无边框窗口**：系统标题栏隐藏（`titleBarStyle:"hidden"`，原生边框/吸附/
阴影全保留），页面自绘 36px 标题栏 = 拖拽区 + ☰（在按钮处弹出同一套原生菜单）+ 跟随
document.title 的房间名标题 + 自绘最小化/最大化/关闭（titleBarOverlay 在 win10 实测不
渲染，故自绘；最大化经 `svre:win-state` 事件换「还原」图标）。

勾选/单选状态由页面实时回推（主题/顺序/工具/六个开关）。单字母快捷键不进菜单，
避免在输入框里打字被抢。注意：**Electron 不会弹出网页的 confirm/alert/prompt**
（调用即渲染进程死等），所有确认/输入框都是应用内对话框，别改回原生调用。

### 项目制：mod 源码目录就是工作目录

应用只有一条「当前项目」，就是配置里的 `modDir`——一个 mod 的源码目录。房间工程、
sprite、`assets.json` 注册清单、编译产物全写在里面，所以**美术交付 = 把那个文件夹发回**。

启动时服务端算清三个状态（`GET /api/setup` 的 `mode`），客户端只跟着分支，不重算：

| mode | 何时 | 页面 |
|---|---|---|
| `welcome` | 没有项目，或项目目录已经不在了 | 欢迎页（最近项目 / 打开文件夹… / 新建项目…） |
| `setup` | 有项目，但**本机**还没就绪（`reasons` 非空），或用户主动重跑 | 「本机设置」对话框盖在欢迎页/编辑器上 |
| `ready` | 两者都就位 | 编辑器 |

**「没有项目」不是缺陷，是正常状态**，所以它不混进 `reasons`——`reasons` 只记机器级
的缺口。两条轴因此独立：机器全新 + 项目齐全 = 直接编辑；机器就绪 + 没有项目 = 欢迎页
不弹任何向导。降级时只有 `/api/projects*`、`/api/setup*`、`/api/config` 应答，其余 503。

- **打开项目**（欢迎页、`文件 → 打开项目…`、`Ctrl+K Ctrl+O`、最近列表）：目录不像 mod
  源码（没有 `Codes/`、`Sprites/`、`assets.json`、`*.csproj` 任一）时提示一次，确认后
  照样打开并补齐骨架。目录名必须能当 C# 标识符（`/^[A-Za-z_]\w*$/`）——它会被写进
  `namespace` 与 `<Mod>.Rooms.g.cs`，不合法直接 400，请重命名文件夹（`force` 也不行）。
- **新建项目…** = 「打开」一个还不存在的文件夹（同一个对话框、同一条路由），只建编辑器
  骨架（`rooms/`、`Sprites/`、`Codes/`、空的 `assets.json`）；mod 本身交给 MSL。
- **切换项目后所有页面一律重载**：对象库只会并集、`/mod-assets/pages/<i>.png` 的页号只对
  当次扫描有效，软切换会把上一个项目的对象留在界面上。资产缓存与项目无关，**切项目
  永不重提取**。
- 正在提取/下载/切换时 `open`/`close` 一律 409。

### 本机设置（分发形态，与项目无关）

打包产物里**没有一字节资产缓存**（版权）——每台机器用机主自己正版游戏的 data 文件
现场提取。这是**这台机器**的事：换项目不会重来一遍。第一次启动（或缓存被删）时自动
弹出，之后从 `帮助 → 本机设置…` 打开：

1. **游戏数据文件**：自动探测所有 Steam 库（解析 `libraryfolders.vdf`）里的
   `vallina.win`（MSL 留的原版备份，优先）与 `data.win`，也可手选/手填。开发侧的
   参考版本（`extract/fingerprint.json`）就写在这一步。这一步同时显示**提取工具**
   （UTMT CLI）的状态：随包或已配置的副本直接用；一个都没有时（源码 clone——`vendor/`
   是 gitignored 的）给一个「下载并安装」按钮，从 GitHub 取钉住版本的官方 release
   （v0.9.2.0，约 60 MB）解到安装目录（打包形态 `<userData>/utmt`，开发形态
   `vendor/utmt/`，可用 `SVRE_UTMT_DIR` 改）。
2. **提取资产缓存**：UTMT CLI 一次载入连跑两个导出脚本（对象/sprite/贴图页 + 全部
   1067 个房间，约几分钟），完成后与开发侧钉的版本指纹比对：统计有出入只作**提示**
   （游戏更新、data.win 被 patch 过都会显示在这里），不是失败，照常继续。
3. **反编译源码**：`create.json` 是唯一**提取不出来**的缓存文件——对象的 `depth =
   -y + 18` 这类事实写在 GML 代码里，不在 data 文件里。用 UTMT 的「Decompile all
   code」把源码导出一份，把目录填进来，扫描（十几秒～一分钟，随包 `scan-create.mjs`，
   跑在 Electron 自己的 node 模式上，机器上不需要装 node）生成它；条目数与参考版本的
   差异同样只作提示。没有源码树可以**跳过**：编辑器照常能用，只是「游戏顺序」画布
   回退图层深度、启动时弹条提示；之后补上（`帮助 → 本机设置…`）即可。

后端热重进健康模式，不用重启。机器还没就绪时对话框是阻塞的（Esc 关不掉，提取会直接
写进正在用的缓存）；机器已经能用时它只是「来看一眼/重跑一遍」——关掉按钮就在，改完
照常编辑，不用重载。游戏更新后：开发机 `npm run extract` +
`node extract/fingerprint.mjs <新版本号>`（指纹含 `create` 条目数）；打包安装走菜单
**帮助 → 本机设置…**，用新的 data 文件重提取、再重扫源码（`sourceDir` 记着，直接回车
即可）。**旧缓存一直可用到新的一次提取成功**：途中关掉应用或提取失败都没有损失（提取
成功时才把过期的 `create.json` 一并作废，让第 3 步重新出现）。清空档案重来仍然可行：
删掉 `<userData>/cache/` 与配置里的 `assetsDir`。

### 打包分发（electron-builder）

```bash
npm run dist   # = build:app + vendor:utmt + electron-builder --win（安装版 + 便携 zip）
```

产物两种形态：`release/Stoneshard Room Editor Setup <版本>.exe`（NSIS 安装版，可选
安装路径）与 `release/Stoneshard Room Editor-<版本>-win.zip`（解压即用的绿色版），
含应用、内嵌后端、导出脚本与 UTMT CLI（MIT，可随包）；**不含**资产缓存（版权，首次的
本机设置现场提取），也不含 node_modules（前端 pixi 与后端依赖全部打进 bundle，运行时零
外部依赖）。

CI（`.github/workflows/release.yml`）：push `v*` tag（或手动触发）在 windows-latest
上跑同一条链——UTMT 不在 runner 上，workflow 先从官方 release 下载再喂给
`npm run vendor:utmt`；两种产物传成 artifact `windows-x64`。CI 无证书，产物未签名。

- `vendor/utmt/` 由 `npm run vendor:utmt` 从本机 `utmtCli` 的安装目录取（gitignored，
  每次打包前自动重跑）。用源码跑（`npm run dev`）而没跑过 vendor 的话，本机设置第 1 步会
  直接下载一份官方 release（钉在 `server/setup.ts` 的 `UTMT_RELEASE`，脚本只对那个
  版本测过）；网络不通时可用 `SVRE_UTMT_URL` 指向镜像或本地 zip，或手动解压一份到
  `vendor/utmt/`。若想去掉随包的 115 MB，就把 `electron-builder.yml` 里的
  `vendor/utmt` 从 `asarUnpack`/`files` 拿掉，让每台机器首启自取。
- UTMT CLI 与 `.csx` 脚本必须 `asarUnpack`（子进程与外部进程读取进不了 asar）；
  server 对这几条路径做 `app.asar → app.asar.unpacked` 改写（`unpackedPath()`）。
- zip 目标不签名，一般无需联网；若卡在 winCodeSign/nsis 下载，设
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

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
python cli/svre.py render r_Osbrook out.png --vanilla      # 原版房间也只读渲染（同一条通道）
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
| 绘制顺序 | 默认**游戏顺序**：模拟运行时 depth（`depth=-y` 代码的对象按它排，其余按图层 depth，同深度平局按创建顺序 game_objects）——画布即游戏内真实遮挡。顶栏「顺序」按钮可切到**静态视图**（UTMT 规则：图层 depth 定层间先后，层内按实例数组顺序），用于对账原始数据。无论哪种视图，**选中的实例始终置顶**（摆放工具永远不能藏住正在摆的东西，比如房子后的窗灯），取消选择即回到真实顺序 |
| 画不画 | 对象 `visible`（或 Create 覆盖）且图层 `is_visible`；**Draw 只画悬停高亮的对象（门、梯子、炉灶）静止时什么也不画**，图烘焙在墙 sprite 里 |
| 烙进背景的贴花 | `scr_bgRenderAdd` 的对象按普通实例画在自己的图层位置（同 UTMT），检查器里标注其运行时去向（135 或 125 的烘焙 surface） |

`create.json` 是 `extract/scan-create.mjs` 对反编译源码的静态扫描：沿父链重放
`event_inherited()`，只认覆盖九成五场景的几种写法；认不出的标未知、回退图层深度、
检查器写明，不猜。Step_0 同法：每帧重写 depth 的以 Step 为准（门族 `-y - start_depth`）。
这些深度事实驱动默认的「游戏顺序」画布，也进检查器（属性页与图层徽标）；对带深度代码
的对象调序改变不了游戏画面，编辑器会弹 toast 明说（只改静态视图与创建顺序）。房间 CC
里改的 `start_depth` 还没读，留给 P3。

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
  `POST /api/mod-assets/import-sprite`（注册新 sprite：写 PNG + 扩 assets.json + 广播
  `assets` 事件，与「导入 sprite」对话框同一通道）、`GET /mod-assets/pages/<i>.png`（no-store）。
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
