# Flutter Launcher

> 轻量级 **Flutter 应用启动器与发布管理器** —— 不用打开 Android Studio / VS Code，也能跑起来、热重载、打渠道包。
> 界面参考 **WindTerm**：高信息密度、多标签终端、层级树导航。

![界面截图](docs/shot-m3.png)

---

## 当前状态

**M3：设备与模拟器已接入** —— 右键命令即可看到在线设备与**未启动的模拟器**，选中设备直接开跑。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | Tauri 骨架 + WindTerm 风格界面 | ✅ 完成 |
| M1 | 项目管理 + 项目树 + 持久化 | ✅ 完成 |
| M2 | ConPTY 会话 + 真实终端 + 进程树回收 | ✅ 完成 |
| M3 | 设备/模拟器（`flutter daemon`） | ✅ 完成 |
| M3.5 | 设置页（Flutter/Android/HarmonyOS 目录）+ 工具栏模拟器菜单 | ✅ 完成 |
| M4 | 热重载 / 热重启 / 停止 / DevTools | ✅ 完成（随 M2 一并落地） |
| M5 | 发布构建 + 通知 | ✅ 完成 |
| M6 | `launch.json` 高级导入（手动添加命令等） | ✅ 完成（命令增删改 + 模板库） |
| M7 | 会话恢复 + 打磨 | ✅ 完成 |
| P1 | 平台菜单派生 + 备案信息 | ✅ 完成 |
| P2 | 备案公钥（解析 APK 签名块） | ✅ 完成 |

### 平台菜单 + 备案信息

**导入了 Flutter 项目后命令为空？这是有意的。** 平台/模式组合不再存成命令，而是从
「项目 + 宿主 + 设备」动态派生：

```
右键项目
├─ 平台
│   ├─ Android ▸  调试运行 / 性能分析运行 / 构建 APK / 构建 AAB / 构建 AAR
│   ├─ Web     ▸  调试运行 / 性能分析运行 / 构建 Web
│   ├─ Windows ▸  …
│   ├─ iOS     ▸  （灰：当前宿主的 flutter 不支持该平台）
│   ├─ Linux   ▸  （灰：…）
│   └─ macOS   ▸  （灰：…）
├─ 全局命令    Pub Get
└─ 从模板导入 / 添加命令
```

- **可用性三条件**：项目有该平台目录 ∧ 宿主 `flutter build` 支持 ∧（运行类）有该平台设备
- **宿主支持度**由 `flutter build --help` 的目标列表推导，**不硬编码**——
  换到 macOS 自动出现 iOS/macOS，不需要重新配
- **运行类置灰会说明原因**："没有可用设备（可先启动模拟器）"
- **工作区项目不显示平台菜单**（根目录没有平台，跑哪个子应用是歧义的）
- 派生动作**不落盘**；恢复后「⟳ 重跑」按平台重新解析设备
- **菜单直接显示真实命令**：`flutter run --debug` / `flutter run --profile` /
  `flutter run --release` / `flutter build apk --release` …，副行是中文说明
- 三种运行模式齐全：调试、性能分析、**发布模式运行（不打包）**——后者容易被漏掉，
  它是 `flutter run --release`，与 `flutter build`（只出产物、不运行）是两回事
- **结果缓存（内存 + 磁盘）**：首次分析要跑 6 次 `flutter build <t> --help` 并拉起 daemon
  （约十秒），之后**跨重启**都直接用缓存；右键菜单里有「重新分析平台信息」强制刷新
- 模拟器列表同样落磁盘缓存，菜单里的 ⟳ 才重新检查
- 缓存在 `%APPDATA%\com.flutterlauncher.app\cache.json`，删掉即可强制全部重算
- 分析在阻塞线程池执行，不会占住主线程卡界面

**HarmonyOS 工程**：目录里有 `ohos/` 就自动改用设置里的鸿蒙 flutter 分支
（`flutter_flutter`），平台菜单因此多出 `HarmonyOS`，构建目标是 `hap` / `app`。
标准 flutter 不认识 `ohos/`、也没有 `build hap`，所以这一步不能省。

**FVM 工程**：项目根有 `.fvmrc` 就在名称后标 `FVM`。即使 SDK 不在
`.fvm/flutter_sdk`（走 FVM 全局缓存），也能识别出这是 FVM 工程。

**同名项目**：两个都叫 `jbook` 时，用最具区分度的祖先目录名做后缀——
`jbook ‹library›` 与 `jbook ‹hm-library›`，不会在树里混淆。

**导入 launch.json 的判定**（`import_launch_path`）：先看目录有没有 `pubspec.yaml`——
有则作为**普通 Flutter 项目**导入，launch.json 的命令成为它的自定义命令；
没有则作为**命令集**导入。命令集本身就是命令列表，右键时不显示平台也不显示全局命令。
重复导入同一目录只刷新命令，不重复添加。选目录、选 `.vscode`、直接选 `launch.json` 都可以。

**迁移（schema v4 → v5）**：`Debug` / `Build APK` / `Build Windows` / `Build Web`
四条内置模板退役，已实例化且未改名的命令一并清理；模板库只保留 `Pub Get`。
清理是**幂等**的，不依赖版本号。

**备案信息**：工具栏「📋 备案」→ 选 APK →

- 取数链路经实测选定：包名/版本用 `aapt2 dump badging`，指纹用 `apksigner verify --print-certs`
  （`keytool -printcert -jarfile` 对只有 V2 签名的 APK **直接失败**；JDK 17 的
  `keytool -list -v` **不再输出 MD5**）
- 三要素：应用名称 / 包名 / MD5，各带复制；MD5 统一成大写冒号分隔
- 附加：版本、SDK、签名方案、DN、SHA-1、SHA-256，可「复制全部」
- 调试签名会显著提示"请勿用于备案"
- **公钥**由自实现的 APK Signing Block 解析得到：定位 EOCD → Signing Block →
  V2/V3 块 → `signers → signer → signed_data → digests → certificates` → 证书 DER
  → X.509 的 SPKI → Base64
- **交叉校验**：自解析出的证书 MD5 必须等于 `apksigner` 的 MD5，不一致会在面板上告警
  （实测本机样本两者完全一致）
- 设置里可覆盖 `build-tools` 目录与 `keytool` 路径，留空自动探测

![平台菜单](docs/shot-platform-menu.png)

![备案信息](docs/shot-filing.png)

### 体检（§6.6 / §14）· 工具栏按钮

启动后后台跑一次 `flutter doctor`，状态直接显示在工具栏按钮上，点开是完整报告：

| 状态 | 按钮 |
|---|---|
| 进行中 | `⏳ 体检` |
| 全部正常 | `✓ 体检`（绿） |
| 有问题 | `! 体检 N`（黄，N = 问题项数） |
| 执行失败 | `✗ 体检`（红，悬停看原始报错） |

- **符号陷阱**：`flutter_tools/lib/src/base/logger.dart:738` 在 `supportsEmoji == false` 时
  把 `✓` 换成 `√`、`✗` 换成 `X`、`⚠️` 换成 `!`。解析器**两套符号都接受**，
  否则在中文终端上永远匹配不到状态行
- **修复指引**：从 `To resolve this, run:` 与已知问题表里提取命令，可复制
- **在终端执行**：白名单内的修复动作（如 `flutter doctor --android-licenses`）
  可直接起一个 PTY 会话跑，许可证确认可交互输入 `y`
- 失败时原样呈现 Flutter 自己的报错，而不是"未知错误"
- 结果缓存 5 分钟，报告里可「重新体检」

![工具栏体检按钮](docs/shot-doctor-toolbar.png)

![体检报告](docs/shot-doctor-report.png)

### M7 已实现 · 会话恢复（D-10）

重启应用后，**tab 壳与历史输出都在，但进程不自动拉起**：

- 元数据（标题、设备、模式、所属项目/命令/模板、退出码、产物）随会话落盘
- 终端缓冲用 `@xterm/addon-serialize` 序列化成 ANSI 原样保存并回放
- 恢复的 tab 带 `恢复` 角标，状态 🔴「已停止」，控制条点亮 **⟳ 重跑**
- **恢复的 tab 在被点「重跑」之前绝不写 PTY**：键盘输入只提示，不转发
- 预算：单会话 ≤ 2 MB、全局 ≤ 20 MB、最多 20 个；超出时从最旧内容截断
- `sessions.json` 损坏时备份为 `sessions.corrupt.json` 后重建

![会话恢复](docs/shot-m7-restore.png)

### 命令模板库（解决"新项目命令为空"）

- **全局模板**：设置 → 命令模板，可新建 / 编辑 / 删除 / 恢复默认（内置 Debug、Build APK、Build Windows、Build Web、Pub Get）
- **三种类型**：
  - `run` — `flutter run`（可指定 `-t` 入口与 debug/profile/release）
  - `build` — `flutter build <目标> --release`（目标动态探测）
  - `custom` — 任意程序 + 参数；`%FLUTTER%` 会替换成该项目的 flutter 可执行文件
- **环境变量**：键值对随命令保存，直接注入 PTY 子进程
- **作用域**：
  - `project` — 导入到项目后才能执行
  - `global` — **项目右键即可执行，不写入项目命令列表**
- **自动套用**：新增「单应用」项目时自动把模板实例化为该项目的命令，不再是空树
- **按需导入**：项目树底部「⤓ 从模板导入…」，勾选后导入（支持全选 / 全不选，按名称+类型去重）
- **工作区不自动套用**：monorepo 的命令来自 `launch.json`，避免污染

![命令模板库](docs/shot-templates.png)

![从模板导入](docs/shot-template-import.png)

![自定义命令与作用域](docs/shot-cmd-custom.png)

![项目右键执行全局命令](docs/shot-proj-menu-crop.png)

### M5 已实现

- **构建目标动态探测**：解析 `flutter build --help` 的子命令列表，**不硬编码**。
  Windows 宿主没有 `ipa` / `macos`
- **flavor 支持度探测**：逐个执行 `flutter build <target> --help` 检查是否含 `--flavor`
  （实测 `apk`/`windows` 支持，`web` 不支持），不支持时输入框置灰
- **命令编辑对话框**：树里「＋ 添加命令」可建 run / build 两类命令；右键命令可编辑或删除
- **产物解析**：从终端流里匹配 `✓ Built <path>`，在控制条生成 `📦 产物名` 按钮，点击在资源管理器定位
- **构建通知**：结束（成功或失败）发系统通知，含项目与产物/退出码
- **退出码可见**：终端末尾打印 `──── 会话结束（退出码 N）────`，标签转 🔴

![构建结果](docs/shot-m5.png)

### 设置页与模拟器菜单（M3.5）

- **工具栏「📱 模拟器」**：聚合两个来源，点条目即启动
  - Android AVD ← 直接驱动 `emulator.exe -list-avds`，并把设置里的
    SDK / AVD 目录通过 `ANDROID_AVD_HOME` 等注入子进程（自定义 AVD 目录才真正生效）；
    未配置时回退 `flutter daemon`
  - HarmonyOS 实例 ← DevEco `Emulator.exe -list`
- **列表缓存**：首次打开查询并缓存，之后直接渲染；点标题栏右侧 **⟳** 才重新检查
- **设置页**（⚙）三段：
  - Flutter：`auto` / `custom` / `fvm` + 自定义路径
  - Android：SDK 目录 / `emulator.exe` / AVD 目录
  - HarmonyOS：`Emulator.exe` 目录 / 实例目录 / 镜像目录 / 鸿蒙 Flutter 分支 / SDK
- **一键自动检测**：不扫全盘，只用环境变量 + `hdc.exe` 反推 + 常见安装位置
- **开箱即用**：HarmonyOS 路径未配置时自动回退到探测结果

![模拟器菜单](docs/shot-emulators-menu.png)

![设置页](docs/shot-settings.png)

### M3 已实现

- **常驻 `flutter daemon`**：按 Flutter 可执行文件复用，`device.getDevices` + `emulator.getEmulators`
- **能看到未启动的模拟器**：`flutter devices` 只列在线设备，`flutter emulators --machine` 根本不存在；daemon 协议才拿得到 `Pixel_5` 这类待启动项
- **设备菜单**：右键命令弹出，分「自动选择 / 在线设备 / 可启动模拟器」；选中设备即带 `-d` 启动，选模拟器则先 `emulator.launch`
- **热插拔**：监听 `device.added` / `device.removed` 事件推送，无需轮询
- **健壮性**：daemon 超时自动杀掉重建；stderr 独立消费避免管道写满阻塞

### M2 已实现

- **ConPTY 会话**：每条命令一个伪终端（`portable-pty`），前端 xterm.js 直接渲染 ANSI 彩色输出
- **流式 UTF-8 解码**：多字节字符被数据块切断时保留尾部，中文日志不乱码
- **DSR 握手**：ConPTY 启动即发 `ESC[6n` 查询光标位置，不应答会**永久卡住**；由后端统一应答 `ESC[1;1R` 并剔除该序列（只应答一次）
- **进程树回收**：Windows Job Object + `KILL_ON_JOB_CLOSE`，关标签/退出应用时连带杀掉 `flutter → dart → gradle`
- **会话状态机**：命中 `Flutter run key commands.` → 🟢；进程退出 → 🔴 并记录退出码
- **控制按钮**：热重载 `r`、热重启 `R`、停止 `q`（5 秒后兜底强杀）、DevTools（从输出解析 URL 打开）
- **命令拼装**：`.bat` 经 `cmd.exe /d /c`（**不加 `/s`**），路径与参数逐项传参，避免引号被二次转义

### M1 已实现

- **项目管理**：目录选择器添加；自动区分「单应用」（含 `pubspec.yaml`）与「工作区」（monorepo，靠 `.vscode/launch.json` + `cwd` 定位子应用）；支持移除与重复校验
- **`launch.json` 导入**：手写 JSONC 状态机（行注释 / 块注释 / 尾逗号）；按 `type == "dart" && request == "launch"` 过滤；`cwd` 相对**工作区根**解析（VS Code 的真实语义，不是相对 `.vscode`）
- **项目树**：真实数据渲染，展示 Flutter 来源（`FVM` / `自定义` / `PATH`）、版本号、`release` 模式标记
- **持久化**：`%APPDATA%\com.flutterlauncher.app\state.json`，`schemaVersion: 2`，原子写入；损坏时备份为 `state.corrupt.json` 后重建
- **Flutter 探测**：解析可执行文件并执行 `--version`

### 测试

```bash
cd src-tauri && cargo test
```

43 个测试：JSONC 解析、真实 monorepo 导入、Flutter 探测、状态往返、损坏恢复、UTF-8 跨块解码、DSR 过滤、命令拼装、真实 daemon 查询设备与模拟器、工具链自动检测、模板导入与去重、自定义命令与环境变量、会话日志预算与损坏备份、doctor 输出解析（含 Windows 符号替换）、Android AVD 目录解析、APK 签名块解析（MD5 与 apksigner 交叉验证）。

诊断工具：
```bash
cd src-tauri && cargo run --bin pty_probe   # ConPTY 原始分块
```

> **开发期钩子**（用于无人值守验证）：
> - `FLA_AUTOSTART="<项目ID>|<命令ID>|<设备ID>"` 启动即运行指定命令
> - `FLA_DEVICE_MENU="<项目ID>"` 启动即弹出设备菜单

---

## 快速开始

```bash
npm install
npm run tauri dev
```

首次会编译 Rust（约 1.5 分钟），之后前端改动由 Vite 热更新。

其他命令：

```bash
npx tsc --noEmit     # 类型检查
npm run build        # 前端构建
npm run tauri build  # 打包安装程序
```

### 环境要求

- Windows 10 1809+（**ConPTY** 依赖；本项目在 10.0.19045 上开发）
- Rust 1.85+（msvc toolchain）
- Node.js 20+
- Visual Studio Build Tools（C++ 工作负载）+ Windows SDK
- WebView2 Runtime

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Tauri v2 |
| 前端 | Vite + TypeScript（无框架） |
| 终端 | xterm.js 6.0（fit / webgl / unicode11） |
| 后端 | Rust |

---

## 目录结构

```
├── src/                        前端
│   ├── main.ts                 应用入口（项目管理 / 项目树 / 持久化）
│   ├── styles.css              WindTerm 风格深色主题
│   └── vite-env.d.ts
├── src-tauri/                  Rust 后端
│   ├── src/lib.rs              Tauri 命令注册
│   ├── src/ops.rs              业务操作（添加项目 / 导入），纯函数便于测试
│   ├── src/store.rs            状态读写（原子落盘 / 损坏恢复）
│   ├── src/launch.rs           launch.json 解析
│   ├── src/jsonc.rs            JSONC 状态机（注释 / 尾逗号）
│   ├── src/flutter.rs          Flutter 可执行文件解析与版本探测
│   ├── src/pty.rs              ConPTY 会话（UTF-8 流解码 / DSR 应答 / Job Object）
│   ├── src/daemon.rs           flutter daemon 客户端（设备 / 模拟器 / 热插拔）
│   ├── src/bin/pty_probe.rs    ConPTY 诊断探针
│   ├── src/model.rs            数据模型（schemaVersion 2）
│   ├── tauri.conf.json         窗口与应用配置
│   └── Cargo.toml
├── docs/
│   ├── shot-m3.png             M3 界面截图（设备菜单）
│   ├── shot-m3-menu.png        设备菜单细节
│   ├── shot-m2.png             M2 界面截图（真实终端）
│   ├── shot-m1.png             M1 界面截图
│   └── shot-m1-tree.png        项目树细节
├── readme_md_for_ai_agents.md  ★ 权威规格 v2（AI 助手必读）
├── ARCHITECTURE_V2.md          设计推导与源码级证据
└── PROJECT_ANALYSIS.md         v1 需求评估（历史文档）
```

---

## 文档

| 文件 | 作用 |
|---|---|
| [readme_md_for_ai_agents.md](readme_md_for_ai_agents.md) | **唯一权威规格**：决策记录、UI 蓝图、PTY 模型、Flutter 工具链解析、数据模型、验收标准 |
| [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md) | 为什么这样设计：协议证据、权衡分析、风险评估 |
| [PROJECT_ANALYSIS.md](PROJECT_ANALYSIS.md) | v1 规格的缺陷与协议核对（历史，部分结论已反转） |

---

## 几条关键约束（v1 已冻结，勿擅自扩展）

1. **不用 `--machine`**。终端模式与 JSON 模式互斥，走 ConPTY。
2. **不用 pipe 冒充终端**。管道会让 Flutter 降级（无 ANSI、无交互键）。
3. **构建目标动态探测**。Windows 上没有 `ipa` / `macos`。
4. **`.fvmrc` 的 `env` 必须透传**，`flutter` 字段可能是自定义分支名（如 `harmony`）。
5. **任何外部进程都要挂 Job Object**，包括常驻 helper（`flutter daemon`），不只是终端会话。
   判据是"强杀应用后无残留"，不是"代码里写了 `AssignProcessToJobObject`"。
6. **v1 不做**搜索 / 分屏 / 同步输入 / 日志落盘 / 时间戳 / 快捷命令栏。

详见规格 §3.1、§5.3 与 §16。

### 回归验证：无残留外部进程（A35）

新增任何 `spawn` 后跑一次。**必须强杀，不能走正常关闭**——正常关闭会执行 `Drop`，掩盖问题。

```powershell
# 1) 应用运行中，先让 daemon 起来（打开一次设备菜单），确认它在
(Get-CimInstance Win32_Process -Filter "Name='dart.exe'" |
  Where-Object { $_.CommandLine -match 'flutter_tools.snapshot" daemon' }).Count   # 期望 1

# 2) 强杀应用
Get-Process flutter-launcher | Stop-Process -Force
Start-Sleep -Seconds 3

# 3) 再数一次
(Get-CimInstance Win32_Process -Filter "Name='dart.exe'" |
  Where-Object { $_.CommandLine -match 'flutter_tools.snapshot" daemon' }).Count   # 必须 0
```





