# Flutter Launcher (WindTerm Style) — 需求与架构规格 v2

> **Target Audience:** 本文档面向 AI 编码助手（Cursor / Claude Code / Copilot 等），是生成与扩展本项目的**唯一权威规格**。
> **v1 已被本文件整体取代。** v1 中「Flutter Desktop or Tauri 二选一」「`flutter run --machine` 结构化协议」「每 tab 配热重载按钮」等表述与已定决策冲突，**不得再据此实现**。
>
> 配套文档：
> - `PROJECT_ANALYSIS.md` — v1 需求缺陷与协议核对（历史依据，结论已被本文件吸收）
> - `ARCHITECTURE_V2.md` — 决策推导过程与技术证据（设计依据）

---

## 0. 版本与决策记录

| ID | 决策 | 状态 |
|---|---|---|
| D-1 | 技术栈锁定 **Tauri（Rust + WebView2 + xterm.js）**，不再考虑 Flutter Desktop | ✅ 已定 |
| D-2 | 设备/模拟器统一走常驻 **`flutter daemon`**（`device.*` / `emulator.*`） | ✅ 已定，已实机验证 |
| D-3 | 数据模型以 **`kind`** 替代 `type`，字段对齐 `launch.json` 真实 schema | ✅ 已定 |
| D-4 | **同一项目多 tab；每条命令开一个独立终端执行** | ✅ 已定 |
| D-5 | 允许用户配置项目的 Flutter 可执行文件：**`flutter.exe` / `flutter.bat` / FVM** | ✅ 已定 |
| D-6 | 因 D-4，**放弃 `--machine` 模式**，改用 ConPTY + 终端模式 | ✅ 已定（D-4 的必然推论） |
| D-7 | 终端为**应用内嵌**、WindTerm 风格；**不是**外部终端窗口 | ✅ 已定（Q1 已确认） |
| D-8 | 项目树位于**右侧**（沿用 v1 草图，与 WindTerm 镜像） | ✅ 已定 |
| D-9 | **v1 只做最简终端**：搜索/高亮/会话日志落盘/同步输入/分屏/时间戳/快捷命令栏**全部不做** | ✅ 已定（范围冻结） |
| D-10 | 重启后**恢复 tab 壳 + 历史输出**，但**不自动重启进程**，需用户手动"重跑" | ✅ 已定 |
| D-11 | release 构建结束：**保留 tab + 系统通知** | ✅ 已定 |
| D-12 | 项目支持**两种形态**：单应用（含 `pubspec.yaml`）与**工作区/monorepo**（无 pubspec，命令靠 `cwd` 定位子应用） | ✅ 已定（M1 实测补充） |

**D-6 是本规格最关键的一条**：它把架构从「JSON 事件驱动」切换为「伪终端 + 文本状态机」。详见 §5、§8。

---

## 1. 项目目标

构建一个轻量跨平台桌面应用，作为 **Flutter 应用的启动器与发布管理器**，替代「仅仅为了跑一次/打一次包就打开 Android Studio 或 VS Code」的重型流程。

**设计人格**：借鉴 WindTerm —— 高信息密度、多标签终端管理、层级树导航。

**明确的非目标**：不做 IDE。不提供代码编辑、断点调试、Dart 语言服务。只做"选择项目 → 选择命令 → 在终端里跑起来 → 热重载 → 打包"。

---

## 2. 技术栈（锁定）

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面外壳 | **Tauri v2** | 二进制小、原生窗口 |
| 前端 | WebView2 + TypeScript | 任意框架（建议 Solid/Vue） |
| 终端渲染 | **xterm.js** | 原生 ANSI/256 色/搜索/回滚，**不需要自行剥离 ANSI** |
| 后端 | Rust | 进程、PTY、文件 |
| PTY | **ConPTY**（Rust 侧 `portable-pty`） | Windows 10 1809+；本机 19045 ✅ |
| 进程树 | Win32 **Job Object** | `KILL_ON_JOB_CLOSE` 防孤儿 |

**禁止**：用普通 pipe 接 stdout 冒充终端（见 §5.2）。

---

## 3. UI 蓝图

```
+-----------------------------------------------------------------------------------------+
| [ + 添加 Flutter 项目 ]  [ 📂 导入 launch.json ]              [ 📱 模拟器 ]  ⚙️ 设置       |
+-----------------------------------------------------------------------------------------+
| 活跃会话（终端标签）                                                                     |
| [ 🟢 MyApp:DebugDev (Pixel 5) × ] | [ 🟡 MyApp:GooglePlay (等待构建锁…) × ] | [ + ]     |
+-----------------------------------------------------------------------------------------+
| 左：会话终端（70%）                          | 右：项目树（30%）                         |
|                                              |                                           |
| [⚡ 热重载] [🔄 热重启] [⏹ 停止] [🌐 DevTools] | ▼ 📁 MyApp  ⟳ Flutter 3.32.5 (fvm)       |
| -------------------------------------------- |   ├── 🚀 Debug Dev      (右键→选设备)     |
| Launching lib/main_dev.dart on Pixel 5 in   |   ├── 📦 GooglePlayReleaseProd            |
| debug mode...                                |   ├── 📦 XiaoMiReleaseProd                |
| Running Gradle task 'assembleDebug'...       |   └── ➕ 添加命令                          |
| Flutter run key commands.                    |                                           |
| r Hot reload.   R Hot restart.   q Quit.     | ▼ 📁 OtherApp  ⚠ Flutter 未配置           |
| A Dart VM Service on Pixel 5 is available at:|   └── 🚀 Debug                            |
|   http://127.0.0.1:54321/AbCd=/              |                                           |
+-----------------------------------------------------------------------------------------+
```

**布局要点**

- **左面板是真实终端**（xterm.js 渲染 PTY 输出），不是"日志文本框"。用户可以在此直接敲 flutter 的交互键（`p` 性能叠加、`o` 平台、`s` 截图等）。
- 右面板每个项目节点显示**当前解析到的 Flutter 版本**与来源（`auto`/`custom`/`fvm`）；解析失败显示 ⚠ 并附原因。
- 工具条位于终端上方，作用于**当前激活 tab**。
- 项目树固定在**右侧**（D-8），不做左右切换。
- **项目树交互（M1 已实现）**：单击命令**仅选中**，不触发执行；点该行右侧的 `▶` 按钮或**双击**该行才运行。运行时会先要求选择设备（M3 接入），再创建会话。

### 3.1 v1 范围冻结（D-9）

**v1 做：**

| 能力 | 说明 |
|---|---|
| 项目管理 | 添加/移除项目；支持**单应用**（自身含 `pubspec.yaml`）与**工作区**（自身无 pubspec，靠 `.vscode/launch.json` + 各命令 `cwd` 定位子应用） |
| 项目树 | 右侧两级树：项目 → 命令；右键选设备 |
| 命令执行 | 每条命令一个独立 ConPTY 终端 tab |
| 终端 | 基础 xterm.js：彩色 ANSI、滚动、选中复制、粘贴、Ctrl+C 中断 |
| 会话控制 | ⚡热重载 / 🔄热重启 / ⏹停止 / 🌐DevTools |
| 状态灯 | 🟢🟡🔴 |
| 设备管理 | daemon 枚举设备与模拟器、启动模拟器 |
| 发布构建 | 动态目标、flavor、结束通知 |
| 配置导入 | `launch.json`（JSONC）导入 |
| Flutter 工具链 | `auto` / `custom` / `fvm` 三模式 |
| 会话恢复 | tab 壳 + 历史输出（手动重跑） |

**v1 明确不做（不得"顺手实现"）：**

| 不做 | 备注 |
|---|---|
| 终端内搜索、关键字高亮 | 首选 v1.1 项（`addon-search` 成本极低） |
| 会话日志自动落盘 | 用户可用终端选中复制替代 |
| 同步输入（广播到多会话） | 误操作风险高 |
| 同一 tab 内分屏 | 架构影响最大：tab 将从"1 会话"变为"布局树" |
| 行首时间戳 | PTY 流下与进度行冲突，无法保真 |
| 快捷命令栏 | — |
| 主题体系 / 字体设置 | 提供深浅两套即可，不做可视化配置 |
| 断点调试 / LSP / 代码编辑 | 非目标（§1） |

> 引入上表任何一项，都必须先修订本节并说明工期影响。

---

## 4. 核心概念模型

| 概念 | 说明 | 生命周期 |
|---|---|---|
| **Project** | 一个目录，两种形态：**single**（自身含 `pubspec.yaml`）或 **workspace**（monorepo，自身无 pubspec，含 `.vscode/launch.json`，各命令用 `cwd` 指向子应用） | 持久化 |
| **Command** | 项目下的一条可执行配置（`kind: run` / `build`） | 持久化 |
| **Session** | 一次命令执行 = 一个 tab = **一个 PTY + 一个进程** | 运行期 |
| **Device** | 来自 daemon 的设备/模拟器 | 动态 |

**关键约束**：Session 与 Command 是 **1 : 0..N**。同一命令可被反复执行，每次产生新 Session；同一项目不同命令可并发（受 §13 约束）。

---

## 5. 进程与终端模型（核心）

### 5.1 一命令一会话一 PTY

每次执行命令：

1. 新建一个 **ConPTY 会话**（不是 pipe）；
2. 在 PTY 内以 `cmd.exe` 启动 Flutter 命令（见 §6.4）；
3. PTY 输出 → 前端 → `xterm.write()`；
4. 前端按键 → PTY → 子进程 stdin；
5. 关闭 tab / 停止 → 先尝试优雅退出，超时后 Job Object 强杀整棵树。

### 5.2 为什么必须是 PTY，不能用 pipe

Flutter 工具会检测终端能力并据此降级（源码 `base/io.dart:261-294`）：

```dart
bool get hasTerminal => io.stdout.hasTerminal;
bool get stdinHasTerminal { ... if (!ioStdin.hasTerminal) return false; ... }
bool get supportsAnsiEscapes => hasTerminal && stdout.supportsAnsiEscapes;
```

且 `terminal.dart:389` 有 `if (!usesTerminalUi)` 守卫，`run.dart:894` 仅在非 `--machine` 分支置 `usesTerminalUi = true`。

**pipe 的后果**：`hasTerminal=false` → 无 ANSI 颜色、无进度重绘、无键位提示、`r`/`R`/`q` 无法触发。
**PTY 的收益**：完整彩色输出、spinner/进度条正常、`r`/`R`/`q`/`h`/`p`/`o` 等交互键全部生效。

### 5.3 进程树与孤儿进程

`flutter run` 会派生 `dart.exe`、`gradle`、`adb` 等子进程。**只杀父进程会留下孤儿**。

**要求**：所有会话进程必须 `AssignProcessToJobObject`，Job 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。tab 关闭、应用退出、崩溃三种情况下整棵树都必须回收。

### 5.4 编码

**全链路 UTF-8**。
- Flutter 输出为 UTF-8（实测），而 Windows 控制台默认 codepage 可能为 936（本机即如此）。
- PTY 读取 → 必须显式按 UTF-8 解码；xterm.js 侧同样按 UTF-8。
- **禁止**使用系统 ANSI/OEM 编码解码子进程输出，否则中文日志必乱码。

### 5.5 为什么不用 `--machine`

`--machine` 模式下 stdout 是 `[{"event":...}]\n` 形式的 JSON、stdin 只接受 JSON 命令（源码 `src/daemon.dart:221`）。它与"开一个终端"**互斥**：把 JSON 刷进终端等于没有终端。

D-4 选择终端，因此 **D-6 放弃 `--machine`**。代价是状态由文本解析得出（§8），补偿手段是集中锚点 + 契约测试。

> ⚠️ **实现禁令**：不要在 `flutter run` 命令行里加 `--machine`。也不要同时维护两套模式（除非 §18-Q2 被确认为"需要"）。

### 5.6 ConPTY 的 DSR 握手（M2 实测，必读）

ConPTY 创建后会先向"终端"发送 `ESC[6n`（Device Status Report，查询光标位置），
**在收到位置应答前不会继续输出**。实测若不回应，进程一直卡住、终端一片空白
（现象：只收到一个 4 字节的 `\x1b[6n`，之后再无任何输出）。

**本项目的处理**：由 **Rust 后端**统一拦截 `ESC[6n` → 立即回写 `ESC[1;1R` →
并把该序列从输出中**剔除**（避免 xterm.js 再应答一次；多余的 `R` 会变成 stray input）。

- 该序列可能被拆到两个数据块，必须保留跨块状态（实现见 `pty::DsrFilter`）。
- **只能应答一次**：要么后端做，要么前端做，不能都做。
- 回归测试：`pty::tests::dsr_detects_and_strips` / `dsr_handles_split_sequence` / `dsr_passes_normal_escapes`。
- 诊断工具：`cargo run --bin pty_probe`（会打印 ConPTY 原始分块）。

---

## 6. Flutter 工具链解析（D-5）

### 6.1 配置模型

```jsonc
{
  "flutterTool": {
    "mode": "auto",        // auto | custom | fvm
    "customPath": null,    // mode=custom 时：flutter.exe / flutter.bat / .cmd / SDK 目录
    "fvmVersion": null     // 空则读项目 .fvmrc
  }
}
```

- 作用域：**全局默认** + **项目级覆盖**（项目级优先）。
- `customPath` 允许填：可执行文件路径、或 SDK 根目录（此时自动拼 `bin\flutter.bat` / `bin\flutter`）。

### 6.2 解析优先级（mode = auto）

1. 项目存在 `.fvmrc` 或 `.fvm/fvm_config.json` → 走 FVM 路径（§6.3）
2. PATH 查 `flutter` → Windows 上解析为 `flutter.bat`
3. 常见安装位置兜底探测
4. 全部失败 → 项目节点标 ⚠，命令不可执行，提示"请配置 Flutter 路径"

### 6.3 FVM（D-5 重点）

**`.fvmrc` 真实格式**（取自本机实际项目）：

```json
{
  "flutter": "harmony",
  "env": {
    "FLUTTER_STORAGE_BASE_URL": "https://flutter-ohos.obs.cn-south-1.myhuaweicloud.com",
    "PUB_CACHE": "D:\\mydata\\pub_cache"
  }
}
```

**两条硬性要求：**

1. **`flutter` 字段不保证是版本号**。上例为 `"harmony"`——HarmonyOS 分支的定制别名。
   → **禁止**用 semver 正则校验该字段；只要非空即视为有效标识。
2. **`env` 必须完整透传给子进程**。
   → 不透传 `FLUTTER_STORAGE_BASE_URL` 会导致私有 fork 拉取引擎产物失败；不透传 `PUB_CACHE` 会污染默认缓存。
   → 合并顺序：系统环境 < `.fvmrc.env` < 命令自身 `env`（后者优先）。

**解析实现（推荐，不依赖 fvm CLI）：**

```
<project>/.fvm/flutter_sdk          → 指向实际 SDK 的 junction/symlink
<project>/.fvm/flutter_sdk/bin/flutter.bat   → 直接可执行
```

实测该 junction 存在且指向 `...\fvm\current\versions\<name>`。

- `.fvm/flutter_sdk` 不存在（项目尚未 `fvm use`）→ 提示用户执行 `fvm use`，或降级调用 `fvm flutter`。
- **降级路径**：`fvm flutter <args>`（fvm 在 PATH 时）。
- **不要硬编码 FVM 缓存目录**：本机为 `D:\mydata\scoop\apps\fvm\current\versions\`，**不是** `~/fvm` 或 `%LOCALAPPDATA%\fvm`。始终以项目内 junction 为准。

### 6.4 Windows 上调用 `.bat`（必读）

**Windows `CreateProcess` 无法直接执行 `.bat` / `.cmd`。** 本机 Flutter 安装**只有 `flutter.bat`，没有 `flutter.exe`**：

```
D:\apps\flutter\bin\  →  flutter, flutter.bat, dart, dart.bat
```

**正确方式**：在 PTY 内以 `cmd.exe` 启动，**参数逐项传，不要自己拼引号**：

```
cmd.exe /d /c "<flutter.bat 绝对路径>" <args...>
```

- `/d`：跳过 AutoRun（避免用户注册表注入干扰）。
- **不要加 `/s`**。实测 `/s` 会剥掉首尾引号，导致含空格路径被截断：
  `'C:\...\my' 不是内部或外部命令`。不加 `/s` 时 cmd 的"两个引号"启发式能正确处理
  `"C:\Program Files\...\flutter.bat"`。
- **不要把路径和参数拼成一个带引号的字符串**再交给 `Command`。Rust 的 `Command`
  会把内层引号转义成 `\"`，而 cmd.exe 不认这种转义（报"不是内部或外部命令"）。
  路径作为独立实参传入，由 std 自行加引号。
- `.exe` 场景可绕过 cmd，直接执行。

**参数传递**：一律以 **argv 数组**逐项传递并转义，**禁止字符串拼接**（见 §15）。

### 6.5 可选的直调快路径（默认关闭）

`flutter.bat:74` 最终执行：

```
"%dart%" --packages="%flutter_tools_dir%\.dart_tool\package_config.json" %FLUTTER_TOOL_ARGS% "%snapshot_path%" %*
```

即 `dart.exe --packages=<flutter_tools/.dart_tool/package_config.json> <cache>/flutter_tools.snapshot <args>`（两者本机均存在）。

- **收益**：绕开 cmd 引号问题，启动略快。
- **代价**：跳过 `shared.bat` 的"snapshot 过期则重建"逻辑与 git/PowerShell 自检；`flutter upgrade` 后可能用到陈旧 snapshot。
- **结论**：默认**走 `.bat`**；直调仅作高级开关，且必须附带版本校验。

### 6.6 校验与体检（必须实现）

`flutter.bat` 有三个前置依赖（源码 `flutter.bat:19-52`）：

| 前置 | 缺失时行为 |
|---|---|
| PATH 中有 `git` | `Error: Unable to find git in your PATH.` → exit 1 |
| PATH 中有 `pwsh` 或 `PowerShell.exe` | `Error: PowerShell executable not found.` → exit 1 |
| `%FLUTTER_ROOT%\.git` 存在（须为 git clone 安装） | `Error: The Flutter directory is not a clone of the GitHub project.` → exit 1 |

**要求**：保存配置时执行一次 `<flutter> --version`，解析形如 `Flutter 3.47.1 • channel stable • … • Dart 3.13.1` 的结果并缓存展示；**失败时必须把原始 stderr 呈现给用户**，让用户看到 Flutter 自己的报错，而不是启动器的"未知错误"。

---

## 7. 设备与模拟器（D-2）

### 7.1 方案

保持**每个已配置 Flutter SDK 一个常驻 `flutter daemon` 进程**，通过 stdio 收发 JSON：

```
→ [{"id":"1","method":"device.getDevices"}]
← {"event":"daemon.connected","params":{"version":"0.6.1"}}
← {"event":"device.added","params":{...}}
← {"id":"1","result":[...]}

→ [{"id":"e1","method":"emulator.getEmulators"}]
← {"id":"e1","result":[{"id":"Pixel_5","name":"Pixel 5","category":"mobile","platformType":"android"}]}
```

**实测收益**：
- `emulator.getEmulators` **能列出未启动的模拟器**（本机 `Pixel_5`）——这是 `flutter devices` 做不到的。
- 字段比 `flutter devices --machine` 更全：`category`、`platformType`、`emulatorId`、`ephemeral`、`isConnected`、`connectionInterface`、`capabilities.fastStart`。
- `device.added` 提供热插拔事件，**不需要轮询**。

### 7.2 生命周期

- **惰性启动**；空闲 N 分钟回收；应用退出时统一清理。
- 启动失败 → **降级**为一次性 `flutter devices --machine`（JSON 数组，字段含 `id`/`name`/`targetPlatform`/`emulator`/`sdk`/`capabilities`）。
- 模拟器启动：`emulator.launch`（`{emulatorId}`），靠 `device.added` 点亮。

### 7.3 分组与平台差异

设备菜单按 `category`（`mobile` / `desktop` / `web`）+ `platformType`（`android` / `ios` / `windows` / `macos` / `web`）分组。

**必须按宿主平台裁剪**：
- Windows 宿主**不可能**出现 iOS 模拟器、macOS 桌面设备——不要渲染这些分组。
- 未启动的模拟器来自 `emulator.getEmulators`，与已连接设备**分开呈现**（"可启动的模拟器" vs "在线设备"）。

---

## 8. 会话状态机与解析锚点

### 8.1 解析锚点（源码级确认）

`resident_runner.dart`：

| 行 | 文本 | 用途 |
|---|---|---|
| 1397 | `// Caution: This log line is parsed by device lab tests.` | Flutter 自身承诺该行可解析 → **事实上的稳定契约** |
| 1398-1401 | `A Dart VM Service on {deviceName} is available at: {httpAddress}` | VM Service 地址 |
| 1407 | `The Dart Tooling Daemon is available at: {dtdUri}` | DTD |
| 1423-1426 | `The Flutter DevTools debugger and profiler on {deviceName} is available at: {url}` | **DevTools 按钮目标** |
| 1434 | `Flutter run key commands.` | **应用就绪信号** |

> 注意：DevTools URL 由 `urlToDisplayString` 输出，是**未做 URI 编码**的显示形式（形如 `http://127.0.0.1:PORT?uri=ws://…`），正则需匹配到行尾。

### 8.2 状态判定

| 状态 | 条件 |
|---|---|
| 🟡 Starting | 进程已启动，且尚未命中就绪锚点 |
| 🟢 Running | 命中 `Flutter run key commands.` |
| 🔴 Stopped | PTY 子进程退出（记录退出码），或出现 `Application finished.` |

实现要求：每个会话缓存已命中标志位；按"最后匹配优先"更新；退出码必须在 UI 可查。

### 8.3 按钮映射

| 按钮 | 动作 | 启用条件 |
|---|---|---|
| ⚡ 热重载 | 向 PTY 写 `r` | 🟢 且 `flutterMode == debug` |
| 🔄 热重启 | 向 PTY 写 `R` | 🟢 且 `flutterMode == debug` |
| ⏹ 停止 | 向 PTY 写 `q`；5s 未退则 Job Object 强杀 | 会话存在 |
| 🌐 DevTools | 打开 §8.1 抓到的 DevTools URL | 已抓到 URL |

**模式约束**：`flutterMode` 为 `release`/`profile` 时，`r`/`R` **直接禁用**（依据命令自身配置，而非运行时猜测）。

> 移除锚点依赖时须同步更新契约测试（§17）。

---

## 9. 控制动作的传输方式

- 热重载/热重启/停止 = 向 PTY master 写入对应**单字节**（`r` / `R` / `q`）。
- 保留完整交互能力：用户在终端里手敲 `h`（帮助）、`p`（性能叠加）、`o`（平台切换）等应当照常生效——**不要拦截/吞噬终端输入**。
- 停止动作后必须等待进程真正退出；超时才强杀，避免误杀正在生成的构建产物。

---

## 10. 发布构建

- 命令形如：`flutter build <target> --release --flavor <flavor> <extra_args>`。
- **构建目标必须动态探测，不得硬编码**。本机 Windows 实测可用：

  ```
  aar, apk, appbundle, bundle, web, windows
  ```

  **没有 `ipa`，没有 `macos`**（仅 macOS 宿主注册）。
- **`--flavor` 并非全平台支持**：实测 `apk`/`appbundle`/`windows` 支持；**`web` 不支持**。UI 需按目标动态启用/禁用 flavor 输入。
- `flutter build` **没有 `--machine`**（仅 `analyze`/`attach`/`config`/`devices`/`run`/`test`/`widget_preview` 有）。构建日志按纯文本 + ANSI 处理，由 xterm.js 直接渲染。
- 构建结束：捕获退出码；尝试解析产物路径并在 UI 提供"打开目录/复制路径"（整段输出由终端呈现，不额外做结构化解析）。

---

## 11. 数据模型 v2（D-3）

```jsonc
{
  "schemaVersion": 3,
  "settings": {
    "flutterTool": { "mode": "auto", "customPath": null },   // auto | custom | fvm
    "android": {
      "sdkPath": null,          // Android SDK 根目录
      "emulatorPath": null,     // <sdk>\emulator\emulator.exe
      "avdPath": null           // %USERPROFILE%\.android\avd
    },
    "harmony": {
      "emulatorPath": null,     // DevEco 的 tools\emulator\Emulator.exe（或其目录）
      "instancePath": null,     // %LOCALAPPDATA%\Huawei\Emulator\deployed
      "imageRoot": null,        // 系统镜像根
      "flutterPath": null,      // 鸿蒙 Flutter 分支（flutter_flutter）
      "sdkPath": null
    }
  },
  "commandTemplates": [
    {
      "id": "tpl-debug",
      "name": "Debug",
      "kind": "run",
      "flutterMode": "debug",
      "args": [],
      "scope": "project"
    },
    {
      "id": "tpl-pub-get",
      "name": "Pub Get",
      "kind": "custom",                           // run | build | custom
      "program": "%FLUTTER%",                     // custom：程序路径，或 %FLUTTER% 占位符
      "args": ["pub", "get"],
      "env": { "FLUTTER_SUPPRESS_ANALYTICS": "true" },
      "scope": "global"                           // project | global
    }
  ],
  "projects": [
    {
      "id": "uuid",
      "name": "MyFlutterApp",
      "path": "D:\\projects\\my_flutter_app",
      "kind": "workspace",                       // single | workspace
      "flutterTool": { "mode": "fvm" },          // 可选，项目级覆盖
      "commands": [
        {
          "id": "cmd-1",
          "name": "Debug Dev",
          "kind": "run",                          // run | build | custom
          "program": "lib/main_dev.dart",         // ← launch.json 用 program
          "flutterMode": "debug",                 // debug | profile | release
          "args": ["--flavor", "dev", "--dart-define=ENV=dev"],
          "env": {},
          "toolArgs": [],
          "cwd": null,
          "deviceId": null,
          "emulatorId": null,
          "noDebug": false
        },
        {
          "id": "cmd-2",
          "name": "GooglePlayReleaseProd",
          "kind": "build",
          "buildType": "appbundle",               // apk | appbundle | web | windows | ...
          "args": ["--flavor", "prod", "--release"]
        }
      ]
    }
  ]
}
```

**字段迁移对照（v1 → v2）**

| v1 | v2 | 原因 |
|---|---|---|
| `type: "run"\|"build"` | **`kind`** | `type` 与 launch.json 的 `"dart"` 语义冲突，往返导出会把 `"dart"` 覆盖成 `"run"`，损坏用户文件 |
| `target` | **`program`** | `launch.json` 真实字段名；`target` 仅对应 `flutter run -t` 参数 |
| — | `env` / `flutterMode` / `toolArgs` / `deviceId` / `emulatorId` / `noDebug` | launch.json 真实字段 |
| — | `schemaVersion` | 支持后续迁移 |

---

## 12. `launch.json` 导入

1. **解析**：使用成熟 JSONC 解析器（`json5` / `strip-json-comments` + 去尾逗号）。
   **禁止用正则剥离注释** —— `"args": ["--dart-define=HOST=http://api.example.com"]` 会被 `//` 规则截断。
2. **过滤**：仅接受 `type == "dart"` **且** `request == "launch"` 的配置项。`request == "attach"` 单独标记为 `kind: "attach"`（v1.1 支持）。
3. **路径**：`cwd` 相对 **工作区根**（即 `.vscode` 的**父目录**）解析，**不是**相对 `.vscode` 目录本身。
   > 实测样例：`D:\demo\code\flutter\library\.vscode\launch.json` 中的 `"cwd": "projects/days"`，实际目录为 `D:\demo\code\flutter\library\projects\days`。
4. **字段映射**：`name→name`、`program→program`、`args→args`、`env→env`、`flutterMode→flutterMode`、`toolArgs→toolArgs`、`deviceId→deviceId`、`emulatorId→emulatorId`、`noDebug→noDebug`。
5. **兼容**：`customTool` / `customToolReplacesArgs` 存在时提示用户"该命令使用自定义 Flutter 工具"，并映射到项目级 `flutterTool`（FVM 用户常见）。
6. **导入前预览**：列出将被导入的配置，允许用户勾选。

`launch.json`（dart 类型）真实属性共 21 项：
`args` `codeLens` `console` `customTool` `customToolReplacesArgs` `cwd` `debuggerType` `deviceId` `emulatorId` `enableAsserts` `env` `flutterMode` `flutterPlatform` `noDebug` `openDevTools` `program` `runTestsOnDevice` `suppressWebServerDeviceBrowserLaunch` `templateFor` `toolArgs` `vmAdditionalArgs`
（`request`/`type`/`name` 为 VS Code 基础字段）

---

## 13. 并发与资源管理

### 13.1 事实

`build/` 与 `.dart_tool/` 是**项目级单例**。同项目并发执行时：
- 同 target/flavor/mode → 内核产物路径相同（由构建配置哈希派生），存在写冲突；
- Android Gradle 对 `.gradle`/`build` 有文件锁 → 第二个排队（安全但慢），也可能报 "Another Gradle build is in progress"；
- 首次运行并发会争 `pub get` 的 `package_config.json`。

### 13.2 策略：按「构建期」加锁，而非整会话加锁

```
per-project semaphore
  acquire  → 启动 flutter run（构建/安装阶段）
  release  → 命中 "Flutter run key commands."（应用已跑起来）
```

- **构建阶段串行** → 不损坏缓存；
- **运行/调试阶段并行** → 满足"多 tab 同时跑"；
- 排队时 tab 标 🟡 并显示「等待构建锁…」，**不得**让用户面对无输出的黑终端；
- 加强项：每会话分配独立 `--output-dill <tmp>/<session>.dill` 隔离内核产物。

### 13.3 资源上限

- 同时活跃会话数设上限（建议默认 8），超出时提示而非静默失败。
- daemon 进程数 = 已配置 SDK 数；不同版本 SDK 的设备列表可能不同，不可共用。

### 13.4 会话恢复（D-10）

**目标**：应用重启后，tab 与其历史输出仍在，但**进程不自动拉起**。

| 恢复项 | 是否恢复 | 实现 |
|---|---|---|
| tab 标题、顺序、所属项目/命令/设备 | ✅ | 随 `schemaVersion` 持久化 |
| 终端历史输出 | ✅ | `@xterm/addon-serialize` 序列化缓冲后存盘 |
| 运行中的进程 | ❌ | 重启后 tab 置 🔴「已结束」，提供「重跑」按钮 |
| 滚动位置 | ⚠️ 尽力 | 恢复后滚到底部 |

**约束**

- 序列化缓冲**必须设上限**（建议单会话 ≤ 2 MB，全局 ≤ 20 MB），超出时截断最早内容，避免状态文件无限膨胀。
- 序列化结果含 ANSI 与控制序列，**按原始字节保存**，不要试图转纯文本。
- 恢复的 tab 在**用户点击「重跑」前**不得写入任何 PTY，以免误触发构建。
- 状态文件损坏时：备份为 `sessions.corrupt.json` 后重建，不静默丢弃。

---

## 14. 错误处理

| 场景 | 要求 |
|---|---|
| Flutter 路径无效 | 项目标 ⚠，给出原始 stderr，一键跳设置 |
| `pubspec.yaml` 缺失 | 拒绝添加，说明原因 |
| 目标项目依赖未安装 | 首次 run 前可选 `pub get`，或明确提示 |
| Android 许可证未接受 | 顶部体检横幅 + 修复指引（`flutter doctor --android-licenses`） |
| 构建失败 | 退出码 + 终端保留完整日志，不截断 |
| daemon 崩溃 | 自动重启一次，失败则降级 |
| 会话异常退出 | 保留退出码与最后 N 行日志 |

**体检**：每个项目首次运行前做轻量检查（SDK 版本、`pubspec.yaml`、平台工具链就绪度），结果以横幅呈现，不阻塞。

---

## 15. 安全

1. **禁止 shell 字符串拼接**。所有命令以 argv 数组传递；`.bat` 场景下先转义再交给 `cmd /s /c`。
2. `args` / `toolArgs` / `env` 来自项目文件（可能不可信），视为**数据**而非指令。
3. 打开外部链接（DevTools）前校验 scheme 仅允许 `http` / `https`。
4. 持久化文件写前做 JSON schema 校验，损坏时备份后重建，不静默清空。

---

## 16. 面向 AI 的实现规则（必读）

**必须**
1. 先读 `ARCHITECTURE_V2.md` 的推导与证据，再改实现；遇到与本文冲突的旧代码，以本文为准。
2. 一切终端 IO 走 PTY，UTF-8 解码。
3. 解析锚点集中在**单一模块**（如 `anchors.ts` / `anchors.rs`），便于版本适配。
4. 所有进程挂到 Job Object。
5. 命令一律 argv 数组。
6. Flutter 工具解析走统一 `FlutterLocator`，三个 mode 全覆盖，`env` 透传。

**禁止**
1. ❌ 给 `flutter run` 加 `--machine`。
2. ❌ 用 pipe 代替 PTY。
3. ❌ 用正则剥离 JSONC 注释。
4. ❌ 用 semver 校验 `.fvmrc` 的 `flutter` 字段。
5. ❌ 硬编码构建目标（`ipa`/`macos` 在 Windows 不存在）。
6. ❌ 硬编码 FVM 缓存路径。
7. ❌ 用 `type` 表示命令种类（必须用 `kind`）。
8. ❌ 直接 `CreateProcess` 一个 `.bat`。
9. ❌ 只杀父进程。
10. ❌ 在 `release`/`profile` 模式下启用热重载按钮。
11. ❌ 实现 §3.1「v1 明确不做」清单中的任何功能（范围已冻结）。
12. ❌ 引入 `addon-search` 等**特性** addon（`addon-serialize` 仅为 D-10 会话恢复所需，允许；见下方依赖锁定表）。
13. ❌ 在用户点击「重跑」前自动拉起恢复的会话进程。
14. ❌ 后端与前端同时应答 DSR，或完全不应答（前者产生 stray input，后者直接卡死）。
15. ❌ 给 `cmd.exe` 加 `/s`，或把可执行文件路径与参数拼成一个带引号的字符串。

**依赖范围（锁定）**：终端仅使用以下基础 addon，其余一律不引入。

| 包 | 版本 | 用途 |
|---|---|---|
| `@xterm/xterm` | 6.0.0 | 终端内核 |
| `@xterm/addon-fit` | 0.11.0 | 尺寸自适应 |
| `@xterm/addon-webgl` | 0.19.0 | GPU 渲染（大数据量日志必需） |
| `@xterm/addon-unicode11` | 0.9.0 | **CJK 宽字符对齐**（中文必需） |
| `@xterm/addon-serialize` | 0.14.0 | 会话恢复（D-10） |

---

## 17. 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| A1 | 配置 `flutter.bat` 路径后，项目显示正确版本与 channel | 版本号与 `flutter --version` 一致 |
| A2 | 配置 FVM 项目（`.fvmrc` 含 `env`）后，能跑起私有 fork | 子进程环境含 `FLUTTER_STORAGE_BASE_URL` |
| A3 | 终端显示彩色输出与 spinner | 与系统终端里直接运行观感一致 |
| A4 | 点击热重载，终端出现 "Reloaded …" | 命中重载输出 |
| A5 | 出现 `Flutter run key commands.` 后 tab 变 🟢 | 状态正确 |
| A6 | 点 DevTools 能打开完整 DevTools 页面 | 非 VM Service 原始地址 |
| A7 | 未启动的 Android 模拟器出现在"可启动"分组 | 来自 `emulator.getEmulators` |
| A8 | 关闭 tab 后无 dart/gradle 残留 | 任务管理器核对 |
| A9 | 同项目两命令并发：构建期串行、运行期并行 | 队列提示可见 |
| A10 | 导入含 `//` 与尾逗号的 launch.json 不报错 | 字符串内 `http://` 不被截断 |
| A11 | 中文日志无乱码 | 目视核对 |
| A12 | Windows 上构建目标不含 `ipa`/`macos` | 与实际 subcommand 一致 |
| A13 | 重启应用后，历史 tab 与输出仍在，且**没有**任何进程被自动拉起 | 任务管理器无新增 dart/gradle |
| A14 | release 构建结束弹出系统通知 | 通知含项目名与成功/失败 |
| A15 | 终端中文与英文混排对齐（CJK 宽字符） | 目视无错位 |
| A16 | v1 中不存在搜索框、分屏、同步输入入口 | 与 §3.1 一致 |
| A17 | 导入 monorepo 工作区（根目录**无** `pubspec.yaml`） | 9 条命令全部导入、`cwd` 解析正确、零告警 |
| A18 | 状态持久化往返 | 重启后项目与命令完整保留，`state.json` 的 `schemaVersion = 2` |
| A19 | 重复添加同一目录 | 被拒绝，提示"该项目已在列表中" |
| A20 | 状态文件损坏 | 备份为 `state.corrupt.json` 并重置，不静默丢失 |
| A21 | 点 `▶` 后终端出现真实 `flutter run` 输出 | 有 ANSI 颜色、可滚动、状态灯转 🟢、DevTools 可点 |
| A22 | 会话结束 | 标签转 🔴、可查退出码、进程树无残留 |
| A23 | 右键命令弹出设备菜单 | 列出在线设备 **且** 列出未启动的模拟器（如 `Pixel_5`） |
| A24 | 从菜单选设备后运行 | 命令带 `-d <id>` 启动；选模拟器则先 `emulator.launch` |
| A25 | 工具栏「📱 模拟器」 | 同时列出 Android AVD 与 HarmonyOS 实例，点击即启动 |
| A26 | 设置页「自动检测」 | 在本机实测命中 Flutter / Android SDK+emulator+AVD / DevEco Emulator+实例+镜像+Flutter 分支，且未配置时自动回退 |
| A27 | 构建目标动态探测 | 只列出当前宿主可用的目标；`--flavor` 支持度逐目标判定 |
| A28 | 构建产物与通知 | 产物路径从 `✓ Built ...` 解析并可打开目录；结束发系统通知 |
| A29 | 命令模板库 | 设置里可增删改模板；新增「单应用」项目自动套用模板，不再是空命令树 |
| A30 | 按需导入模板 | 项目树「从模板导入…」支持全选/部分选择，按「名称+类型」去重 |
| A31 | 自定义命令与环境变量 | `kind: custom` 直接执行指定程序；`%FLUTTER%` 解析为项目 flutter；`env` 注入子进程 |
| A32 | 全局作用域 | `scope: global` 的模板出现在项目右键菜单，点击即执行且**不写入项目命令列表** |
| A33 | 会话恢复 | 重启后 tab 与历史输出恢复、进程不拉起、提供「重跑」；恢复态下输入不写 PTY |
| A34 | 会话日志预算 | 单会话 ≤ 2 MB、全局 ≤ 20 MB、最多 20 个；损坏时备份 `sessions.corrupt.json` |

---

## 18. 待确认问题

| # | 问题 | 影响 |
|---|---|---|
| **Q1** | ~~"打开一个终端"= 内嵌还是外部窗口？~~ | ✅ **已确认：内嵌（D-7）** |
| **Q2** | ~~是否保留 `--machine` 可选模式？~~ | ✅ **已确认：不保留**（v1 最简，D-9） |
| Q3 | FVM 的 `env` 是否也需要全局配置项？ | v1 按"仅项目级 `.fvmrc` 透传"实现，全局配置留待 v1.1 |
| Q4 | 同项目同 flavor 并发：硬阻止还是排队+提示？ | 已按**排队+提示**实现（§13.2） |
| Q5 | 构建产物路径：仅展示还是可打开目录？ | v1：解析到则显示并可点击打开目录；解析不到仅显示退出码 |

> 无阻塞项，可开工。

---

## 附录 A：关键证据索引（本机 Flutter 3.47.1 源码）

| 结论 | 出处 |
|---|---|
| daemon stdout 为每行一个 JSON 数组、UTF-8 | `packages/flutter_tools/lib/src/daemon.dart:221` |
| `--machine` 为隐藏参数，仅 `-v --help` 可见 | `lib/src/runner/flutter_command.dart:1317`（`hide: !verboseHelp`） |
| `--machine` 不支持 `-d all` | `lib/src/commands/run.dart:852-855` |
| `--machine` 内部即创建 daemon 并接 stdio | `lib/src/commands/run.dart:839-856`；`commands/daemon.dart` `Daemon.createMachineDaemon()` |
| 终端能力检测（pipe 会降级） | `lib/src/base/io.dart:261-294`；`terminal.dart:389`；`run.dart:894` |
| 状态/URL 解析锚点 | `lib/src/resident_runner.dart:1397-1434` |
| 交互键集合由 `canHotReload`/`supportsRestart` 守卫 | `lib/src/resident_runner.dart:1432-1456` |
| `flutter.bat` 内部调用与前置依赖 | `bin/flutter.bat:19-74` |
| `flutter build` 无 `--machine` | `addMachineOutputFlag` 仅存在于 `analyze`/`attach`/`config`/`devices`/`run`/`test`/`widget_preview` |
| launch.json（dart）21 项属性 | 本机 `dart-code.dart-code-3.144.0` 扩展 `package.json` |

## 附录 B：本机环境事实（2026-10-19 实测）

| 项 | 值 |
|---|---|
| OS | Windows 10 专业版 10.0.19045 |
| Flutter / Dart | 3.47.1 stable / 3.13.1 |
| DevTools | 2.60.0 |
| Flutter 安装 | `D:\apps\flutter`（git clone，**仅 `flutter.bat`，无 `flutter.exe`**） |
| FVM | 4.3.1，缓存 `D:\mydata\scoop\apps\fvm\current\versions\` |
| Android SDK / adb | 37.0.0 / 1.0.41；AVD `Pixel_5` |
| Visual Studio | Community 2026 18.9.2；Windows SDK 10.0.26100.0 |
| WebView2 | 155.0.4283.62 |
| Rust / cargo | 1.96.1 (x86_64-pc-windows-msvc) |
| 控制台代码页 | 936（但 Flutter 输出 UTF-8） |
| 长路径 | **未启用**（建议开启） |
| Android 许可证 | 部分未接受（会导致目标项目构建失败） |

### 附录 B.1：关键依赖版本（2026-10-19 核对）

| 包 / crate | 版本 | 用途 |
|---|---|---|
| `@xterm/xterm` | 6.0.0 | 终端内核 |
| `@xterm/addon-fit` | 0.11.0 | 自适应尺寸 |
| `@xterm/addon-webgl` | 0.19.0 | GPU 渲染 |
| `@xterm/addon-unicode11` | 0.9.0 | CJK 对齐 |
| `@xterm/addon-serialize` | 0.14.0 | 会话恢复 |
| `tauri` (crate) | 2.12.4 | 桌面外壳 |
| `portable-pty` (crate) | 0.9.0 | ConPTY 封装 |
| `windows` (crate) | 0.62.2 | Job Object 等 Win32 |
| `tokio` (crate) | 1.53.3 | 异步 IO |
| `@tauri-apps/cli` | 2.12.3 | 构建工具（本机已验证） |
