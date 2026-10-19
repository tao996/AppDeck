# Flutter Launcher —— 方案决策与架构设计 v2

> **定位：设计推导文档。** 本文记录「为什么这样定」，包含源码证据与决策权衡。
> **权威规格与验收标准已合并进 `readme_md_for_ai_agents.md`（v2）**——实现时以那份为准，本文用于理解依据。

> 上一版：`PROJECT_ANALYSIS.md`（需求与实现评估）
> 本版基于四项决策重做技术方案。**本文件不包含代码，仅设计与分析。**
> 基线：本机 Flutter 3.47.1 源码 + 实机探针（`flutter daemon` 已跑通）

---

## 0. 本轮四项决策

| # | 决策 | 影响面 |
|---|---|---|
| D-1 | **技术栈 = Tauri** | 前端 WebView2 + xterm.js；后端 Rust 管进程/PTY |
| D-2 | 设备/模拟器走 **daemon `device.*` / `emulator.*`**（采纳最佳建议） | 放弃 `flutter devices --machine` 轮询 |
| D-3 | 数据模型改 **`kind`** 并补齐 launch.json 真实字段（采纳最佳建议） | 导入/导出不再损坏 |
| D-4 | **同一项目多 tab，每条命令开一个终端执行** | ⚠️ **推翻原协议的 `--machine` 路线**（见 §1） |

另加需求：**允许用户配置项目的 flutter 可执行文件（`flutter.exe` / `flutter.bat` / FVM）**（见 §4）。

---

## 1. 关键转折：终端模式与 `--machine` 不可兼得

### 1.1 事实：管道 ≠ 终端，Flutter 会据此降级

源码（`base/io.dart:261-294`）：

```dart
bool get hasTerminal => io.stdout.hasTerminal;
bool get stdinHasTerminal { ... if (!ioStdin.hasTerminal) return false; ... }
bool get supportsAnsiEscapes => hasTerminal && stdout.supportsAnsiEscapes;
```

且 `terminal.dart:389` 有 `if (!usesTerminalUi)` 守卫；`run.dart:894` 只在**非 `--machine`** 分支设置 `globals.terminal.usesTerminalUi = true;`。

**推论**：若用普通管道（pipe）接 stdout，`hasTerminal == false` →
- 没有 ANSI 颜色；
- 没有 spinner / 进度重绘；
- 没有交互键位提示。

要"真的开一个终端"，**必须用伪终端（Windows = ConPTY）**，管道做不到。

### 1.2 两种模式是互斥的

| | `--machine` 模式 | 终端模式（非 `--machine`） |
|---|---|---|
| stdout | 每行一个 JSON 数组（`daemon.dart:221`） | 人类可读 + ANSI |
| stdin | 只接受 JSON 命令 | 单字符按键 `r`/`R`/`q`/`d`/`h`… |
| 热重载 | `{"method":"app.restart","fullRestart":false}` | 写入字节 `r` |
| 状态 | `app.start`/`app.started`/`app.stop` 事件 | 只能解析文本 |
| DevTools | `app.devTools` 事件给现成 URI | 正则抓 stdout 文本 |
| 终端观感 | ❌ 全是 JSON，没法看 | ✅ 原生 |

D-4 要求"开一个终端"，而 `--machine` 的 stdout 是 JSON —— **两者不能同时满足**。若把 `--machine` 的 JSON 塞进终端，得到的是一个刷 JSON 的终端，等于没有终端。

### 1.3 结论：放弃 `--machine`，走 ConPTY + 终端模式

**这是对原规格 §4.B 的重大修正。** 原规格一方面要求 `--machine`，一方面又要求"转发 `r`/`R`/`q`"和"ANSI 渲染"——这三者本就自相矛盾。D-4 把天平压向了终端侧。

### 1.4 诚实修正：此前几条结论随之反转

| 原结论 | v2 状态 |
|---|---|
| R5「`r`/`R`/`q` 在 `--machine` 下失效 ❌」 | **反转**：终端模式下它们**重新有效**，正是正确做法 |
| R6「DevTools 应取 `app.devTools` 事件」 | **不再适用**：改为正则解析 stdout（见 §3.3） |
| 「`app.restart`/`app.stop` 协议已核实无误」 | 事实仍成立，但**本方案不再使用**；保留为可选"结构化模式"（§10-Q2） |
| §3.C「ANSI stripping/rendering」 | **升级**：xterm.js 原生渲染，无需剥离 |

**代价**（必须承认）：失去结构化事件，改为文本状态机，脆弱性上升。缓解见 §3.1。

---

## 2. 终端实现（Tauri / Rust）

- **每个 tab = 一个 ConPTY 会话**，不是管道。
- Windows 10 1809+ 才有 ConPTY；本机 `10.0.19045` ✅。
- Rust 侧选型：`portable-pty`（wezterm 出品，`crates.io` 可直取，封装 ConPTY）。
- 数据流：
  ```
  ConPTY master ──read──▶ 前端事件(增量字节) ──▶ xterm.js.write()
  xterm.js.onData ──▶ 前端 invoke ──▶ PTY master write ──▶ 子进程 stdin
  ```
- **进程树**：tab 关闭/停止时，仅杀 PTY 子进程会留下 dart / gradle / adb 孤儿。
  → Rust 用 **Job Object**（`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `AssignProcessToJobObject`）兜底，保证整棵树一起死。
- **编码**：ConPTY 输出按 UTF-8 解码（本机 codepage 936，但 Flutter 输出 UTF-8）。xterm.js 侧亦按 UTF-8。
- **退出码**：PTY 子进程退出码 → tab 置 🔴，并保留退出码用于 UI 展示。

---

## 3. 文本状态机（替代 `--machine` 事件）

### 3.1 解析锚点（源码级确认的稳定字符串）

`resident_runner.dart`：

| 行 | 输出 | 用途 |
|---|---|---|
| 1397 | `// Caution: This log line is parsed by device lab tests.` | ✅ **Flutter 自己承诺该行可解析** → 事实上的稳定契约 |
| 1398-1401 | `A Dart VM Service on {deviceName} is available at: {httpAddress}` | 拿到 VM Service HTTP 地址 |
| 1407 | `The Dart Tooling Daemon is available at: {dtdUri}` | DTD |
| 1423-1426 | `The Flutter DevTools debugger and profiler on {deviceName} is available at: {urlToDisplayString(devToolsUri)}` | **DevTools 按钮目标** |
| 1434 | `Flutter run key commands.` | **应用已就绪的信号** |

> 注意 1413-1421 的 `urlToDisplayString`：打印的是**未编码**查询串（形如 `http://127.0.0.1:PORT?uri=ws://…`），不是 URI 编码形式，正则要按行尾贪婪到换行。

### 3.2 状态判定规则

| 状态 | 判定 |
|---|---|
| 🟡 Starting | 进程已起，尚未出现 `Flutter run key commands.` |
| 🟢 Running | 命中 `Flutter run key commands.`（或 VM Service 行） |
| 🔴 Stopped | PTY 进程退出（带退出码），或出现 `Application finished.` |

按"最后一个匹配优先"实现，并对同一会话缓存已命中的标志位，避免重复解析开销。

### 3.3 按钮映射

| 按钮 | 动作 | 前置条件 |
|---|---|---|
| ⚡ Hot Reload | 向 PTY 写 `r` | 已 🟢 且模式 = debug |
| 🔄 Hot Restart | 向 PTY 写 `R` | 已 🟢 且模式 = debug |
| ⏹ Stop | 向 PTY 写 `q`；超时（如 5s）未退则 Job Object 强杀 | 会话存在 |
| 🌐 DevTools | 从 §3.1 第 4 行抓取 URI → 系统浏览器打开 | 已抓到 URI |

**模式约束**：`flutterMode: release`/`profile` 下 `r`/`R` 无效（`printHelp` 中 `canHotReload`/`supportsRestart` 守卫）。→ 按命令的 `flutterMode` 直接禁用这两个按钮，而非运行时猜测。

---

## 4. Flutter 可执行文件配置（`.exe` / `.bat` / FVM）

### 4.1 配置模型

```jsonc
{
  "flutterTool": {
    "mode": "auto" | "custom" | "fvm",   // 默认 auto
    "customPath": "D:\\apps\\flutter\\bin\\flutter.bat",  // mode=custom 时
    "fvmVersion": "3.32.5"                              // 可空；空则读项目 .fvmrc
  }
}
```
优先级：**项目级覆盖 > 全局默认 > auto**。

### 4.2 解析优先级（auto 模式）

1. 项目 `.fvmrc` 或 `.fvm/fvm_config.json` 存在 → 走 FVM（见 4.3）
2. PATH 中的 `flutter` → 本机解析为 `flutter.bat`
3. 平台默认路径兜底
4. 全失败 → 项目节点标红，提示"请配置 Flutter 路径"

### 4.3 FVM 解析（基于本机真实数据）

实测 `.fvmrc`（`D:\demo\code\huawei\hm-library\packages\tao996_demo\.fvmrc`）：

```json
{
  "flutter": "harmony",
  "env": {
    "FLUTTER_STORAGE_BASE_URL": "https://flutter-ohos.obs.cn-south-1.myhuaweicloud.com",
    "PUB_CACHE": "D:\\mydata\\pub_cache"
  }
}
```

**两个非显然要点：**

1. **`flutter` 字段不一定是版本号**。上例是 `"harmony"` —— 一个 **HarmonyOS 分支的定制名**，不是 semver。**严禁用 `^\d+\.\d+` 校验**，否则这类合法配置会被判为非法。
2. **`env` 必须透传给子进程**。上例的 `FLUTTER_STORAGE_BASE_URL` 指向华为镜像；不透传 → 引擎产物拉取失败。这是"只读取版本、忽略 env"的典型踩坑。

**推荐做法**（最稳，且避免依赖 fvm CLI）：

- 直接解析 **`<project>/.fvm/flutter_sdk`** —— 实测它是指向实际 SDK 的 junction/symlink：
  ```
  Target: D:\mydata\scoop\apps\fvm\current\versions\harmony
  <project>\.fvm\flutter_sdk\bin\flutter.bat   ✅ 存在
  ```
- 拿到真实 SDK 后，可执行文件即 `<sdk>\bin\flutter.bat`。
- 若 `.fvm/flutter_sdk` 不存在（尚未 `fvm use`）→ 调 `fvm use` / 提示用户，或回退 `fvm flutter`。
- `fvm` 纯 shim 方式（`fvm flutter ...`）作为**降级路径**：多一层进程、启动更慢、错误更难归因。

> 本机 FVM 4.3.1 已装；FVM 缓存位于 `D:\mydata\scoop\apps\fvm\current\versions\`（注意**不在** `~/fvm`，不要硬编码默认缓存路径）。

### 4.4 Windows 调用 `.bat` 的正确姿势

Windows 的 `CreateProcess` **无法直接执行 `.bat`/`.cmd`**。本机只有 `flutter.bat`（无 `flutter.exe`）：

```
D:\apps\flutter\bin\  →  flutter, flutter.bat, dart, dart.bat
```

**做法**：在 ConPTY 里启动 `cmd.exe /d /s /c ""<flutter.bat 绝对路径>" <args>"`。
- `/d` 跳过 AutoRun（防用户注册表注入干扰），`/s` 让引号处理可预期。
- 路径含空格（如 `C:\Program Files\...`）时，`/s` + 最外层包一层引号是唯一稳妥写法。
- **参数务必按数组传递并逐个转义**，不做字符串拼接（R12 命令注入）。

### 4.5 可选快路径：绕过 `.bat` 直调 snapshot

`flutter.bat` 最终执行（`flutter.bat:74`）：

```
"%dart%" --packages="%flutter_tools_dir%\.dart_tool\package_config.json" %FLUTTER_TOOL_ARGS% "%snapshot_path%" %*
```

即 `dart.exe --packages=... flutter_tools.snapshot <args>`（两者实测均存在）。

**收益**：绕开 cmd 引号地狱，启动更快。
**风险**：跳过 `shared.bat` 的"snapshot 过期则重建"逻辑与 git/PowerShell 检查；`flutter upgrade` 后可能用到旧 snapshot。
**建议**：**默认走 `.bat`**（语义正确、与用户预期一致）；直调仅作为"启动性能优化"高级开关，并附版本校验。

### 4.6 校验与体检（必须做，否则错误归因全错）

`flutter.bat` 的前置条件（源码 19-52 行）：

| 前置 | 缺失时的行为 | 本机 |
|---|---|---|
| PATH 有 `git` | `Error: Unable to find git in your PATH.` exit 1 | ✅ |
| PATH 有 `pwsh` 或 `PowerShell.exe` | `Error: PowerShell executable not found.` exit 1 | ✅ |
| `%FLUTTER_ROOT%\.git` 存在 | `Error: The Flutter directory is not a clone…` exit 1 | ✅ |

**设计**：保存配置时执行一次 `<exe> --version`，解析 `Flutter 3.47.1 • channel stable • … • Dart 3.13.1`，缓存并展示；失败则原样呈现 stderr（用户看到的是 Flutter 自己的报错，而不是启动器的"未知错误"）。

---

## 5. 设备与模拟器（D-2 落地，已实机验证）

### 5.1 方案：常驻一个 `flutter daemon` 进程

实测（本机，协议版本 `0.6.1`）：

```
→ [{"id":"1","method":"device.getDevices"}]
← [{"event":"daemon.connected","params":{"version":"0.6.1","pid":26828}}]
← [{"event":"device.added","params":{"id":"windows",...,"category":"desktop","emulatorId":null,
     "capabilities":{"hotReload":true,"hotRestart":true,"fastStart":false,...}}}]
← [{"id":"1","result":[...]}]

→ [{"id":"e1","method":"emulator.getEmulators"}]
← [{"id":"e1","result":[{"id":"Pixel_5","name":"Pixel 5","category":"mobile","platformType":"android"}]}]
```

**关键收益**：
- `emulator.getEmulators` **真能列出未启动的 `Pixel_5`** —— 正是 R2 缺的能力。
- 字段比 `flutter devices --machine` **更丰富**：`category`、`platformType`、`emulatorId`、`ephemeral`、`isConnected`、`connectionInterface`、`capabilities.fastStart`。
- 设备热插拔有 `device.added` 事件，无需轮询。

### 5.2 生命周期

- **每个已配置 SDK 一个 daemon 进程**（不同 Flutter 版本设备列表可能不同）。惰性启动，空闲 N 分钟后回收。
- 启动失败 → 降级为一次性 `flutter devices --machine`（已验证可用）。
- 模拟器启动：`emulator.launch`（`{emulatorId}`），启动完成后靠 `device.added` 事件点亮。
- 设备列表按 `category`/`platformType` 分组，正好对应原规格的设备菜单分组。

### 5.3 进程回收（M7 实测修正）

上面只说了"惰性启动、空闲回收"，**漏了应用退出时的回收**：
`Daemon` 只持有 `std::process::Child`，而 PTY 会话挂了 Job Object。
结果应用每退出一次就残留一个 `flutter daemon`，实测累积 **11 个孤儿**（父进程早已退出）。

修正：把 `JobGuard` 从 `pty` 模块提为 `pub(crate)`，daemon 复用同一个 Job。

| 进程 | 修复前 | 修复后 |
|---|---|---|
| `flutter run` 会话 | Job 回收 ✅ | 不变 |
| `flutter daemon` | 变孤儿 ❌ | Job 回收 ✅ |

关键点：Job 句柄随进程关闭，所以**强杀**（`TerminateProcess`）同样能回收子树，
不依赖 `Drop` 是否执行。验收：强杀应用后 `dart.exe ... daemon` 计数必须为 0。

---

## 6. 数据模型 v2（D-3 落地）

### 6.1 关键改动

| 原 | 新 | 原因 |
|---|---|---|
| `type: "run"\|"build"` | **`kind: "run"\|"build"`** | `type` 与 launch.json 的 `"dart"` 冲突，往返导出会损坏文件 |
| `target` | **`program`** | launch.json 真实字段名 |
| — | `env`, `flutterMode`, `toolArgs`, `deviceId`, `emulatorId`, `noDebug`, `vmAdditionalArgs`, `customTool` | 真实 schema 必备 |
| — | `schemaVersion` | 迁移需要 |

### 6.2 结构

```jsonc
{
  "schemaVersion": 2,
  "settings": { "flutterTool": { "mode": "auto", "customPath": null } },
  "projects": [{
    "id": "uuid", "name": "MyApp", "path": "D:\\proj\\my_app",
    "flutterTool": { "mode": "fvm" },          // 项目级覆盖
    "commands": [{
      "id": "cmd-1", "name": "Debug Dev",
      "kind": "run",                            // run | build
      "program": "lib/main_dev.dart",
      "flutterMode": "debug",                   // debug | profile | release
      "target": null,                           // 无，program 取代
      "args": ["--flavor","dev","--dart-define=ENV=dev"],
      "env": { "FOO": "bar" },
      "toolArgs": [],
      "deviceId": null, "emulatorId": null,
      "cwd": null, "noDebug": false
    }, {
      "id": "cmd-2", "name": "GooglePlayReleaseProd",
      "kind": "build", "buildType": "appbundle",  // apk|appbundle|web|windows|...
      "args": ["--flavor","prod","--release"]
    }]
  }]
}
```

### 6.3 导入规则

- 只接受 `type == "dart"` **且** `request == "launch"` 的配置；`attach` 单独标 `kind: "attach"`（v1.1）。
- `cwd` 相对 **launch.json 所在目录**解析，不是相对项目根。
- JSONC 用成熟解析器（`json5` / `strip-json-comments` + 去尾逗号），**不用正则**（`http://` 会被截断）。
- 构建目标不硬编码：从 daemon 或 `flutter build --help` 的 subcommand 列表动态取（本机无 `ipa`/`macos`）。

---

## 7. 并发策略（D-4 的直接后果）

### 7.1 用户意图 vs 技术约束

D-4 明确允许多 tab 并行。但 Flutter 的 `build/`、`.dart_tool/` 是**项目级单例**：

- 同项目、**同** target/flavor/mode 并发 → 内核产物路径相同（`flutter run` 的 dill 输出由构建配置哈希派生），存在写冲突风险。
- Android：Gradle 对 `.gradle`/`build` 有文件锁，第二个会**排队**（安全但慢），也可能报 "Another Gradle build is in progress"。
- 首次运行并发还会争 `pub get` 的 `package_config.json`。

### 7.2 建议：按"构建期"加锁，而非整会话加锁

```
per-project semaphore
  acquire  → 启动 flutter run（构建/安装阶段）
  release  → 命中 "Flutter run key commands."（应用已跑起来）
```

这样：
- **构建阶段串行** → 不损坏缓存；
- **运行/调试阶段并行** → 满足"多 tab 同时跑"；
- 排队时 tab 状态显示 🟡「等待构建锁…」，不静默卡住。

**加强项**：为每个会话分配独立 `--output-dill <tmp>/<session>.dill`（该 flag 在 `run.dart:877` 被读取），彻底隔离内核产物。

### 7.3 UI 提示

同项目已有一个 🟡 构建中时，再点第二个命令 → 明确提示"正在排队，等待当前构建完成"，而不是让用户面对一个没有输出的黑终端。

---

## 8. 修订后风险登记册

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| K1 | ConPTY 下 `r`/`R` 注入不稳定 | 中 | 高 | 早期做 spike 验证；失败降级为"重启会话" |
| K2 | 文本状态机被 Flutter 版本升级打断 | 中 | 中 | 锚点集中配置 + 契约测试 + 版本探测；依赖"device lab 解析行" |
| K3 | 同项目并发构建损坏缓存 | 中 | 高 | §7.2 构建期信号量 + `--output-dill` 隔离 |
| K4 | `.fvmrc` 的 `env` 未透传导致私有 fork 失败 | 中 | 高 | **强制透传 `env`**；不校验 `flutter` 字段格式 |
| K5 | `.bat` 引号/空格路径导致启动失败 | 中 | 中 | `cmd /d /s /c` + argv 数组 + 路径校验 |
| K6 | 中文日志乱码 | 低 | 中 | 全链路 UTF-8（已确认 Flutter 输出 UTF-8） |
| K7 | 关 tab 后 dart/gradle 残留 | 中 | 中 | Job Object |
| K8 | daemon 进程泄漏 | 中 | 低 | 惰性启动 + 空闲回收 + 退出时统一清理 |
| K9 | Android 许可证未接受 → 构建失败被误判 | 中 | 中 | 项目体检横幅 + 一键跳转指引 |
| K10 | ConPTY 仅 Win10 1809+ | 低 | 低 | 启动时探测，低版本明确报错 |

> 已消除：原 K1（技术栈摇摆）→ 已定 Tauri；原 R2（模拟器枚举）→ daemon 实测通过；原 R5/R6 → 随协议切换重定义。

---

## 9. 修订后工作量

| 里程碑 | 内容 | 估时（人日） |
|---|---|---|
| M0 | Tauri 骨架 + `FlutterLocator`（auto/custom/fvm + env 透传 + 体检） | 3–4 |
| M1 | 项目管理 + 树 + 持久化（schemaVersion） | 4–6 |
| M2 | **ConPTY 会话 + xterm.js 最简 + Job Object + UTF-8** | 7–9 |
| M3 | 设备/模拟器 daemon 客户端（惰性/回收/降级） | 3–4 |
| M4 | 控制按钮 + 文本状态机 + DevTools 提取 | 3–4 |
| M5 | 发布构建（目标探测 + 产物定位 + 系统通知） | 3–4 |
| M6 | launch.json 导入（JSONC + 字段映射 + 过滤） | 3–4 |
| M7 | 会话恢复（serialize）+ 深浅主题 + i18n + 打磨 | 4–5 |
| | **合计** | **30–40 人日** |

MVP（M0+M1+M2+M4+M6）≈ **20–27 人日**，闭环 = 配 Flutter → 加项目 → 导入命令 → 开终端跑 → 热重载 → 停。

> **v2.1 修订**：D-9 将 v1 终端范围冻结为「最简」（不做搜索/高亮/日志落盘/同步输入/分屏/时间戳/快捷命令栏/主题体系），因此 M2 由 8–10 降至 7–9，M7 由 4–6 降至 4–5，合计由 31–42 降至 **30–40**。省下的主要是**分屏**（架构从"1 tab = 1 会话"变为"布局树"）与特性 addon 的集成成本。

---

## 10. 待确认问题

| # | 问题 | 为什么重要 |
|---|---|---|
| **Q1** | "打开一个终端" = **应用内嵌终端 tab**，还是**弹出外部终端窗口**（Windows Terminal / cmd）？ | 若是外部窗口，启动器**无法**注入 `r`、无法读日志、无法点亮状态灯——原规格的按钮与 🟢🟡🔴 全部失效。**本方案按内嵌 ConPTY 设计**，请确认 |
| Q2 | 是否保留 `--machine` 作为"结构化模式"可选开关？ | 保留=多一条代码路径与维护成本；不保留=状态靠文本解析 |
| Q3 | FVM 的 `env` 透传范围（如 `FLUTTER_STORAGE_BASE_URL`、`PUB_CACHE`）是否也需全局配置？ | HarmonyOS 等私有 fork 强依赖 |
| Q4 | 同项目同 flavor 并发：**硬性阻止** 还是**排队+提示**？ | 影响 §7.2 交互设计 |
| Q5 | `flutter build` 的产物路径：仅展示，还是要"打开目录/复制路径"？ | 小功能但要定 |

---

## 11. 小结

1. D-4（每命令一个终端）**不是 UI 细节，而是协议级决策**：它排除 `--machine`，把方案从"JSON 事件驱动"切换为"ConPTY + 文本状态机"。
2. 这个切换**利大于弊**：终端观感真实、ANSI 完整、`r`/`R`/`q` 重新合法、少一层私有协议依赖；代价是状态判定从"确定"变"启发式"，用集中锚点 + 契约测试兜住。
3. D-2 已**实机验证**：`emulator.getEmulators` 正确返回未启动的 `Pixel_5`，且字段比 `flutter devices` 更丰富——原 R2 的坑确实填掉了。
4. "配置 flutter.exe/.bat/fvm"有两个隐藏雷：`.fvmrc` 的 `flutter` 字段可能是**定制分支名**而非版本号；其 `env` 块**必须透传**（实测 isolate 到华为镜像）。另外本机无 `flutter.exe`，`.bat` 必须经 `cmd /c`。
5. 剩一个**根本性歧义 Q1**（内嵌 vs 外部终端）需要你确认——它决定按钮和状态灯是否存在，请在开工前给个结论。
