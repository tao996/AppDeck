/* ============================================================
   AppDeck — Core（由 main.ts 拆分而来）
   ============================================================ */

import { invoke } from "@tauri-apps/api/core";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";

/* ============================================================
   AppDeck — M2：ConPTY 终端
   ============================================================ */

/** 产品名：与 tauri.conf.json 的 productName、Cargo 包名保持一致 */
export const APP_NAME = "AppDeck";

/** 前端打包时间由 vite.config.ts 的 define 在 settings.ts 中注入 */

// harmony：鸿蒙工程改用 flutter_flutter 分支（后端 resolve_for_project 的返回值）
export type FlutterSource = "fvm" | "custom" | "path" | "harmony" | "none";
export type SessionStatus = "starting" | "running" | "stopped";

export interface Cmd {
  id: string;
  name: string;
  kind: string;
  program?: string | null;
  cwd?: string | null;
  flutterMode?: string | null;
  args: string[];
  env: Record<string, string>;
  toolArgs: string[];
  deviceId?: string | null;
  emulatorId?: string | null;
  buildType?: string | null;
  source?: string | null;
  scope?: string | null;
  /** npm 命令对应的脚本已从 package.json 移除 */
  stale?: boolean;
  /** docker 服务名：同组命令折叠成一个服务节点 */
  group?: string | null;
  /** 组内角色：up | stop | restart | rm | logs | shell | up-all | logs-all | down */
  role?: string | null;
  /** 模板分类：flutter | npm | docker | custom（只对全局模板有意义） */
  category?: string | null;
}

/** 模板分类顺序与显示名 */
export const CATEGORY_ORDER = ["flutter", "npm", "docker", "custom"] as const;
export const CATEGORY_LABEL: Record<string, string> = {
  flutter: "Flutter",
  npm: "npm",
  docker: "Docker",
  custom: "其他",
};

/**
 * 模板属于哪个分类：显式 category 优先，否则按 program/args 推断。
 * 推断规则与后端 ops::template_category 保持一致。
 */
export function templateCategory(t: Cmd): string {
  const explicit = (t.category ?? "").trim().toLowerCase();
  if (explicit in CATEGORY_LABEL) return explicit;

  const hay = `${t.program ?? ""} ${(t.args ?? []).join(" ")}`.toLowerCase();
  if (hay.includes("%flutter%") || hay.startsWith("flutter") || hay.includes(" flutter ")) {
    return "flutter";
  }
  if (["npm", "pnpm", "yarn", "node"].some((k) => hay.includes(k))) return "npm";
  if (hay.includes("docker")) return "docker";
  return "custom";
}

export interface Proj {
  id: string;
  name: string;
  path: string;
  kind: string;
  commands: Cmd[];
  /** 项目级环境变量（仅鸿蒙工程注入） */
  env?: Record<string, string>;
}

export interface SettingsModel {
  flutterTool: { mode: string; customPath: string | null };
  window: {
    /** quit | tray —— 点关闭按钮时：退出程序 / 最小化到托盘 */
    closeBehavior: string;
  };
  android: {
    sdkPath: string | null;
    emulatorPath: string | null;
    avdPath: string | null;
    buildToolsPath: string | null;
    keytoolPath: string | null;
  };
  harmony: {
    emulatorPath: string | null;
    instancePath: string | null;
    imageRoot: string | null;
    flutterPath: string | null;
    sdkPath: string | null;
    /** 全局鸿蒙环境变量（仅注入有 ohos/ 的工程） */
    env: Record<string, string>;
  };
  terminal: {
    /** 终端可执行文件；留空自动探测 */
    path: string | null;
    /** 输出过滤规则（只对 Flutter 终端生效） */
    filters: OutputFilter[];
  };
  npm: {
    /** auto | npm | pnpm | yarn */
    manager: string | null;
    nodePath: string | null;
  };
  docker: {
    dockerPath: string | null;
    /** auto | v2 | v1 */
    composeStyle: string | null;
  };
  editor: {
    /** 编辑器 exe 的完整路径（Code.exe / zed.exe / sublime_text.exe…）；留空自动探测 */
    path: string | null;
  };
  git: {
    /** Git 桌面客户端（GitHub Desktop 等）exe 路径；留空则项目右键不显示入口 */
    desktopPath: string | null;
  };
}

/** 项目目录里可编辑的配置文件（后端 project_files） */
export interface ProjectFiles {
  packageJson: string | null;
  /** compose 文件的完整路径（名字可能是 .yml / .yaml / compose.*） */
  compose: string | null;
  /** 有没有 Android 工程（决定是否显示「数据库…」） */
  android: boolean;
  /** 是不是 Qt / CMake 工程（CMakeLists.txt / CMakePresets.json / *.pro） */
  qt: boolean;
  /** CMakePresets.json 的完整路径（有就显示「编辑」） */
  cmakePresets: string | null;
}

/** 用默认编辑器打开一个文件 */
export async function editFile(path: string): Promise<void> {
  try {
    await invoke("open_in_editor", { path, line: null, col: null });
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 在资源管理器中打开一个文件夹（直接进入该目录，而不是在父目录里选中它）。
 *  走 `open_path_default` 而不是 opener 插件的 `openPath`：后者需要路径 scope，
 *  项目目录可能在任意盘符，运行时会被拒（Not allowed to open path）。 */
export async function openInFileExplorer(path: string): Promise<void> {
  try {
    await invoke("open_path_default", { path });
  } catch (e) {
    toast(`打开文件管理器失败：${String(e)}`, "error");
  }
}

/** 用默认编辑器打开本会话的项目目录（整目录当工作区打开） */
export async function openProjectFolder(): Promise<void> {
  const s = activeSession();
  if (!s?.cwd) return;
  try {
    await invoke("open_in_editor", { path: s.cwd, line: null, col: null });
  } catch (e) {
    toast(String(e), "error");
  }
}
/** 终端里一处"位置"的解析结果（后端 locate::Location） */
export interface Location {
  raw: string;
  path: string | null;
  exists: boolean;
  /** 源码类：用编辑器打开并跳行列；否则交给系统默认程序 */
  code: boolean;
  line: number | null;
  col: number | null;
}

export interface Detected {
  android: SettingsModel["android"];
  harmony: SettingsModel["harmony"];
  flutter: string | null;
  harmonyVersion: string | null;
  npm: SettingsModel["npm"];
  docker: SettingsModel["docker"];
  editor: SettingsModel["editor"];
  git: SettingsModel["git"];
  notes: string[];
}

export interface EmulatorEntry {
  id: string;
  name: string;
  detail: string;
  kind: string;
}

export interface PlatformAction {
  action: string;
  /** 菜单里直接显示的真实命令，如 flutter run --debug */
  command: string;
  label: string;
  target?: string | null;
  enabled: boolean;
  reason?: string | null;
}

export interface PlatformEntry {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string | null;
  actions: PlatformAction[];
  /** 该平台会用的设备，如 "23049RAD8C (daf3c642)"；没有设备时为空 */
  device?: string | null;
}

export interface PlatformMatrix {
  platforms: PlatformEntry[];
  supported: boolean;
  note?: string | null;
}

export interface FilingInfo {
  apk: string;
  appLabel?: string | null;
  package?: string | null;
  versionName?: string | null;
  versionCode?: string | null;
  minSdk?: string | null;
  targetSdk?: string | null;
  md5?: string | null;
  sha1?: string | null;
  sha256?: string | null;
  dn?: string | null;
  scheme?: string | null;
  publicKey?: string | null;
  warnings: string[];
  error?: string | null;
}

export interface AllEmulators {
  android: EmulatorEntry[];
  harmony: EmulatorEntry[];
  /** 已连接的真机（手机 / 桌面 / 浏览器）；后端每次现查，不缓存 */
  devices?: ConnectedDevice[];
  /** 上面这份设备列表的查询时间（毫秒时间戳） */
  devicesAt?: number;
  notes: string[];
}

/** 已连接设备（daemon 的 device.getDevices） */
export interface ConnectedDevice {
  id: string;
  name: string;
  platform?: string | null;
  platformType?: string | null;
  category?: string | null;
  emulator?: boolean;
  sdk?: string | null;
  isConnected?: boolean | null;
}

/** 工具栏自定义命令（全局，不绑定项目） */
export interface CustomCommand {
  id: string;
  name: string;
  /** 用户选择的 .lnk / .exe */
  program: string;
  /** 快捷方式解析出的真实 exe */
  target: string | null;
  /** 原始命令行参数（快捷方式参数也在这里） */
  args: string;
  cwd: string | null;
  /** 启动时注入的环境变量（原样注入，不展开 %VAR%） */
  env?: Record<string, string>;
}

/** 循环任务的目标命令：程序 + 参数 + 工作目录 */
export interface ScheduledCommand {
  program: string;
  /** 参数原文：空格分隔，双引号内的空格保留 */
  args: string;
  cwd: string | null;
}

/** 一条循环任务（crontab 的一行） */
export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  /** 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）cron */
  cron: string;
  command: ScheduledCommand;
  /** always | onFailure | never */
  notify: string;
  /** skip | queue | kill */
  overlap: string;
  /** skip | once */
  catchUp: string;
  timeoutSecs: number;
  createdAt: number;
}

/** 列表视图：配置 + 运行态 */
export interface ScheduledTaskView extends ScheduledTask {
  nextAt: number;
  nextRuns: number[];
  nextError: string | null;
  running: boolean;
  lastStatus: string | null;
  lastExitCode: number | null;
  lastMs: number;
  lastRunId: string | null;
}

export interface ScheduleRunEvent {
  taskId: string;
  taskName: string;
  runId: string;
  status: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number;
  notify: string;
  manual: boolean;
  reason: string | null;
}

export interface State {
  schemaVersion: number;
  settings: SettingsModel;
  projects: Proj[];
  commandTemplates: Cmd[];
  /** 工具栏自定义命令 */
  customCommands?: CustomCommand[];
  /** 循环任务（工具 → 循环任务） */
  scheduledTasks?: ScheduledTask[];
  /** 纯界面状态：项目折叠、进程面板偏好等 */
  ui?: {
    collapsedProjects?: string[];
    /** 进程面板隐藏规则：程序名包含任一规则就不显示 */
    processHideRules?: string[];
    /** 隐藏规则是否生效（缺省视为启用） */
    processHideRulesEnabled?: boolean;
    /** 进程面板是否自动刷新（缺省视为开启） */
    processAutoRefresh?: boolean;
  };
}

export function defaultSettings(): SettingsModel {
  return {
    flutterTool: { mode: "auto", customPath: null },
    window: { closeBehavior: "quit" },
    android: {
      sdkPath: null,
      emulatorPath: null,
      avdPath: null,
      buildToolsPath: null,
      keytoolPath: null,
    },
    harmony: {
      emulatorPath: null,
      instancePath: null,
      imageRoot: null,
      flutterPath: null,
      sdkPath: null,
      env: {},
    },
    terminal: { path: null, filters: [] },
    npm: { manager: null, nodePath: null },
    docker: { dockerPath: null, composeStyle: null },
    editor: { path: null },
    git: { desktopPath: null },
  };
}

export interface FlutterInfo {
  ok: boolean;
  version: string | null;
  channel: string | null;
  dart: string | null;
  executable: string | null;
  source: FlutterSource;
  /** .fvmrc 声明的 flutter 版本别名（如 harmony） */
  fvmVersion?: string | null;
  error: string | null;
}

export interface ImportResponse {
  state: State;
  total: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

export interface StartResponse {
  id: string;
  pid: number;
  title: string;
  device: string;
  cwd: string;
  program: string;
  args: string[];
  /** 预填到终端提示符、不回车（按 Enter 才执行） */
  prefill?: string | null;
  /** 复用了已有终端（前端只要聚焦，不新建标签） */
  reused?: boolean | null;
}

export interface DevAutostart {
  projectId: string;
  commandId: string;
  deviceId: string | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform?: string | null;
  category?: string | null;
  emulator: boolean;
  sdk?: string | null;
  isConnected?: boolean | null;
}

export interface EmulatorInfo {
  id: string;
  name: string;
  category?: string | null;
}

export interface DevicesPayload {
  devices: DeviceInfo[];
  emulators: EmulatorInfo[];
}

export interface TermSession {
  id: string;
  title: string;
  device: string;
  /** 会话根进程 PID（恢复自磁盘的会话没有） */
  pid?: number;
  mode: string;
  kind: string;
  cwd: string;
  artifacts: string[];
  status: SessionStatus;
  exitCode?: number | null;
  devToolsUrl?: string;
  /** 用于跨数据块匹配锚点的滚动窗口 */
  scan: string;
  /** 命令来源（npm / docker / launch-json…）：区分「外部程序 run」和 flutter run */
  source?: string;
  /** 按外部程序执行的 run 会话（含 source 被旧版本写坏的命令），见 isExternalCommand */
  external?: boolean;
  /** 检测 cmd 批处理提示用的滚动尾巴（跨数据块拼接提示文本） */
  promptTail?: string;
  /** 恢复自磁盘（进程未运行，禁止写 PTY） */
  restored?: boolean;
  /** run 会话里 flutter 是否正在运行（决定热重载工具条显不显示） */
  flutterRunning?: boolean;
  projectId?: string;
  commandId?: string;
  templateId?: string;
  /** 工具栏自定义命令：重跑/恢复用 */
  customCommandId?: string;
  /** 派生动作来源（平台菜单）：重跑时按平台重新解析设备 */
  platform?: string;
  action?: string;
  target?: string;
  term?: Terminal;
  fit?: FitAddon;
  serialize?: SerializeAddon;
  /** 日志搜索（Ctrl+F）；每个会话各一份，切换 tab 时只操作当前会话的 */
  search?: SearchAddon;
  pane?: HTMLDivElement;
  /** 工具条「过滤」开关（按会话，默认关；只对新输出生效） */
  filterEnabled?: boolean;
  /** 跨数据块拼行的暂存尾巴（仅过滤开启时有值） */
  filterCarry?: string;
}

/** 终端输出过滤规则（显示层，只影响写进 xterm 的新输出） */
export interface OutputFilter {
  mode: string; // contain | prefix
  pattern: string;
  scope: string; // none | flutter
  enabled: boolean;
}

export interface BuildTarget {
  name: string;
  description: string;
  supportsFlavor: boolean;
}

/** 后端 preview_script_command 的返回：导入脚本时填表单用 */
export interface ScriptPreview {
  name: string;
  kind: string;
  program: string;
  args: string[];
  /** 脚本所在目录（项目内是相对路径，项目外是绝对路径） */
  cwd: string | null;
  /** 用了哪个解释器 / 虚拟环境 */
  note: string;
  /** 识别到的 venv 根目录（仅 .py） */
  venv: string | null;
  /** 可选的 venv 列表（给下拉用） */
  venvs: Array<{ label: string; dir: string; python: string }>;
}

export let state: State = {
  schemaVersion: 7,
  settings: defaultSettings(),
  projects: [],
  commandTemplates: [],
  customCommands: [],
  scheduledTasks: [],
  ui: {
    collapsedProjects: [],
    processHideRules: [],
    processHideRulesEnabled: true,
    processAutoRefresh: true,
  },
};
export const flutterInfo = new Map<string, FlutterInfo>();
export const collapsed = new Set<string>();

/** 折叠状态落盘：连点几下只写一次盘 */
export let collapseSaveTimer: number | null = null;
export function scheduleSaveCollapsed(): void {
  if (collapseSaveTimer !== null) window.clearTimeout(collapseSaveTimer);
  collapseSaveTimer = window.setTimeout(() => {
    collapseSaveTimer = null;
    void invoke("save_collapsed_projects", { ids: [...collapsed] }).catch(() => undefined);
  }, 300);
}

export let selectedCommand: string | null = null;
export let statePath = "";

export const sessions: TermSession[] = [];
export const pendingOutput = new Map<string, string[]>();
export let activeSessionId: string | null = null;

/* 循环任务面板（作为 tabstrip 里的一个非终端 tab） */
export let scheduleTabOpen = false;
export let scheduleTabActive = false;
export let scheduleSelectedId: string | null = null;
export let schedulePaneTasks: ScheduledTaskView[] = [];
export let schedulePaneTimer: number | null = null;
export let schedulePaneReady = false;
export let schedulePaneBusy = false;
export let schedulePaneTick = 0;
export let schedulePaneLogText = "";
export let scheduleLogQuery = "";
export let scheduleLogMatches: number[] = [];
export let scheduleLogMatchIndex = -1;
export let scheduleLogHitsCapped = false;
export let scheduleLogJumpNext = false;

/* ---------------- 工具 ---------------- */

export function req<T extends Element>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error("element not found: " + sel);
  return el as T;
}

export function esc(s: string): string {
  // 防御：后端新增枚举值时不能让整个项目树渲染中断（踩过：source 加了 harmony，
  // SOURCE_TEXT 没跟上，esc(undefined) 抛错导致后面的项目全部不渲染）
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );
}

export function toast(msg: string, kind: "info" | "error" = "info"): void {
  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " error" : "");

  // 错误必须能看清、能复制：错误提示不自动消失，带「复制」「关闭」，文本可选中。
  // 有些报错很长（CreateProcessW 会把完整命令行打出来），必须能整段复制走。
  if (kind === "error") {
    t.classList.add("pinned");

    const text = document.createElement("div");
    text.className = "toast-text";
    text.textContent = msg;

    const bar = document.createElement("div");
    bar.className = "toast-bar";

    const copy = document.createElement("button");
    copy.className = "toast-btn";
    copy.textContent = "复制";
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        try {
          await navigator.clipboard.writeText(msg);
          copy.textContent = "已复制";
          window.setTimeout(() => (copy.textContent = "复制"), 1200);
        } catch {
          // 剪贴板不可用时：选中文本 + 再试一次 execCommand，实在不行用户 Ctrl+C
          const range = document.createRange();
          range.selectNodeContents(text);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          try {
            document.execCommand("copy");
            copy.textContent = "已复制";
            window.setTimeout(() => (copy.textContent = "复制"), 1200);
          } catch {
            /* 交给用户手动复制 */
          }
        }
      })();
    });

    const close = document.createElement("button");
    close.className = "toast-btn";
    close.textContent = "关闭";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      t.classList.remove("show");
      window.setTimeout(() => t.remove(), 200);
    });

    bar.append(copy, close);
    t.append(text, bar);
  } else {
    t.textContent = msg;
  }

  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));

  // 只有普通提示自动消失；错误留着，直到用户点关闭
  if (kind !== "error") {
    window.setTimeout(() => {
      t.classList.remove("show");
      window.setTimeout(() => t.remove(), 220);
    }, 2400);
  }
}

export const SOURCE_TEXT: Record<FlutterSource, string> = {
  fvm: "FVM",
  custom: "自定义",
  path: "PATH",
  harmony: "鸿蒙",
  none: "未检测",
};

export const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
};

/* ---------------- 终端主题 ---------------- */

export const termTheme = {
  background: "#0f1115",
  foreground: "#c8d0da",
  cursor: "#4a9eff",
  cursorAccent: "#0f1115",
  selectionBackground: "#2a3a52",
  black: "#1a1d24",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#4a9eff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c8d0da",
  brightBlack: "#5a6472",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/* ---------------- 会话 ---------------- */

export function activeSession(): TermSession | undefined {
  // 循环任务 tab 激活时没有「当前终端会话」：工具栏的控制按钮应全部失焦
  if (scheduleTabActive) return undefined;
  return sessions.find((s) => s.id === activeSessionId);
}

/** 终端区域与循环任务面板互斥显示（循环任务 tab 占满标签下方的区域） */
export function showSchedulePane(show: boolean): void {
  const main = document.querySelector<HTMLElement>(".main");
  const pane = document.querySelector<HTMLElement>("#schedule-pane");
  if (main) main.style.display = show ? "none" : "";
  if (pane) pane.style.display = show ? "flex" : "none";
}

/* ---------------- 日志搜索 / 清空 ---------------- */

/** 命中高亮配色：暗黄=其他命中，亮黄边框=当前命中 */

// ---- 跨模块状态写入器（拆分脚本生成） ----
export function setActiveSessionId(v: typeof activeSessionId): void { activeSessionId = v; }
export function setScheduleLogHitsCapped(v: typeof scheduleLogHitsCapped): void { scheduleLogHitsCapped = v; }
export function setScheduleLogJumpNext(v: typeof scheduleLogJumpNext): void { scheduleLogJumpNext = v; }
export function setScheduleLogMatchIndex(v: typeof scheduleLogMatchIndex): void { scheduleLogMatchIndex = v; }
export function setScheduleLogMatches(v: typeof scheduleLogMatches): void { scheduleLogMatches = v; }
export function setScheduleLogQuery(v: typeof scheduleLogQuery): void { scheduleLogQuery = v; }
export function setSchedulePaneBusy(v: typeof schedulePaneBusy): void { schedulePaneBusy = v; }
export function setSchedulePaneLogText(v: typeof schedulePaneLogText): void { schedulePaneLogText = v; }
export function setSchedulePaneReady(v: typeof schedulePaneReady): void { schedulePaneReady = v; }
export function setSchedulePaneTasks(v: typeof schedulePaneTasks): void { schedulePaneTasks = v; }
export function setSchedulePaneTimer(v: typeof schedulePaneTimer): void { schedulePaneTimer = v; }
export function setSchedulePaneTick(v: typeof schedulePaneTick): void { schedulePaneTick = v; }
export function setScheduleSelectedId(v: typeof scheduleSelectedId): void { scheduleSelectedId = v; }
export function setScheduleTabActive(v: typeof scheduleTabActive): void { scheduleTabActive = v; }
export function setScheduleTabOpen(v: typeof scheduleTabOpen): void { scheduleTabOpen = v; }
export function setSelectedCommand(v: typeof selectedCommand): void { selectedCommand = v; }
export function setState(v: typeof state): void { state = v; }
export function setStatePath(v: typeof statePath): void { statePath = v; }
