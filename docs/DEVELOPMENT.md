# AppDeck 开发与架构

> 面向贡献者：里程碑、实现约束、测试与回归验证。
> 功能用法见 [USAGE.md](USAGE.md)；架构推导见 [ARCHITECTURE_V2.md](../ARCHITECTURE_V2.md)；
> 权威规格见 [readme_md_for_ai_agents.md](../readme_md_for_ai_agents.md)。

---

## 里程碑与当前状态

**M3：设备与模拟器已接入** —— 右键命令即可看到在线设备与**未启动的模拟器**，选中设备直接开跑。
之后又长出了两块：**多生态导入**（`package.json` / `docker-compose.yaml`）与**普通命令共用项目终端**。

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
| P3 | 多生态导入（`package.json` / `docker-compose.yaml`） | ✅ 完成 |
| P4 | 普通命令共用项目终端（不再一命令一标签） | ✅ 完成 |
| P5 | 模板分类 / 命令右键分流 / 原子落盘 + 单实例 / 提交前把关 | ✅ 完成 |

## 数据安全：原子落盘 + 单实例

- **落盘是原子替换**：临时文件名带 pid + 纳秒，写完直接 `rename` 覆盖。
  Rust 的 `fs::rename` 在 Windows 上走 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，
  本身就能替换已存在文件——**不要"先删后改名"**，那会留下"state.json 不存在"的窗口，
  这期间断电就把配置丢了
- `state.json` 与会话记录（`sessions.json`）共用 `atomic::write_atomic`
- **单实例**（`tauri-plugin-single-instance`）：第二个实例启动即退出，并把已有窗口拉到前面。
  两个进程同时写同一份 `state.json`，后写的会把先写的改动整个覆盖——
  原子写只保证文件不损坏，救不了这种语义上的丢失

## 提交前把关（husky）

```bash
.husky/pre-commit
  npm run typecheck    # tsc --noEmit
  npm run test         # cargo test --manifest-path src-tauri/Cargo.toml
```

约 6 秒。着急时 `git commit --no-verify` 跳过。

**刻意没接 Prettier 自动格式化**：`src/main.ts` 有 5000+ 行，全量重排会让真实改动
淹没在"整文件重写"的 diff 里；格式化应该单独做一次、单独提交。

## 测试

```bash
cd src-tauri && cargo test
```

102 个测试：JSONC 解析、真实 monorepo 导入、Flutter 探测、状态往返、损坏恢复、UTF-8 跨块解码、DSR 过滤、命令拼装、真实 daemon 查询设备与模拟器、工具链自动检测、模板导入与去重、自定义命令与环境变量、会话日志预算与损坏备份、doctor 输出解析（含 Windows 符号替换）、Android AVD 目录解析、APK 签名块解析（MD5 与 apksigner 交叉验证）、npm 包管理器探测与脚本分类、compose 解析与服务命令生成、可执行文件解析（`docker` → `docker.exe`）、外部程序不被当成 `flutter run`、模板分类推断、原子落盘（覆盖写不留临时文件 / 并发写不产生半个 JSON）、窗口关闭行为默认值与序列化。

诊断工具：
```bash
cd src-tauri && cargo run --bin pty_probe   # ConPTY 原始分块
```

> **开发期钩子**（用于无人值守验证，不设变量时完全无副作用）：
> - `FLA_AUTOSTART="<项目ID>|<命令ID>|<设备ID>"` 启动即运行指定命令
> - `FLA_DEVICE_MENU="<项目ID>"` 启动即弹出设备菜单
> - `FLA_PROJ_MENU="<项目ID>"` / `FLA_SUBMENU="<平台名>"` 启动即展开项目菜单（可指定子菜单）
> - `FLA_ENV="<项目ID>"` 打开环境变量对话框 / `FLA_TERMINAL="<项目ID>"` 打开项目终端
> - `FLA_SETTINGS="1|<分区名>|detect"` 打开设置页（可滚到指定分区，或自动点一次自动检测）
> - `FLA_TEMPLATES` / `FLA_EXAMPLES`
> - `FLA_IMPORT_MENU` / `FLA_SERVICE_MENU="<服务名>"` 展开导入菜单 / 服务右键菜单
> - `FLA_IMPORT_PKG="<package.json>"` / `FLA_IMPORT_COMPOSE="<compose>"` / `FLA_REIMPORT_DOCKER=1`
> - `FLA_RERUN=1` 对恢复的第一个会话触发重跑 / `FLA_DOCTOR_DETAIL` / `FLA_FILING`
> - `FLA_OPEN_LOCATION="<cwd>|<文本>"` 走一遍"点路径"的完整链路（开编辑器 / 系统程序）
> - `FLA_COLLAPSE="<项目id>,<项目id>"` 模拟折叠若干项目（走和点击相同的代码路径）
> - `FLA_OPEN_DIR="<项目id>"` 用编辑器打开该项目目录（等同右键「用编辑器打开目录」）
> - `FLA_TERM_FIND="<文本>"` 打开搜索条并搜这段文字 / `FLA_TERM_DEBUG=clear` 清空当前会话
>   并把清空前后缓冲区行数打到 toast（验证是否真的清掉回滚区）

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
│   ├── src/ops.rs              业务操作（添加项目 / 导入 / 计划拼装），纯函数便于测试
│   ├── src/store.rs            状态读写（原子落盘 / 损坏恢复 / 旧目录迁移）
│   ├── src/atomic.rs           原子写文件（唯一临时文件 + rename 覆盖）
│   ├── src/cache.rs            磁盘缓存（平台矩阵 / 模拟器列表）
│   ├── src/launch.rs           launch.json 解析
│   ├── src/npm.rs              package.json 解析（scripts → 命令、包管理器探测）
│   ├── src/tauri_cli.rs        tauri 转发脚本 → 子命令展开（解析 --help，不硬编码）
│   ├── src/docker.rs           docker-compose 解析（services → 服务动作）
│   ├── src/jsonc.rs            JSONC 状态机（注释 / 尾逗号）
│   ├── src/flutter.rs          Flutter 可执行文件解析与版本探测
│   ├── src/platforms.rs        平台 / 构建目标派生
│   ├── src/terminal.rs         终端选择 / 命令行方言 / 可执行文件解析
│   ├── src/pty.rs              ConPTY 会话（UTF-8 流解码 / DSR 应答 / Job Object）
│   ├── src/daemon.rs           flutter daemon 客户端（设备 / 模拟器 / 热插拔）
│   ├── src/apksig.rs           APK 签名块解析（备案公钥 / MD5）
│   ├── src/doctor.rs           flutter doctor 体检
│   ├── src/bin/pty_probe.rs    ConPTY 诊断探针
│   ├── src/model.rs            数据模型（schemaVersion 6）
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

## 关键约束（勿擅自扩展）

1. **不用 `--machine`**。终端模式与 JSON 模式互斥，走 ConPTY。
2. **不用 pipe 冒充终端**。管道会让 Flutter 降级（无 ANSI、无交互键）。
3. **构建目标动态探测**。Windows 上没有 `ipa` / `macos`。
4. **`.fvmrc` 的 `env` 必须透传**，`flutter` 字段可能是自定义分支名（如 `harmony`）。
5. **任何外部进程都要挂 Job Object**，包括常驻 helper（`flutter daemon`），不只是终端会话。
   判据是"强杀应用后无残留"，不是"代码里写了 `AssignProcessToJobObject`"。
6. **外部程序必须解析成真实可执行文件**。Windows 上 `CreateProcessW("docker")` 会命中
   Docker Desktop 那个无扩展名的 shell 脚本并报 `os error 193`；`npm` 同理（该跑 `npm.cmd`）。
   一律走 `terminal::resolve_executable`。
7. **配置落盘只走 `atomic::write_atomic`**。不要自己写「临时文件 → 删原文件 → 改名」：
   先删后改名会留下"目标文件不存在"的窗口，这期间断电就把配置丢了。
8. **凡是会跑外部进程的命令，必须 `#[tauri::command(async)]`**。Tauri v2 里同步命令
   跑在**主线程**：`flutter doctor`（23 秒）、`flutter devices`、`flutter build --help` ×6
   一旦同步执行，界面就是整段"无响应"，关窗口也会卡住。判据是"界面在命令执行期间能响应"。
9. **v1 不做**分屏 / 同步输入 / 时间戳 / 快捷命令栏；日志不写独立文件（只存 `sessions.json`）。

详见规格 §3.1、§5.3 与 §16。

## 回归验证：无残留外部进程（A35）

新增任何 `spawn` 后跑一次。**必须强杀，不能走正常关闭**——正常关闭会执行 `Drop`，掩盖问题。

```powershell
# 1) 应用运行中，先让 daemon 起来（打开一次设备菜单），确认它在
(Get-CimInstance Win32_Process -Filter "Name='dart.exe'" |
  Where-Object { $_.CommandLine -match 'flutter_tools.snapshot" daemon' }).Count   # 期望 1

# 2) 强杀应用
Get-Process app-deck | Stop-Process -Force
Start-Sleep -Seconds 3

# 3) 再数一次
(Get-CimInstance Win32_Process -Filter "Name='dart.exe'" |
  Where-Object { $_.CommandLine -match 'flutter_tools.snapshot" daemon' }).Count   # 必须 0
```
