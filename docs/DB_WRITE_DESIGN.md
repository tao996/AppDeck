# 应用数据库可写方案设计（sqflite Bridge）

> 状态：设计稿，未实现
> 范围：Flutter 项目、自用开发期、主库 sqflite
> 关联：`src-tauri/src/android_db.rs`（只读快照）、`docs/USAGE.md`「应用数据库」章节

## 0. 结论与范围

现有「数据库…」通过 `adb run-as` 把 db + `-wal` 拉到本机只读打开，能看不能改。要支持修改，走**应用内 HTTP bridge**：

- 在 app 进程里起一个只绑 loopback 的 `HttpServer`；
- 把 app 自己已经打开的 `sqflite` `Database` 交给它；
- AppDeck 通过 `adb forward` 把 PC 端口映射到设备端口，发 SQL。

已确认的前提：

| 项 | 结论 |
|---|---|
| 目标用户 | 只跑自己的项目（开发自己的 app） |
| 侵入性 | 接受新增 pub 依赖 + `main()` 一行 |
| 主数据层 | sqflite |

因此：

- **A 方案（改副本再写回设备）降级为兜底**，只在没接 bridge 时提供，不作为主线；
- **C（VM Service 注入）、D（复用 drift 扩展）不再考虑**；
- 非目标：release 包、第三方 app、iOS 真机、Flutter Web。

## 1. 总体链路

```
AppDeck (Tauri/Rust)
  │  HTTP/1.1  127.0.0.1:<local>
  ▼
adb forward tcp:<local> tcp:58321        ← AppDeck 管理，随会话回收
  │
  ▼
设备 127.0.0.1:58321
  │
  ▼
app 进程内 appdeck_sqlite_bridge (dart:io HttpServer)
  │  同一个 isolate，直接调用
  ▼
app 自己的 sqflite Database（DatabaseExecutor）
  │
  ▼
databases/app.db + -wal
```

关键点：**不复用 run-as 通道做写入**。写全部经 app 自己的连接，锁、WAL、加密、单实例配置天然一致。

## 2. 组件拆分

| 组件 | 位置 | 职责 |
|---|---|---|
| `appdeck_sqlite_bridge` | Flutter 包（本地 path / git 依赖，不发布 pub.dev） | 起服务、鉴权、协议解析、调用 executor、序列化结果 |
| `db_bridge` | `src-tauri/src/db_bridge.rs`（新增） | 建/收 `adb forward`、探测 `/ping`、转发 `/exec`、缓存 token |
| 数据库面板 | `src/main.ts` | 模式徽标、可写 SQL、危险语句确认、写后重启提示 |

## 3. 包的最小 API

只暴露两个入口，其余全内部：

- `AppDeckBridge.attach(executor)`：`executor` 是 `DatabaseExecutor Function()`，sqflite 的 `Database` 本身就是 `DatabaseExecutor`，直接闭包返回即可。
- `AppDeckBridge.start({port, allowWrite, token})`：可选的显式控制，默认参数够用。

约束（写进包文档）：

1. 必须在 `openDatabase` 之后调用，且**与 Database 所在 isolate 相同**（sqflite 的 method channel 绑定主 isolate）。
2. `attach` 只拿 executor，**不自己开库**。理由：SQLCipher 拿不到密钥；双连接在 rollback journal 下会 `SQLITE_BUSY`；app 的 `singleInstance` / `readOnly` 配置会被绕过。
3. 未 `attach` 时不启动，不做任何自动开库的猜测。

## 4. 协议

单版本、单信封。`v` 必须校验，版本不符直接 `426`，避免协议漂移。

### 4.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 能力探测：协议版本、包名、app 版本、是否可写、bridge 版本、sqlite 版本 |
| GET | `/schema` | 表名 + DDL，形状对齐现有 `DbTable` |
| POST | `/exec` | 执行 SQL |

### 4.2 `/exec` 请求

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | int | 协议版本，当前 1 |
| `sql` | string | 单条语句；多语句请用 `statements` |
| `statements` | string[] | 可选，按顺序执行，原子性见 `tx` |
| `params` | any[] | 绑定参数 |
| `tx` | bool | 为 true 时整批包在一个 `db.transaction` 里 |
| `maxRows` | int | 上限，超出置 `truncated` |

### 4.3 `/exec` 响应

| 字段 | 说明 |
|---|---|
| `columns` | 列名；写操作时为 `[]` |
| `rows` | 行数组；值统一为 string/null，BLOB 用 base64 并标记 |
| `changes` | 影响行数；查不到时返回 null |
| `lastId` | INSERT 的 `last_insert_rowid()` |
| `elapsedMs` | 服务端耗时 |
| `truncated` | 是否因 `maxRows` 截断 |

错误统一：`{ error: { code, message, sqliteCode } }`

| code | 含义 |
|---|---|
| `bad_request` | JSON / 字段不合法 |
| `unauthorized` | token 缺失或不匹配 |
| `read_only` | `allowWrite=false` 却收到写语句 |
| `not_attached` | 还没 `attach` |
| `sql_error` | SQLite 报错，带原始 code |
| `busy` | 拿不到锁，可重试 |
| `too_large` | 请求体或结果超过上限 |
| `no_transaction` | `tx` 外层已有事务冲突 |

## 5. sqflite 适配细节

这是整个方案最容易埋坑的地方。

### 5.1 语句分类

`sqflite` 没有"执行任意 SQL 并返回受影响行"的统一入口，必须按首关键字分派：

| 首关键字 | 调用 | 说明 |
|---|---|---|
| `SELECT` / `PRAGMA` / `EXPLAIN` / `WITH` | `rawQuery` | `WITH` 可能是 CTE+SELECT，也可能是 CTE+INSERT，先按查询走 |
| `INSERT` | `rawInsert` | 返回 insertId，再补 `changes()` |
| `UPDATE` / `DELETE` / `REPLACE` / DDL | `rawUpdate` | 返回 changes |
| 其它 | 先按查询，抛错后按写重试一次 | 兜底 `WITH ... INSERT` 这类 |

不要依赖 `RETURNING`：设备自带 SQLite 版本跨度大，3.35 以下没有。

### 5.2 多语句

输入框里粘贴多条语句是常态。规则：

- 客户端（AppDeck）负责按 `;` 拆分，且必须跳过字符串字面量、`--` 与 `/* */` 注释；
- 拆出的数组走 `statements`，**由服务端在同一个事务里执行**，中途失败整批回滚；
- 拆不动（例如触发器里的 `;`）就不要自作聪明，直接报 `bad_request` 并提示加 `BEGIN/END` 不支持的说明。

### 5.3 串行化

包内用一个 FIFO 队列串行处理请求。理由：`sqflite` 内部本来就串行，但 HTTP 并发会让"写后立刻读"看到中间状态，日志也难以解释。串行化后 `/exec` 的语义变成"按到达顺序离开"，调试时心智负担小。

### 5.4 事务

`tx=true` 时用 `db.transaction`。注意：**外层已经有事务时不能嵌套**（sqflite 会抛），返回 `no_transaction` 让 AppDeck 提示用户先提交。

### 5.5 桌面

`sqflite_common_ffi` 的 `Database` 同样实现 `DatabaseExecutor`，所以本包在 Windows/macOS/Linux 桌面 Flutter 上零改动可用，只是不需要 `adb forward`，直接连 `127.0.0.1`。

### 5.6 只读模式

`allowWrite=false` 时：

- 拒绝非查询语句，返回 `read_only`；
- 同时在连接上 `PRAGMA query_only=ON`，双保险（沿用现有快照方案的思路）。

## 6. AppDeck 侧设计

### 6.1 端口

- 设备端口固定 `58321`（设置项可改），方便日志和文档统一；
- 本地端口用 `adb forward tcp:0 tcp:58321`，让 adb 分配并回报，避免撞上 PC 上已占用的端口；
- 多设备/多会话按 serial 分别建 forward，不要共用。

### 6.2 发现

优先级：

1. 从 `flutter run` 的 PTY 输出里抓一行机器可读日志（含 port 与 token）；
2. 抓不到就视为未启用 bridge，降级到快照模式。

**token 只能来自这行日志**，不允许用固定值或猜端口，否则等于给设备上任何 app 开了后门。

### 6.3 状态机

```
snapshot-only ──检测到 bridge 日志──> connecting ──/ping 200──> live
       ▲                                   │                     │
       └────────── 会话结束 / 断连 ─────────┴──── 错误/超时 ───────┘
```

UI 上只需要两态可见：`实时（可写）` / `快照（只读）`，中间态显示"连接中"。

### 6.4 forward 生命周期

必须收干净，否则残留映射会把请求送到别的设备或别的 app：

| 时机 | 动作 |
|---|---|
| 建立 live | `adb -s <serial> forward tcp:0 tcp:58321` |
| 会话结束 / 进程退出 | `adb -s <serial> forward --remove tcp:<local>` |
| 切项目 / 切设备 | 先 remove 再重建 |
| 面板关闭 | 保留（否则每次打开都要重新探测），但会话结束时一定 remove |

### 6.5 实现约束

- 用阻塞式 `std::net::TcpStream` 手写最小 HTTP，或引入 `ureq`。**不要为此引入 tokio**，Tauri 命令本身是同步的。
- 请求超时 5s，`/exec` 单条给 30s（`VACUUM` 之类可能更久，v1 不特殊处理，超时就断开并提示）。
- 亲和：结果里带 `elapsedMs`，前端沿用现有的 `db-status` 显示。

## 7. UI 变更

| 位置 | 变更 |
|---|---|
| 面板标题栏 | 加模式徽标：`实时（可写）` / `快照（只读）` |
| SQL 输入框 | 实时模式下不禁用写；快照模式下保持现有只读提示 |
| 执行按钮 | 快照模式维持「执行（只读）」；实时模式显示受影响行数 |
| 写操作 | 会话内首次写之前自动落一份快照备份（复用 `android_db_export`） |
| 危险语句 | `DROP` / 无 `WHERE` 的 `DELETE`·`UPDATE` / `PRAGMA` 写操作，弹二次确认，显示语句摘要 |
| 写成功后 | 提示条：`已写入 N 行 — 点「重启」让 app 重新查询`，按钮直接复用 `#btn-restart`（`R`） |
| 导出 | 不变 |

「重新加载」(`r`) 不会重跑 `initState` 里的查询，只有「重启」(`R`) 会，所以文案要写"重启"而不是"刷新"。

## 8. 安全

| 措施 | 说明 |
|---|---|
| debug 门禁 | `kDebugMode` + `--dart-define=APPDECK_BRIDGE=1`，release 编译期剔除 |
| token | 每进程随机，请求头 `X-AppDeck-Token`，恒定时间比较 |
| 仅 loopback | `InternetAddress.loopbackIPv4`，禁止 `anyIPv4` |
| forward 清理 | 见 6.4，避免映射残留 |
| 日志脱敏 | token 不写入会话日志文件，只在内存里传递 |
| 危险语句 | 服务端不设白名单（会挡正常调试），确认放前端 |

注意：Android 没有按应用隔离 loopback，同设备其他 app 也能连；token 是唯一有效的隔离手段。

## 9. 错误与边界清单

| 场景 | 表现 | 处理 |
|---|---|---|
| 端口被占用 | bind 失败 | 退到 `0` 随机端口，日志里报实际端口 |
| app 未启动 / 已退出 | connect 拒绝 | 面板转 `快照（只读）`，提示"app 未运行" |
| 没装 bridge | 无日志行 | 降级快照，提示一次性接入步骤 |
| token 过期 | 401 | 重新抓日志，失败则降级 |
| adb 断连 | forward 失效 | 自动重建一次，再失败转快照 |
| `SQLITE_BUSY` | `busy` | 提示重试，不自动重放（写操作自动重放不安全） |
| SQL 语法错误 | `sql_error` | 原样显示 SQLite 消息 + code，保留已输入 SQL |
| 结果过大 | `truncated` | 表格显示前 N 行 + 截断标记，沿用现有分页 |
| BLOB / NULL | 显示差异 | BLOB 显示 `<N bytes>`，可展开 base64；NULL 显示 `NULL` 而非空串 |

## 10. 分阶段与验收

### P1（主线）

1. 包：`attach` + `/ping` + `/schema` + `/exec` + token + 串行队列 + 语句分类。
2. AppDeck：`db_bridge.rs`、forward 建立/回收、日志抓取、状态机、面板徽标。
3. 兜底：无 bridge 时保持现状只读快照，提示接入方式。

验收标准：

- 对一个真实 sqflite 项目 `UPDATE` 一行 → 返回 `changes=1` → 点「重启」后 app 界面看到新值；
- 强杀 app 后重新运行，面板能自动从未连接恢复为实时；
- 断开 USB 再插回，能自动重建 forward 或明确降级；
- 粘贴 3 条语句其中第 2 条失败 → 整批回滚，数据库无变化；
- release 构建（无 define）时端口不存在，`/ping` 不可达。

### P2（后续）

- 写后自动热重启（可开关）；
- schema 变更引导（提醒 app 的 `onUpgrade` 版本号同步）；
- iOS 模拟器与桌面验证；
- 操作审计日志（谁在什么时候改了哪张表）。

## 11. 明确不做

- 不做 release 包上的写入；
- 不做第三方 app 的写入（改不了源码）；
- 不做远程/跨网访问（不绑 `0.0.0.0`，不做鉴权体系，token 就够）；
- 不做 SQL 自动补全、ER 图等编辑器功能；
- 不做自动改用户源码（接入靠复制一段 snippet）。
