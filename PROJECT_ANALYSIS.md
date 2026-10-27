# AppDeck —— 需求分析与实现评估（v1，历史文档）

> **状态：已被取代。** 本文是 2026-10-19 的一次性评估快照，用于记录 v1 规格的缺陷与协议核对过程。
> **权威规格请以 `readme_md_for_ai_agents.md`（v2）为准。**

> 评估对象：`readme_md_for_ai_agents.md`（v1）
> 评估时间：2026-10-19
> 评估基线：本机实测环境 + 本机 Flutter SDK 3.47.1 源码（一手证据）

## ⚠️ 阅读须知：以下结论已在 v2 中被推翻

后续决策（D-1 锁定 Tauri、D-4 每条命令开一个终端）导致技术路线变更，本文部分结论**不再成立**：

| 本文结论 | v2 后的实际状态 |
|---|---|
| R5「`r`/`R`/`q` 在 `--machine` 下失效」 | **反转**。v2 放弃 `--machine`，改用 ConPTY 终端，`r`/`R`/`q` 重新成为正确机制 |
| R6「DevTools 应取 `app.devTools` 事件」 | **不再适用**。改为从终端输出正则解析 |
| §4「`app.restart`/`app.stop` 协议核实无误」 | 事实仍成立，但 **v2 不再使用该协议** |
| 「ANSI 需剥离或渲染」 | **升级**为 xterm.js 原生渲染，无需剥离 |
| R1「技术栈未决」 | **已决**：Tauri |

仍然有效并被 v2 吸收的：R2（模拟器枚举）、R3（构建目标平台差异）、R4（数据模型字段）、R7（release 模式无热重载）、R8（并发构建）、R9（非功能需求）、R10（JSONC）、R11（launch.json 过滤）、R12（注入风险）。

---

## 一、项目现状：实现度 = 0%

工作目录 `D:\demo\code\tauri\FlutterMiniAppLauncher` 实测内容：

| 项 | 实测结果 |
|---|---|
| 文件总数 | **1** |
| 内容 | 仅 `readme_md_for_ai_agents.md`（7,194 字节） |
| 子目录 | 0 |
| Git 仓库 | 否（`fatal: not a git repository`） |
| 可执行代码行数 | **0** |

**结论：目前只有规格文档，没有任何实现。** 因此"实现评估"实质上退化为两件事：
1. 评估**规格本身**是否自洽、可落地（第二章、第四章）；
2. 评估**本机环境**能否支撑规格所述能力（第五章）。

---

## 二、需求分解

从文档提取出 8 个功能域、约 34 条可验收需求：

| 域 | 需求 | 出处 |
|---|---|---|
| D1 项目管理 | 目录选择、`pubspec.yaml` 校验、项目增删改、名称/路径持久化 | §3.A, §5 |
| D2 配置导入 | 解析 `.vscode/launch.json`（JSONC）、转换为内部命令模型 | §3.A, §6.3 |
| D3 项目树 | 项目→命令两级树、命令右键菜单、新增命令 | §3.B |
| D4 设备管理 | 设备枚举、模拟器枚举与启动、设备分组、按设备启动 | §3.B, §4.A |
| D5 会话/进程 | 多标签、每标签独立进程、标签命名 `{项目}:{命令} ({设备})` | §3.C |
| D6 进程控制 | 热重载、热重启、停止、DevTools | §3.C, §4.B |
| D7 日志 | stdout/stderr 实时流、自动滚动、ANSI 处理 | §3.C, §6.4 |
| D8 发布构建 | 多目标构建、flavor、日志捕获、非交互 | §3.B, §4.C |
| D9 状态 | 🟢/🟡/🔴 三态指示 | §3.C |

非功能性需求在原文中**几乎缺失**（仅 §6.2 提到状态管理），见 §4.9。

---

## 三、需求缺陷清单（阻断级 → 建议级）

### 🔴 R1 技术栈未决（最大阻断项）

原文自相矛盾：

- §1：「using **Flutter Desktop or Tauri**」——二选一未定。
- §6.1：「If asked to build a prototype/single-file app, implement using **Flutter Desktop**」。
- §6.2：「Use `ChangeNotifier` / `Provider` or `Riverpod`」——仅 Flutter 适用。
- §6.4：「use a terminal emulator widget (e.g., **xterm.dart**)」——仅 Flutter 适用。

即：**正文说"二选一"，附录却全按 Flutter 写**。而工作目录位于 `D:\demo\code\tauri\` 下，命名暗示 Tauri。

这是**必须在写第一行代码前拍板**的决策，因为两条路的 UI 层、进程控制层、打包链路完全不同（见 §6.1）。

### 🔴 R2 设备/模拟器检测机制与 Flutter 实际行为不符

原文 §3.B：「Triggers dynamic `flutter devices --machine` scan → Displays device context menu (Android Emulator, iOS Simulator, macOS Desktop, Chrome, Physical Devices)」。

**实测反证（本机）：**

```
flutter devices --machine   →  仅返回 3 项：windows / chrome / edge
```

而本机**确实存在**一个 Android 模拟器 `Pixel_5`（已建 AVD），但它**没有出现在 `flutter devices` 输出里**——因为 AVD 未启动。`flutter devices` 只报"当前可用设备"，不报"可启动的模拟器"。

更关键：原文隐含的 `flutter emulators --machine` **根本不存在**：

```
$ flutter emulators --machine
The "--machine" flag is only valid with the "--version" flag or the "analyze --suggestions" command.
```

`flutter emulators` 只有人类可读的表格输出（`Id • Name • Manufacturer • Platform`），格式脆弱。

**正确做法**：走常驻 daemon 的 `emulator.getEmulators` / `emulator.launch`（`commands/daemon.dart:1612-1614`），而不是解析 CLI 文本。

同时 §3.B 列出的 "iOS Simulator / macOS Desktop" 在 Windows 上**不可能存在**（见 R3）。

### 🔴 R3 构建目标硬编码，跨平台不可行

原文 §4.C：`flutter build <apk|appbundle|ipa|macos|windows>`。

**实测本机支持范围：**

```
$ flutter build --help
Available subcommands: aar, apk, appbundle, bundle, web, windows
```

**没有 `ipa`，没有 `macos`。** 二者仅在 macOS 宿主上注册。若启动器硬编码 5 个目标，Windows 上必有 2 个永久失败。

**修正**：构建目标必须**运行时探测**（解析 `flutter build --help` 的 subcommand 列表，或按宿主平台能力表裁剪），并与设备 `targetPlatform` 联动。

### 🟠 R4 数据模型与 `launch.json` 真实 schema 不兼容

原文 §5 的命令模型字段：`name / type / target / args / buildType`。

**实测 Dart-Code 扩展 v3.144.0 的真实 schema（21 个属性，一手证据）**：

| 真实字段 | 有无 | 说明 |
|---|---|---|
| `program` | ❌ 原文写成 `target` | Flutter 里是 `program`（如 `lib/main.dart`） |
| `name` | ✅ | |
| `request` | ✅ 原文有 | `launch` / `attach` |
| `type` | ⚠️ **语义冲突** | 真实值恒为 `"dart"`；原文用它表示 `"run"`/`"build"` |
| `cwd` | ✅ | |
| `args` | ✅ | |
| `env` | ❌ 缺失 | 环境变量 |
| `flutterMode` | ❌ 缺失 | `debug` / `profile` / `release` |
| `toolArgs` | ❌ 缺失 | 传给 `flutter` 工具本身的参数 |
| `deviceId` | ❌ 缺失 | |
| `emulatorId` | ❌ 缺失 | **未运行则自动启动**（可直接解决 R2） |
| `noDebug` | ❌ 缺失 | |
| `vmAdditionalArgs` | ❌ 缺失 | |
| `customTool` / `customToolReplacesArgs` | ❌ 缺失 | **FVM 用户必需**（指定 flutter 可执行文件） |
| `flutterPlatform` / `openDevTools` / `console` / `enableAsserts` / `codeLens` / `templateFor` / `runTestsOnDevice` / `debuggerType` / `suppressWebServerDeviceBrowserLaunch` | ❌ 缺失 | 低优先级 |

**两个具体 bug：**
- **字段名映射错误**：`target` ↔ `program`，导入时必然读不到目标文件。
- **`type` 语义冲突**：同一字段在 launch.json 里是 `"dart"`，在内部模型里是 `"run"`/`"build"`。若做导入→导出往返，会把 `"dart"` 覆盖成 `"run"`，产出损坏的 launch.json。建议内部模型改名为 `kind`。

### 🟠 R5 热重载的字符键通道在 `--machine` 下失效

原文 §3.C：「`⚡ Hot Reload` (sends `r` **or** JSON-RPC restart event)」。

**源码证据**：`--machine` 模式下 stdin 已被 daemon 的 JSON 解析器**独占**（`Daemon.createMachineDaemon()` → `DaemonStreams.fromStdio`，`commands/daemon.dart`）。发送裸字符 `r` / `R` / `q` 会因 JSON 解析失败而被丢弃。

**结论**：`r` 分支是错的，必须**只**走 JSON。这也意味着"Stop 发送 `q`"同样无效。

### 🟠 R6 DevTools 打开方式错误

原文 §3.C：「`🌐 DevTools` (opens **VM Service URI** in web browser)」。

**源码证据**：daemon 直接下发了一个现成的 DevTools URL：

```dart
// commands/daemon.dart:807-809
if (info.devToolsUri != null) {
  _sendAppEvent(app, 'devTools', {'uri': info.devToolsUri!.toString()});
}
```

**修正**：监听 `app.devTools` 事件取 `params.uri` 直接 `open`。打开 VM Service URI（`ws://…/ws`）在浏览器里不会得到 DevTools 界面。

### 🟠 R7 release / profile 模式下没有热重载，但 UI 无禁用逻辑

原文给**每个** tab 都配了 ⚡/🔄 按钮，未区分模式。而 `flutterMode: release` 是合法配置（见 R4），release/profile 下热重载不可用。

**现成解**：`app.start` 事件已带 `supportsRestart` 布尔量：

```dart
// commands/daemon.dart:785-791
_sendAppEvent(app, 'start', {
  'deviceId': device.id,
  'directory': projectDirectory,
  'supportsRestart': isRestartSupported(enableHotReload, device),
  'launchMode': launchMode.toString(),
  'mode': runner.debuggingOptions.buildInfo.modeName,
});
```

用 `supportsRestart` 直接驱动按钮 enable/disable 即可，无需自行推断。

### 🟠 R8 并发会话与 Flutter 单构建目录冲突（原文完全未提）

原文允许多标签并行跑**同一项目**的多个命令。但 Flutter 的 `build/` 与 `.dart_tool/` 是**项目级单例**；同时跑两个 `flutter run`（尤其不同 flavor / target）会争抢该目录，导致构建错乱、增量缓存损坏或随机失败。

**必须补需求**：按 `project.path` 加**构建互斥锁**（同项目串行、不同项目并行），并在 UI 上明确提示"该项目已有构建在进行"。

### 🟡 R9 非功能性需求缺失

原文完全没写、但会直接影响验收的项：

| 缺失项 | 为什么必须有 |
|---|---|
| Flutter SDK 定位 | **本机没有 `flutter.exe`**，只有 `flutter.bat`（见 §5.2） |
| 进程树终止 | `flutter run` 会派生 dart/gradle/adb 子进程；只 kill 父进程会留孤儿 |
| 日志导出/搜索/过滤 | 长构建日志无搜索基本不可用 |
| 会话恢复 | 崩溃后所有 tab 丢失 |
| 构建产物路径展示 | 用户跑完 release build 找不到 APK |
| `pub get` / `flutter clean` | 首次克隆项目必失败 |
| 错误分级与通知 | 构建 5 分钟失败，用户可能已切走 |
| 编码处理 | 本机 codepage 936，Flutter 输出 UTF-8（见 §5.3） |
| i18n | 目标用户中文 |
| 超时/取消 | 卡死的 `flutter run` |

### 🟡 R10 JSONC 正则去注释方案脆弱

原文 §6.3：「using regex pre-processing to strip `//` and `/* */` comments」。

**反例**：`"args": ["--dart-define=HOST=http://api.example.com"]` —— 朴素正则会截断 `//api.example.com`。launch.json 还普遍带**尾随逗号**。

**修正**：用成熟 JSONC 解析器（`json5` / `strip-json-comments` + 去尾逗号），不要手写正则。

### 🟡 R11 launch.json 内容过滤缺失

一个 `.vscode/launch.json` 常含多种 `type`（`node`、`pwa-chrome`、`dart`）。原文未要求按 `type == "dart"` 且 `request == "launch"` 过滤，直接全量导入会产出无法执行的命令。还需处理 `cwd` 相对 `launch.json` 的解析、以及 monorepo 多根工作区。

### 🟡 R12 命令注入风险

`args` / `toolArgs` 来自项目文件，最终拼成命令行。若走 shell 字符串拼接，恶意或手误的 `"; rm -rf"` 会被执行。

**要求**：**全链路 `argv` 数组**，禁止 shell 拼接；Windows 上 `flutter.bat` 需显式 `cmd.exe /c`，此时更要严格转义。

---

## 四、协议符合性核对（原文主张 vs 一手源码证据）

| # | 原文主张 | 结论 | 证据 / 修正 |
|---|---|---|---|
| 1 | `flutter run --machine` 启动 | ✅ **成立** | `run.dart:472`；但 `--machine` 是**隐藏参数**（`flutter_command.dart:1317`，`hide: !verboseHelp`），`flutter run --help` 里看不到，需 `-v --help` |
| 2 | stdout 为逐行 JSON | ✅ **成立** | `src/daemon.dart:221`：`utf8.encode('[${json.encode(message)}]\n')` —— **每行一个 JSON 数组**，UTF-8 |
| 3 | `[{"method":"app.restart","params":{"appId":…,"fullRestart":false}}]` | ✅ **成立** | `commands/daemon.dart:647` 注册 `restart`；`:862-889` 读取 `appId`/`fullRestart`/`pause`/`reason`/`debounce`。`fullRestart:false`=热重载，`true`=热重启，与原文一致 |
| 4 | `[{"method":"app.stop","params":{"appId":…}}]` | ✅ **成立** | `commands/daemon.dart:649`、`:955-972` |
| 5 | stdin 也接受裸字符 `r`/`R`/`q` | ❌ **不成立** | `--machine` 下 stdin 由 `DaemonConnection` JSON 解析器独占，裸字符被丢弃 |
| 6 | DevTools = 打开 VM Service URI | ❌ **不成立** | 应取 `app.devTools` 事件的 `params.uri`（`commands/daemon.dart:807-809`） |
| 7 | `flutter devices --machine` | ✅ **成立** | 实测字段齐全：`id`/`name`/`isSupported`/`targetPlatform`/`emulator`/`sdk`/`capabilities{hotReload,hotRestart,…}` |
| 8 | 设备菜单含 Android 模拟器 / iOS 模拟器 / macOS 桌面 | ⚠️ **部分错误** | 未启动的 AVD 不出现在 `devices`；`flutter emulators --machine` **不存在**；应用 `emulator.getEmulators` / `emulator.launch`；Windows 上不可能有 iOS/macOS 项 |
| 9 | `flutter build apk\|appbundle\|ipa\|macos\|windows` | ⚠️ **平台相关** | 本机实测仅 `aar/apk/appbundle/bundle/web/windows`；`ipa`/`macos` 仅 macOS 宿主可用 |
| 10 | 构建可 `--machine` | ➖ **不存在** | `addMachineOutputFlag` 仅出现在 `analyze/attach/config/devices/run/test/widget_preview`，`build` 无此能力。构建日志只能按纯文本 + ANSI 处理 |
| 11 | `--flavor` 适用于全部目标 | ⚠️ **部分** | 实测 `apk`/`appbundle`/`windows` 支持 `--flavor`；`web` **不支持**（仅有 `--release`/`--dart-define-from-file`） |
| 12 | 命令模型字段 `target` | ❌ **字段名错** | 真实 launch.json 用 `program` |
| 13 | `-d all` 可用 | ❌ **被禁** | `run.dart:852-855`：`--machine` 下 `devices!.length > 1` 直接 `throwToolExit('"--machine" does not support "-d all".')` |

**完成度评价**：13 条主张中，**5 条完全正确**（1/2/3/4/7），**1 条不存在**（10），**7 条有误或需修正**。协议层的核心骨架是对的（daemon JSON 双向通道），但**周边集成细节错误率偏高**，若照原文字面实现，热重载的字符键分支、DevTools 按钮、模拟器菜单、构建目标四项会直接失败。

---

## 五、本机环境支撑度（实测）

### 5.1 总体：✅ 可支撑

| 能力 | 实测 | 结论 |
|---|---|---|
| Flutter SDK | 3.47.1 stable / Dart 3.13.1 | ✅ |
| Windows 桌面构建 | VS Community 2026 18.9.2 + SDK 10.0.26100.0 | ✅ |
| `enable-windows-desktop` | `true` | ✅ |
| Android SDK / adb | SDK 37.0.0 / adb 1.0.41 (37.0.0) | ✅ |
| Android 模拟器 | AVD `Pixel_5` 存在（未运行） | ✅ |
| Chrome / Edge | 154 / 155 | ✅ |
| DevTools | 2.60.0 | ✅ |
| Rust（若选 Tauri） | 1.96.1 msvc + WebView2 155 | ✅ |
| 网络 | npmjs / crates.io 均 200 | ✅ |

### 5.2 ⚠️ 本机无 `flutter.exe`，只有 `flutter.bat`

```
D:\apps\flutter\bin\  →  flutter(2385B)  flutter.bat(3080B)  dart  dart.bat  …
```

Rust/Go 等非 shell 进程**无法直接 CreateProcess 一个 `.bat`**（Windows 限制），必须 `cmd.exe /c flutter.bat …`，或用 FVM/`dart` snapshot 直调。

若选 Tauri，这是**必踩**的坑，必须封装统一的 `flutterExecutable` 解析层（支持 `customTool`/FVM，见 R4）。若选 Flutter Desktop，`dart:io` 的 `Process.start` 同样受此限制。

### 5.3 ⚠️ 控制台编码 GBK(936) vs Flutter 输出 UTF-8

```
chcp → 936     locale → zh-CN
```

而 `flutter devices --machine` 输出的是 UTF-8（实测 `"sdk": "Microsoft Windows [版本 10.0.19045.3803]"` 可正确解码）。**子进程 stdout 必须显式按 UTF-8 解码**，否则中文日志必然乱码。

### 5.4 ⚠️ 长路径未启用

`LongPathsEnabled = 0`。本项目要处理用户任意路径的项目 + 深层 `build/`，建议开启。

### 5.5 ⚠️ Android 许可证未完全接受

`flutter doctor` 报 `Some Android licenses not accepted`。会导致目标项目 `flutter build apk` 失败——**不是启动器本身的问题，但会让用户以为启动器坏了**，需在 UI 里做前置体检并给出修复指引。

### 5.6 ✅ 环境已验证可跑真实 Tauri v2 应用

上一轮已实测：脚手架 → `cargo build` 97 秒 → `app.exe` 13.5 MB → 启动并拉起 `msedgewebview2.exe`。若选 Tauri，底层无阻塞。

---

## 六、实现建议

### 6.1 技术栈决策（先拍板）

| 维度 | Tauri (Rust + Web) | Flutter Desktop |
|---|---|---|
| 二进制体积 | ~5-10 MB | ~40-60 MB |
| 终端渲染 | **xterm.js（成熟、ANSI/256色/搜索齐全）** | xterm.dart（可用，成熟度略低） |
| 进程控制 | Rust `std::process` + Job Object（进程树控制最稳） | `Process.start` + 需自行处理进程树 |
| UI 信息密度（WindTerm 风） | Web 布局灵活，适合高密度 | 原生 widget，也够用 |
| 状态管理 | 任意（Solid/React/Vue） | Provider/Riverpod（原文已举例） |
| 与原文附录契合度 | 低（附录为 Flutter 写） | **高** |
| 与目录 `code/tauri/` 契合度 | **高** | 低 |
| 团队已有能力 | Rust 环境已验证可用 | Flutter 3.47.1 已验证可用 |

**建议**：若团队 Web 前端熟 → **Tauri**（体积、终端渲染、进程树控制三项占优，且目录已暗示）；若团队 Flutter 熟 → **Flutter Desktop**（附录照抄即可，开发最快）。

**不建议继续维持"二选一"的模糊状态**——这会让后续所有 UI/进程代码都在两套假设间摇摆。

### 6.2 推荐架构（以 Tauri 为例，Flutter 同理）

```
┌──────────────── Frontend (WebView) ────────────────┐
│ ProjectTree │ SessionTabs │ Terminal(xterm.js)     │
│            Zustand/Solid store                     │
└───────────────▲───────────────┬────────────────────┘
                │ events(invoke)│
┌───────────────┴───────────────▼────────────────────┐
│ Rust Core                                          │
│  ├ FlutterLocator   (flutter.bat / FVM / customTool)│
│  ├ DaemonClient     (flutter run --machine, 每 tab) │
│  │    stdin:  [{"method","params"}]\n  (UTF-8)     │
│  │    stdout: parse line → JSON array → event      │
│  ├ DeviceService    (device.getDevices / emulator.*)│
│  ├ BuildService     (flutter build, 纯文本+ANSI)    │
│  ├ ProcessSupervisor(Job Object, 杀进程树)          │
│  ├ ProjectLock      (按项目串行, 解决 R8)           │
│  └ Store            (projects.json + schemaVersion) │
└────────────────────────────────────────────────────┘
```

**关键设计点：**
1. **每个运行会话一个 `flutter run --machine` 子进程**，持有 stdin/stdout 管道；不要复用 daemon 的 socket 模式（`--machine` 走 stdio 就够）。
2. **事件驱动**：`app.start` → 建 tab（拿 `supportsRestart`）；`app.debugPort`/`app.devTools` → 启用 DevTools 按钮；`app.log` → 终端写入；`app.stop` → 置 🔴。
3. **`appId` 是会话主键**，从 `app.start` 取，后续 `app.restart`/`app.stop` 都要带。
4. **进程树**：Windows 用 Job Object（`CreateJobObject` + `AssignProcessToJobObject` + `KILL_ON_JOB_CLOSE`），保证关 tab 时 dart/gradle/adb 一起死。
5. **两套日志通路**：run 走 JSON 事件（天然无 ANSI）；build 走纯文本（需 ANSI 剥离 + `\r` 进度行处理）。
6. **持久化加 `schemaVersion`**，便于后续迁移（原文 schema 无版本字段）。

### 6.3 里程碑与工作量估算

| 里程碑 | 内容 | 估时（人日） |
|---|---|---|
| **M0** | 技术栈决策、骨架、`FlutterLocator`（含 `flutter.bat`/FVM） | 2–3 |
| **M1** | 项目管理 + 树 + 持久化（含 schemaVersion） | 4–6 |
| **M2** | 会话/进程/日志（Job Object、UTF-8、xterm、tab 生命周期） | 6–8 |
| **M3** | 设备与模拟器（`device.getDevices` + `emulator.*` + 能力裁剪） | 3–4 |
| **M4** | 热重载/热重启/停止/DevTools（绑定 `app.start.supportsRestart`） | 3–4 |
| **M5** | 发布构建（目标探测、flavor 校验、ANSI、产物定位） | 3–4 |
| **M6** | launch.json 导入（JSONC 解析、`program` 映射、过滤、字段补全） | 3–4 |
| **M7** | 打磨（错误分级、通知、会话恢复、i18n、日志导出/搜索、体检） | 4–6 |
| | **合计** | **28–39 人日** |

**MVP 建议范围**：M0 + M1 + M2 + M4 + M6（≈ 18–25 人日），即可覆盖"导入项目 → 选设备 → 跑起来 → 热重载 → 停"的核心闭环。M3 的模拟器启动、M5 的多 flavor 打包可放 v1.1。

---

## 七、风险登记册

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| K1 | 技术栈摇摆导致返工 | 高 | 高 | **立即拍板**（§6.1） |
| K2 | 同项目并发构建损坏缓存 | 高 | 高 | 项目级构建锁（R8） |
| K3 | `flutter.bat` 无法直接 spawn | 高 | 高 | 统一 `FlutterLocator` + `cmd /c`（§5.2） |
| K4 | 中文日志乱码 | 高 | 中 | 强制 UTF-8 解码（§5.3） |
| K5 | 关 tab 后 dart/gradle 残留 | 中 | 中 | Job Object（§6.2） |
| K6 | Android 许可证导致构建失败被误判为启动器 bug | 中 | 中 | 启动前体检 + 引导（§5.5） |
| K7 | `--machine` 属隐藏接口，未来可能变更 | 中 | 中 | 协议层抽象 + 版本探测 + 契约测试 |
| K8 | 模拟器启动慢/失败（无 KVM 等价物，走 HAXM/WHPX） | 中 | 中 | 异步启动 + 状态回显 + 超时 |
| K9 | 长路径导致深层项目构建失败 | 低 | 中 | 检测并提示开启（§5.4） |
| K10 | launch.json 结构多样（monorepo/多根） | 中 | 低 | 宽容解析 + 导入预览 |

---

## 八、结论

1. **当前实现度为 0%**，只有一份 7 KB 的规格文档，无代码、无仓库。所谓"评估实现"目前只能评估规格与可行性。

2. **规格的产品思路是清晰的**：用轻量启动器替代 IDE 跑 Flutter，WindTerm 式高密度布局，这个定位站得住，痛点真实（Android Studio 启动慢是公认问题）。

3. **协议骨架正确**：`flutter run --machine` 的 daemon JSON 双向通道（`app.restart`/`app.stop` 的 method 与 params）经源码核对**完全成立**，这是整个项目最关键的可行性前提，已确认无风险。

4. **但 13 条技术主张中 7 条有误/需修正**，集中在：DevTools 打开方式、模拟器枚举机制、构建目标平台差异、数据模型字段映射、`r`/`q` 字符键、并发构建冲突。**照字面实现会有 4 个功能直接跑不通。**

5. **必须先解决 3 件事再动手**：
   - 拍板 Flutter Desktop vs Tauri（R1）；
   - 修正设备/模拟器方案为 daemon `emulator.*`（R2）；
   - 数据模型改名 + 补齐 `program`/`env`/`flutterMode`/`deviceId`/`customTool`（R4）。

6. **环境侧无阻塞**：Flutter 3.47.1、VS 2026、Android SDK 37、模拟器、DevTools 齐备；Rust + WebView2 也已实测可跑 Tauri v2 应用。唯一需处理的是 `flutter.bat`、UTF-8、长路径、Android 许可证四个工程细节。

---

## 附录：`launch.json`（dart 类型）完整属性清单

来源：本机 `dart-code.dart-code-3.144.0` 扩展 `package.json` → `contributes.debuggers[0].configurationAttributes.launch.properties`（共 21 项）

`args`(array) · `codeLens`(object) · `console` · `customTool`(string) · `customToolReplacesArgs`(number) · `cwd`(string) · `debuggerType`(string) · `deviceId`(string) · `emulatorId`(string) · `enableAsserts`(boolean) · `env` · `flutterMode` · `flutterPlatform` · `noDebug`(boolean) · `openDevTools` · `program`(string) · `runTestsOnDevice`(boolean) · `suppressWebServerDeviceBrowserLaunch`(boolean) · `templateFor`(string) · `toolArgs`(array) · `vmAdditionalArgs`(array)

> 注：`request`(`launch`/`attach`) 与 `type`(`"dart"`) 是 VS Code 基础字段；`name` 为显示名。
> `emulatorId` 语义："若该模拟器未运行则自动启动，且**覆盖** `deviceId` 与状态栏选择"——可直接用于实现 R2 的"选模拟器即启动"。
