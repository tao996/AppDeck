import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, confirm, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { openProcessManager } from "./process-manager";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

/* ============================================================
   AppDeck — M2：ConPTY 终端
   ============================================================ */

/** 产品名：与 tauri.conf.json 的 productName、Cargo 包名保持一致 */
const APP_NAME = "AppDeck";

/** 前端打包时间（vite.config.ts 的 define 注入）；与 exe mtime 取较大值 */
declare const __BUILD_TIME__: string;

// harmony：鸿蒙工程改用 flutter_flutter 分支（后端 resolve_for_project 的返回值）
type FlutterSource = "fvm" | "custom" | "path" | "harmony" | "none";
type SessionStatus = "starting" | "running" | "stopped";

interface Cmd {
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
const CATEGORY_ORDER = ["flutter", "npm", "docker", "custom"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  flutter: "Flutter",
  npm: "npm",
  docker: "Docker",
  custom: "其他",
};

/**
 * 模板属于哪个分类：显式 category 优先，否则按 program/args 推断。
 * 推断规则与后端 ops::template_category 保持一致。
 */
function templateCategory(t: Cmd): string {
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

interface Proj {
  id: string;
  name: string;
  path: string;
  kind: string;
  commands: Cmd[];
  /** 项目级环境变量（仅鸿蒙工程注入） */
  env?: Record<string, string>;
}

interface SettingsModel {
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
interface ProjectFiles {
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
async function editFile(path: string): Promise<void> {
  try {
    await invoke("open_in_editor", { path, line: null, col: null });
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 在资源管理器中打开一个文件夹（直接进入该目录，而不是在父目录里选中它）。
 *  走 `open_path_default` 而不是 opener 插件的 `openPath`：后者需要路径 scope，
 *  项目目录可能在任意盘符，运行时会被拒（Not allowed to open path）。 */
async function openInFileExplorer(path: string): Promise<void> {
  try {
    await invoke("open_path_default", { path });
  } catch (e) {
    toast(`打开文件管理器失败：${String(e)}`, "error");
  }
}

/** 用默认编辑器打开本会话的项目目录（整目录当工作区打开） */
async function openProjectFolder(): Promise<void> {
  const s = activeSession();
  if (!s?.cwd) return;
  try {
    await invoke("open_in_editor", { path: s.cwd, line: null, col: null });
  } catch (e) {
    toast(String(e), "error");
  }
}
/** 终端里一处"位置"的解析结果（后端 locate::Location） */
interface Location {
  raw: string;
  path: string | null;
  exists: boolean;
  /** 源码类：用编辑器打开并跳行列；否则交给系统默认程序 */
  code: boolean;
  line: number | null;
  col: number | null;
}

interface Detected {
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

interface EmulatorEntry {
  id: string;
  name: string;
  detail: string;
  kind: string;
}

interface PlatformAction {
  action: string;
  /** 菜单里直接显示的真实命令，如 flutter run --debug */
  command: string;
  label: string;
  target?: string | null;
  enabled: boolean;
  reason?: string | null;
}

interface PlatformEntry {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string | null;
  actions: PlatformAction[];
  /** 该平台会用的设备，如 "23049RAD8C (daf3c642)"；没有设备时为空 */
  device?: string | null;
}

interface PlatformMatrix {
  platforms: PlatformEntry[];
  supported: boolean;
  note?: string | null;
}

interface FilingInfo {
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

interface AllEmulators {
  android: EmulatorEntry[];
  harmony: EmulatorEntry[];
  /** 已连接的真机（手机 / 桌面 / 浏览器）；后端每次现查，不缓存 */
  devices?: ConnectedDevice[];
  /** 上面这份设备列表的查询时间（毫秒时间戳） */
  devicesAt?: number;
  notes: string[];
}

/** 已连接设备（daemon 的 device.getDevices） */
interface ConnectedDevice {
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
interface CustomCommand {
  id: string;
  name: string;
  /** 用户选择的 .lnk / .exe */
  program: string;
  /** 快捷方式解析出的真实 exe */
  target: string | null;
  /** 原始命令行参数（快捷方式参数也在这里） */
  args: string;
  cwd: string | null;
}

interface State {
  schemaVersion: number;
  settings: SettingsModel;
  projects: Proj[];
  commandTemplates: Cmd[];
  /** 工具栏自定义命令 */
  customCommands?: CustomCommand[];
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

function defaultSettings(): SettingsModel {
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
    terminal: { path: null },
    npm: { manager: null, nodePath: null },
    docker: { dockerPath: null, composeStyle: null },
    editor: { path: null },
    git: { desktopPath: null },
  };
}

interface FlutterInfo {
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

interface ImportResponse {
  state: State;
  total: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

interface StartResponse {
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

interface DevAutostart {
  projectId: string;
  commandId: string;
  deviceId: string | null;
}

interface DeviceInfo {
  id: string;
  name: string;
  platform?: string | null;
  category?: string | null;
  emulator: boolean;
  sdk?: string | null;
  isConnected?: boolean | null;
}

interface EmulatorInfo {
  id: string;
  name: string;
  category?: string | null;
}

interface DevicesPayload {
  devices: DeviceInfo[];
  emulators: EmulatorInfo[];
}

interface TermSession {
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
}

interface BuildTarget {
  name: string;
  description: string;
  supportsFlavor: boolean;
}

let state: State = {
  schemaVersion: 4,
  settings: defaultSettings(),
  projects: [],
  commandTemplates: [],
  customCommands: [],
  ui: {
    collapsedProjects: [],
    processHideRules: [],
    processHideRulesEnabled: true,
    processAutoRefresh: true,
  },
};
const flutterInfo = new Map<string, FlutterInfo>();
const collapsed = new Set<string>();

/** 折叠状态落盘：连点几下只写一次盘 */
let collapseSaveTimer: number | null = null;
function scheduleSaveCollapsed(): void {
  if (collapseSaveTimer !== null) window.clearTimeout(collapseSaveTimer);
  collapseSaveTimer = window.setTimeout(() => {
    collapseSaveTimer = null;
    void invoke("save_collapsed_projects", { ids: [...collapsed] }).catch(() => undefined);
  }, 300);
}

let selectedCommand: string | null = null;
let statePath = "";

const sessions: TermSession[] = [];
const pendingOutput = new Map<string, string[]>();
let activeSessionId: string | null = null;

/* ---------------- 工具 ---------------- */

function req<T extends Element>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error("element not found: " + sel);
  return el as T;
}

function esc(s: string): string {
  // 防御：后端新增枚举值时不能让整个项目树渲染中断（踩过：source 加了 harmony，
  // SOURCE_TEXT 没跟上，esc(undefined) 抛错导致后面的项目全部不渲染）
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );
}

function toast(msg: string, kind: "info" | "error" = "info"): void {
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

const SOURCE_TEXT: Record<FlutterSource, string> = {
  fvm: "FVM",
  custom: "自定义",
  path: "PATH",
  harmony: "鸿蒙",
  none: "未检测",
};

const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
};

/* ---------------- 终端主题 ---------------- */

const termTheme = {
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

function activeSession(): TermSession | undefined {
  return sessions.find((s) => s.id === activeSessionId);
}

/* ---------------- 日志搜索 / 清空 ---------------- */

/** 命中高亮配色：暗黄=其他命中，亮黄边框=当前命中 */
const SEARCH_DECORATIONS = {
  matchBackground: "#4a3d00",
  matchBorder: "#7a6500",
  matchOverviewRuler: "#7a6500",
  activeMatchBackground: "#b8860b",
  activeMatchBorder: "#ffd166",
  activeMatchColorOverviewRuler: "#ffd166",
};

function renderSearchCount(index: number, count: number): void {
  const el = req<HTMLSpanElement>("#term-search-count");
  if (count <= 0) {
    el.textContent = "0 个";
    el.classList.add("none");
    return;
  }
  el.classList.remove("none");
  // index === -1：命中过多（超过上限），只报总数
  el.textContent = index < 0 ? `${count}+ 个` : `${index + 1}/${count}`;
}

function runSearch(forward: boolean): void {
  const s = activeSession();
  const input = req<HTMLInputElement>("#term-search-input");
  const q = input.value;

  if (!s?.search || !q) {
    s?.search?.clearDecorations();
    renderSearchCount(0, 0);
    return;
  }

  const opts = { caseSensitive: false, decorations: SEARCH_DECORATIONS };
  if (forward) s.search.findNext(q, opts);
  else s.search.findPrevious(q, opts);
}

function openSearch(): void {
  const s = activeSession();
  if (!s?.term) return;

  const bar = req<HTMLDivElement>("#term-search");
  const input = req<HTMLInputElement>("#term-search-input");
  bar.hidden = false;

  // 有选中文字就直接搜它（只取单行）
  const sel = s.term.getSelection().trim();
  if (sel && !sel.includes("\n")) input.value = sel;

  input.focus();
  input.select();
  runSearch(true);
}

function closeSearch(): void {
  const bar = req<HTMLDivElement>("#term-search");
  if (bar.hidden) return;
  bar.hidden = true;
  activeSession()?.search?.clearDecorations();
  renderSearchCount(0, 0);
  activeSession()?.term?.focus();
}

/** 真正清空日志：xterm 整个缓冲区（含回滚区）+ 立即覆盖落盘 */
async function clearActiveLog(): Promise<void> {
  const s = activeSession();
  if (!s?.term) return;

  s.term.clear();
  s.search?.clearDecorations();
  renderSearchCount(0, 0);

  // 只清显示、不动进程；但落盘的那份必须一起清，否则重启又回来了
  await persistSessions();
  toast("已清空日志");
}

/* ---------------- 终端里可点击的位置 ---------------- */

/** 解析结果缓存：同一条日志反复悬停不该反复问后端 */
const locateCache = new Map<string, Location | null>();

async function locateAt(cwd: string, text: string): Promise<Location | null> {
  const key = `${cwd}\u0000${text}`;
  const hit = locateCache.get(key);
  if (hit !== undefined) return hit;

  let res: Location | null = null;
  try {
    res = await invoke<Location | null>("resolve_location", { cwd, text });
  } catch {
    res = null;
  }
  if (locateCache.size > 400) locateCache.clear();
  locateCache.set(key, res);
  return res;
}

/** 打开一处位置：源码交给默认编辑器跳行列，其他交给系统默认程序 */
async function openLocation(cwd: string, raw: string): Promise<void> {
  const loc = await locateAt(cwd, raw);
  if (!loc?.path) {
    toast(`无法解析路径：${raw}`, "error");
    return;
  }
  if (!loc.exists) {
    toast(`文件不存在：${loc.path}`, "error");
    return;
  }

  if (loc.code) {
    try {
      await invoke("open_in_editor", { path: loc.path, line: loc.line, col: loc.col });
    } catch (e) {
      toast(String(e), "error");
    }
    return;
  }

  try {
    await invoke("open_path_default", { path: loc.path });
  } catch (e) {
    toast(String(e), "error");
  }
}

async function revealLocation(cwd: string, raw: string): Promise<void> {
  const loc = await locateAt(cwd, raw);
  if (!loc?.path) {
    toast(`无法解析路径：${raw}`, "error");
    return;
  }
  if (!loc.exists) {
    toast(`文件不存在：${loc.path}`, "error");
    return;
  }
  try {
    await revealItemInDir(loc.path);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 网址走系统浏览器；其余仍按磁盘位置处理 */
async function openLinkText(cwd: string, raw: string): Promise<void> {
  if (!isUrlText(raw)) {
    await openLocation(cwd, raw);
    return;
  }
  const url = browserUrl(raw);
  try {
    await openUrl(url);
  } catch (e) {
    toast(`无法打开链接：${url}\n${String(e)}`, "error");
  }
}

/** 把一行的字符下标映射到终端列号（CJK 宽字符占两格，不能按字符数直接算） */
function mapLine(term: Terminal, y: number): { text: string; xs: number[] } | null {
  const line = term.buffer.active.getLine(y - 1);
  if (!line) return null;

  let text = "";
  const xs: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // 宽字符的尾格
    const chars = cell.getChars();
    const s = chars && chars.length ? chars : " ";
    for (let i = 0; i < s.length; i++) xs.push(x + 1);
    text += s;
  }
  return { text, xs };
}

/** 网址：终端里 flutter / vite 输出的访问地址，用浏览器打开 */
const URL_PATTERNS: RegExp[] = [
  /\b(?:https?|ftp):\/\/[^\s"'<>|\u3000]+/gi,
  // 没写协议的本地地址：localhost:8080、127.0.0.1:3000
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})(?:\/[^\s"'<>|]*)?/gi,
];

/** 候选：`package:` URI、盘符绝对路径（行尾的 :行:列 由后端拆） */
const LOCATE_PATTERNS: RegExp[] = [
  /package:[A-Za-z0-9_]+\/[^\s"'<>|]+/g,
  // 前缀捕获而不是 lookbehind：盘符前不能紧邻字母/数字/+-.
  // 否则 `https://host` 里的 `s://` 会被当成 S 盘，解析成 `s:\host` 再提示"文件不存在"
  /(^|[^A-Za-z0-9+.\-])([A-Za-z]:[\\/][^\s"'<>|]+)/g,
];

/** 行尾标点不该算进链接（`path.txt,`、`http://a.cn）。`） */
function trimLinkTail(raw: string): string {
  return raw.replace(/[,\u3002\uff09)\]]+$/, "");
}

/** 网址再额外去掉句末的英文句点（`访问 https://a.cn.` 里的点不属于域名） */
function trimUrlTail(raw: string): string {
  return trimLinkTail(raw).replace(/\.+$/, "");
}

/** 是否是网址（含不带协议的 localhost:端口） */
function isUrlText(raw: string): boolean {
  return (
    /^(?:https?|ftp):\/\//i.test(raw) ||
    /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d/i.test(raw)
  );
}

/** 交给浏览器的地址：没写协议时补 http:// */
function browserUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

let linkMenuEl: HTMLDivElement | null = null;

/** 300ms 内同样的位置只打开一次：xterm 的 activate 和自己的 click 监听可能同时触发 */
let lastOpen = { key: "", at: 0 };
function openOnce(cwd: string, raw: string): void {
  const key = `${cwd}\u0000${raw}`;
  const now = Date.now();
  if (lastOpen.key === key && now - lastOpen.at < 300) return;
  lastOpen = { key, at: now };
  void openLinkText(cwd, raw);
}

function closeLinkMenu(): void {
  linkMenuEl?.remove();
  linkMenuEl = null;
}

function showLinkMenu(ev: MouseEvent, cwd: string, raw: string): void {
  closeLinkMenu();
  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - 340))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - 170))}px`;
  menu.innerHTML = `<div class="dm-head">${esc(raw)}</div><div class="dm-body"></div>`;
  document.body.appendChild(menu);
  linkMenuEl = menu;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;
  const item = (name: string, sub: string, fn: () => void): void => {
    const el = document.createElement("div");
    el.className = "dm-item";
    el.innerHTML = `<span class="dm-name">${esc(name)}</span>${sub ? `<span class="dm-sub">${esc(sub)}</span>` : ""}`;
    el.addEventListener("click", () => {
      closeLinkMenu();
      fn();
    });
    body.appendChild(el);
  };

  if (isUrlText(raw)) {
    item("使用浏览器打开", browserUrl(raw), () => void openLinkText(cwd, raw));
    item("复制链接", "", () => {
      void copyPlainText(raw)
        .then(() => toast("已复制"))
        .catch((e) => toast(String(e), "error"));
    });
    return;
  }

  item("用编辑器打开", "用默认编辑器，定位到对应行", () => void openLocation(cwd, raw));
  item("在资源管理器中定位", "选中该文件", () => void revealLocation(cwd, raw));
  item("复制路径", "", () => {
    void copyPlainText(raw)
      .then(() => toast("已复制"))
      .catch((e) => toast(String(e), "error"));
  });
}

/** 给终端注册"可点击位置"：网址用浏览器打开，磁盘路径用编辑器/资源管理器；Ctrl+单击，右键出菜单 */
function attachLinkProvider(term: Terminal, pane: HTMLElement, s: TermSession): void {
  const cwd = s.cwd || "";
  // 悬停状态按会话隔离：多个终端同时开着时，全局变量会互相串
  let hovered: { raw: string } | null = null;

  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const mapped = mapLine(term, y);
      if (!mapped) {
        callback(undefined);
        return;
      }

      const { text, xs } = mapped;
      const links: ILink[] = [];
      /** 已被识别成网址的区间：里面的 `s://` 不能再当盘符路径 */
      const urlSpans: Array<{ start: number; end: number }> = [];

      const overlapsUrl = (start: number, end: number): boolean =>
        urlSpans.some((span) => start < span.end && end > span.start);

      const addLink = (raw: string, start: number): void => {
        if (raw.length < 4) return;
        const end = start + raw.length;
        if (end > xs.length) return;

        links.push({
          range: { start: { x: xs[start], y }, end: { x: xs[end - 1], y } },
          text: raw,
          decorations: { underline: true, pointerCursor: true },
          activate: (event: MouseEvent) => {
            // 跟随 VS Code / Android Studio：Ctrl+单击
            if (!event.ctrlKey && !event.metaKey) return;
            openOnce(cwd, raw);
          },
          hover: () => {
            hovered = { raw };
          },
          leave: () => {
            if (hovered?.raw === raw) hovered = null;
          },
        });
      };

      // 网址优先：命中后同一段文字不再参与盘符匹配
      for (const re of URL_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const raw = trimUrlTail(m[0]);
          if (raw.length < 4) continue;
          const start = m.index;
          const end = start + raw.length;
          if (end > xs.length) continue;
          if (overlapsUrl(start, end)) continue;

          urlSpans.push({ start, end });
          addLink(raw, start);
        }
      }

      for (const re of LOCATE_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          // 盘符规则带一个"前导分隔符"捕获组，链接本体是第 2 组
          const body = m[2] ?? m[0];
          const start = m.index + (m[0].length - body.length);
          const raw = trimLinkTail(body);
          if (raw.length < 4) continue;
          const end = start + raw.length;
          if (end > xs.length) continue;
          if (overlapsUrl(start, end)) continue;

          addLink(raw, start);
        }
      }

      callback(links.length ? links : undefined);
    },
  };

  term.registerLinkProvider(provider);

  // 自己再兜一层 Ctrl+单击：不依赖 xterm 的 activate 是否带修饰键
  pane.addEventListener("click", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (!hovered) return;
    openOnce(cwd, hovered.raw);
  });

  // 右键：悬停在链接上时给"定位 / 复制"
  pane.addEventListener("contextmenu", (e) => {
    if (!hovered) return;
    e.preventDefault();
    e.stopPropagation();
    showLinkMenu(e, cwd, hovered.raw);
  });
}

function ensureTerm(s: TermSession): void {
  if (s.term) return;
  const holder = req<HTMLDivElement>("#term-holder");

  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.dataset.sid = s.id;
  holder.appendChild(pane);

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 10000,
    // 用户按方向键 / 输入时，如果当前在看历史，自动回到光标处
    scrollOnUserInput: true,
    theme: termTheme,
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  } catch {
    /* 退化为默认宽度 */
  }

  term.open(pane);

  // 终端里的网址 / 路径 / package: URI 可点（Ctrl+单击打开，右键出菜单）
  attachLinkProvider(term, pane, s);

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* 回退 DOM 渲染器 */
  }

  // 会话恢复需要把缓冲序列化成 ANSI 文本
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  // 日志搜索（Ctrl+F）：按会话各一份，切换 tab 时只动当前会话
  const search = new SearchAddon();
  term.loadAddon(search);
  s.search = search;
  search.onDidChangeResults((e) => {
    if (s.id === activeSessionId) renderSearchCount(e.resultIndex, e.resultCount);
  });

  // 键盘 → PTY（恢复的会话没有进程，绝不能写）
  term.onData((data) => {
    if (s.restored) {
      // 终端没有「重跑」（它只会新开窗口），所以提示要分开写
      toast(
        s.kind === "terminal"
          ? "该终端已结束，点标签上的 × 关闭；需要新终端请右键项目「在终端中打开」"
          : "该会话已结束，点「⟳ 重跑」重新运行",
      );
      return;
    }
    void invoke("write_session", { id: s.id, data }).catch(() => {});
  });
  term.onResize(({ rows, cols }) => {
    if (s.restored) return;
    void invoke("resize_session", { id: s.id, rows, cols }).catch(() => {});
  });

  s.term = term;
  s.fit = fit;
  s.serialize = serialize;
  s.pane = pane;

  const buffered = pendingOutput.get(s.id);
  if (buffered) {
    term.write(buffered.join(""));
    pendingOutput.delete(s.id);
  }
}

function activateSession(id: string): void {
  activeSessionId = id;
  for (const s of sessions) {
    if (!s.pane) continue;
    s.pane.classList.toggle("active", s.id === id);
  }
  const cur = sessions.find((s) => s.id === id);
  if (cur) {
    ensureTerm(cur);
    // 换 tab 时收起搜索条：搜索是针对单个会话缓冲区的
    closeSearch();
    for (const s of sessions) s.pane?.classList.toggle("active", s.id === id);
    requestAnimationFrame(() => {
      cur.fit?.fit();
      cur.term?.focus();
    });
  }
  renderTabs();
  renderStatus();
  updateControls();
  updateEmptyState();
}

function updateControls(): void {
  const s = activeSession();
  // flutter 专有的一组（热重载/热重启/DevTools）：只有 run 会话且 flutter 真的在跑时才出现。
  // 普通终端（右键「在终端中打开」）不该看到它们。
  const running =
    s?.kind === "run" && s.status === "running" && s.flutterRunning === true;
  const tools = req<HTMLSpanElement>("#flutter-tools");
  tools.hidden = !running;

  // 普通命令也跑在「项目常驻终端」里：停止 / 重跑 / 搜索 / 清空 都应当可用。
  // 停止对终端是发 Ctrl+C（不关 shell），重跑是中断后带 Enter 再执行。
  req<HTMLSpanElement>("#session-tools").hidden = false;

  req<HTMLButtonElement>("#btn-reload").disabled = !running;
  req<HTMLButtonElement>("#btn-restart").disabled = !running;
  req<HTMLButtonElement>("#btn-stop").disabled = !s || s.status === "stopped";
  req<HTMLButtonElement>("#btn-devtools").disabled = !s?.devToolsUrl;
  // 清空日志 / 搜索：只要有终端就能用（不要求进程还在跑）
  req<HTMLButtonElement>("#btn-clear").disabled = !s?.term;
  req<HTMLButtonElement>("#btn-find").disabled = !s?.term;
  // 项目目录：有会话且有 cwd 才能用编辑器打开
  req<HTMLButtonElement>("#btn-open-proj").disabled = !s?.cwd;
  const rerun = req<HTMLButtonElement>("#btn-rerun");
  // 可重跑的会话：自定义命令 / 命令 / 模板 / 平台动作。
  // 终端：必须执行过命令，且 shell 已经恢复（restored 时还没活过来）。
  // 其他：恢复或已停止的会话才显示重跑，避免误以为能热重启。
  rerun.disabled = !(
    s &&
    (s.kind === "custom"
      ? Boolean(s.customCommandId)
      : s.kind === "terminal"
        ? Boolean(s.commandId) && !s.restored
        : (s.restored || s.status === "stopped") &&
          Boolean(s.commandId || s.templateId || (s.platform && s.action)))
  );

  // 终端里的「停止」是 Ctrl+C 中断当前命令，不结束 shell；自定义命令直接结束进程
  const stopBtn = req<HTMLButtonElement>("#btn-stop");
  stopBtn.title = !s
    ? "停止当前会话"
    : s.kind === "terminal"
      ? "中断当前命令（发送 Ctrl+C）；不会关闭终端"
      : s.kind === "custom" || s.kind === "build" || isExternalRunSession(s)
        ? "结束进程（保留标签与历史）"
        : "向 flutter run 发送 q，优雅退出";
  rerun.title = !s
    ? "重新执行原命令"
    : s.kind === "terminal"
      ? "中断当前命令并立即重跑（自动回车）"
      : s.kind === "custom"
        ? "结束当前进程并重新启动这条自定义命令"
        : "重新执行原命令（自动运行）";
  const info = req<HTMLSpanElement>("#ctx-info");
  info.textContent = s ? `${s.title}  ·  ${s.device}  ·  ${STATUS_TEXT[s.status]}` : "等待会话";

  // 构建产物
  const bar = req<HTMLSpanElement>("#artifact-bar");
  bar.innerHTML = "";
  if (s && s.kind === "build" && s.artifacts.length > 0) {
    for (const a of s.artifacts.slice(-3)) {
      const btn = document.createElement("button");
      btn.className = "cbtn artifact";
      btn.title = `打开所在目录\n${a}`;
      const name = a.split(/[\\/]/).pop() ?? a;
      btn.textContent = `📦 ${name}`;
      btn.addEventListener("click", () => void revealArtifact(s, a));
      bar.appendChild(btn);
    }
  }
}

function updateEmptyState(): void {
  const empty = document.querySelector<HTMLDivElement>("#term-empty");
  if (!empty) return;
  empty.style.display = sessions.length === 0 ? "flex" : "none";
}

/* ---------------- 渲染：标签 ---------------- */

function renderTabs(): void {
  const strip = req<HTMLDivElement>("#tabstrip");
  strip.innerHTML = "";

  if (sessions.length === 0) {
    const hint = document.createElement("div");
    hint.className = "tab-hint";
    hint.textContent = "暂无会话　·　在右侧选择命令，点 ▶ 或双击运行";
    strip.appendChild(hint);
  }

  for (const s of sessions) {
    const el = document.createElement("div");
    el.className =
      "tab" +
      (s.id === activeSessionId ? " active" : "") +
      (s.restored ? " restored" : "");
    el.title = `${STATUS_TEXT[s.status]} · ${s.device}${s.exitCode != null ? ` · 退出码 ${s.exitCode}` : ""}`;
    // 设备位：占位符（— / 空）不渲染，否则标签上会多出一个没有意义的「—」
    const hasDev = s.device && s.device !== "—" && s.device !== "-";
    el.innerHTML = `
      <span class="dot ${s.status === "running" ? "run" : s.status === "starting" ? "start" : "stop"}"></span>
      <span class="tab-title">${esc(s.title)}</span>
      ${hasDev ? `<span class="tab-dev">${esc(s.device)}</span>` : ""}
      <button class="tab-x" title="关闭会话">×</button>
    `;
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-x")) return;
      activateSession(s.id);
    });
    el.querySelector(".tab-x")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeSession(s.id);
    });
    strip.appendChild(el);
  }

  const add = document.createElement("button");
  add.className = "tab-add";
  add.textContent = "+";
  add.title = "新建会话";
  add.addEventListener("click", () => toast("在右侧选择命令后点 ▶ 运行"));
  strip.appendChild(add);
}

async function closeSession(id: string): Promise<void> {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  try {
    await invoke("kill_session", { id });
  } catch {
    /* 已结束的会话忽略 */
  }
  const [removed] = sessions.splice(idx, 1);
  removed.term?.dispose();
  removed.pane?.remove();
  pendingOutput.delete(id);
  if (activeSessionId === id) {
    activeSessionId = sessions.length ? sessions[sessions.length - 1].id : null;
    if (activeSessionId) activateSession(activeSessionId);
    else {
      renderTabs();
      renderStatus();
      updateControls();
      updateEmptyState();
    }
  } else {
    renderTabs();
    renderStatus();
  }

  schedulePersist();
}

/** 同名项目的显示名：用最具区分度的祖先目录名加后缀。
 *  例：flutter\library\projects\jbook 与 huawei\hm-library\projects\jbook
 *      → jbook ‹library› / jbook ‹hm-library› */
function projectLabel(p: Proj): string {
  const same = state.projects.filter((x) => x.name === p.name);
  if (same.length <= 1) return p.name;

  const segs = p.path.split(/[\\/]+/).filter(Boolean);
  for (let k = 1; k < segs.length; k++) {
    const mine = segs[segs.length - 1 - k];
    const clash = same.some((o) => {
      if (o.id === p.id) return false;
      const os = o.path.split(/[\\/]+/).filter(Boolean);
      return os[os.length - 1 - k] === mine;
    });
    if (!clash) return `${p.name} ‹${mine}›`;
  }
  return `${p.name} ‹${p.path}›`;
}

/* ---------------- 渲染：项目树 ---------------- */

function renderTree(): void {
  const tree = req<HTMLDivElement>("#tree");
  const countEl = req<HTMLSpanElement>("#proj-count");

  if (state.projects.length === 0) {
    countEl.textContent = "0 个项目";
    tree.innerHTML = `
      <div class="empty-tree">
        <div class="et-big">＋</div>
        <div class="et-title">还没有项目</div>
        <div class="et-sub">点击上方「添加 Flutter 项目」选择工程目录<br/>或在「导入 ▾」里「添加文件夹 / 目录」挂一个空目录<br/>再用「添加命令」或「从模板导入」补充</div>
      </div>`;
    return;
  }

  countEl.textContent = `${state.projects.length} 个项目 · ${visibleEntryCount()} 条命令`;
  tree.innerHTML = "";

  for (const p of state.projects) {
    const box = document.createElement("div");
    box.className = "proj";

    const isCollapsed = collapsed.has(p.id);
    // 文件夹项目不参与 Flutter 探测：没有 pubspec，显示「检测中… / 不可用」只会误导
    const isFolder = p.kind === "folder";
    const info = isFolder ? undefined : flutterInfo.get(p.id);
    const failed = info != null && !info.ok;
    const loading = info == null;

    const head = document.createElement("div");
    head.className = "proj-row" + (failed ? " warn" : "");
    head.title = p.path;

    const chipCls = loading ? "src-auto" : `src-${info.source}`;
    const chipTxt = loading ? "检测中…" : SOURCE_TEXT[info.source];

    // 徽章按"里面装了什么"来叫，而不是内部 kind：
    // 只有 npm / docker / qt 命令的项目分别叫「Npm」「Docker」「Qt」
    const hasNpm = p.commands.some((c) => c.source === "npm");
    const hasDocker = p.commands.some((c) => c.source === "docker");
    const hasQt = p.commands.some((c) => c.source === "qt");
    const only = (src: string): boolean =>
      p.commands.length > 0 && p.commands.every((c) => c.source === src);
    const kindLabel = isFolder
      ? "文件夹"
      : p.kind === "single"
        ? "Flutter"
        : only("docker")
          ? "Docker"
          : only("npm")
            ? "Npm"
            : only("qt")
              ? "Qt"
              : "工作区";
    const kindIcon = isFolder
      ? "📂"
      : p.kind === "single"
        ? "📁"
        : hasDocker
          ? "🐳"
          : hasNpm
            ? "📦"
            : hasQt
              ? "🔧"
              : "🗂";

    head.innerHTML = `
      <span class="chev">${isCollapsed ? "▸" : "▾"}</span>
      <span class="pico">${kindIcon}</span>
      <span class="pname">${esc(projectLabel(p))}</span>
      <span class="pmeta">
        <span class="chip kind-${p.kind}">${kindLabel}</span>
        ${
          isFolder
            ? ""
            : `${info?.source === "custom" ? "" : `<span class="chip ${chipCls}">${esc(chipTxt)}</span>`}
        ${info?.fvmVersion ? `<span class="chip chip-fvm" title="FVM 工程（.fvmrc 声明 ${esc(info.fvmVersion)}）">FVM</span>` : ""}`
        }
      </span>
    `;

    head.addEventListener("click", () => {
      if (collapsed.has(p.id)) collapsed.delete(p.id);
      else collapsed.add(p.id);
      renderTree();
      scheduleSaveCollapsed();
    });

    // 右键：全局命令可直接执行，无需先加入项目
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProjectMenu(e, p);
    });

    box.appendChild(head);

    if (!isCollapsed) {
      const list = document.createElement("div");
      list.className = "cmds";

      // Flutter 项目空命令是正常状态（能力在右键「平台 → 动作」），不提示；
      // 文件夹项目也不提示（用户明确要求去掉）；只有命令集为空才给一句引导
      if (p.commands.length === 0 && p.kind === "workspace") {
        const hint = document.createElement("div");
        hint.className = "cmd hint";
        hint.textContent = "尚无命令 —— 点上方「📂 导入 launch.json」选择该目录";
        list.appendChild(hint);
      }

      // docker：命令按 group 折叠成"服务"节点，动作进右键菜单
      const serviceGroups = new Map<string, Cmd[]>();
      for (const c of p.commands) {
        if (!c.group) continue;
        const arr = serviceGroups.get(c.group) ?? [];
        arr.push(c);
        serviceGroups.set(c.group, arr);
      }

      for (const [svc, actions] of serviceGroups) {
        const upCmd = actions.find((a) => a.role === "up");
        const stale = actions.every((a) => a.stale);

        const row = document.createElement("div");
        row.className = "cmd svc" + (stale ? " stale" : "");
        row.innerHTML = `
          <span class="cico">📦</span>
          <span class="cname">${esc(svc)}</span>
          ${stale ? `<span class="chip cmd-stale" title="compose 里已没有这个服务">已失效</span>` : ""}
          <span class="cnote">${actions.length} 个操作</span>
          <button class="run-btn" title="启动该服务（也可双击）">▶</button>
        `;
        row.title = [
          `服务 ${svc}`,
          upCmd ? `双击启动：${upCmd.program ?? ""} ${upCmd.args.join(" ")}` : "",
          "右键查看更多操作",
        ]
          .filter(Boolean)
          .join("\n");

        row.addEventListener("dblclick", (e) => {
          // 双击 ▶ 按钮时 click 已经跑过一次了，别再补一刀
          if ((e.target as HTMLElement).closest(".run-btn")) return;
          if (upCmd) void runCommand(p, upCmd);
        });
        row.querySelector(".run-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          if (upCmd) void runCommand(p, upCmd);
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openServiceMenu(e, p, svc, actions);
        });
        list.appendChild(row);
      }

      for (const c of p.commands) {
        // 归到服务的动作、以及项目级动作（up-all / logs-all / down）都不进列表
        if (c.group || c.role) continue;

        const row = document.createElement("div");
        row.className =
          "cmd" + (selectedCommand === c.id ? " selected" : "") + (c.stale ? " stale" : "");
        const mode = c.flutterMode ?? "debug";
        const icon =
          c.source === "npm"
            ? "⬢"
            : c.source === "docker"
              ? "🐳"
              : c.source === "qt"
                ? "🔧"
                : c.kind === "build"
                  ? "📦"
                  : "🚀";
        row.innerHTML = `
          <span class="cico">${icon}</span>
          <span class="cname">${esc(c.name)}</span>
          ${c.stale ? `<span class="chip cmd-stale" title="package.json 里已没有这个脚本">已失效</span>` : ""}
          ${mode !== "debug" ? `<span class="cmd-mode">${esc(mode)}</span>` : ""}
          <span class="cnote">${esc(c.cwd ?? "")}</span>
          <button class="run-btn" title="运行此命令（也可双击该行）">▶</button>
        `;
        row.title = [
          c.cwd ? `目录: ${c.cwd}` : "目录: 工作区根",
          c.args.length ? `参数: ${c.args.join(" ")}` : "",
          c.flutterMode ? `模式: ${c.flutterMode}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        row.addEventListener("click", () => selectCommand(c.id));
        row.addEventListener("dblclick", (e) => {
          // 双击 ▶ 按钮会先触发两次 click（各运行一次），这里不能再运行
          if ((e.target as HTMLElement).closest(".run-btn")) return;
          void runCommand(p, c);
        });
        row.querySelector(".run-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          void runCommand(p, c);
        });
        row.addEventListener("contextmenu", (e) => openCommandMenu(e, p, c));
        list.appendChild(row);
      }

      const addCmd = document.createElement("div");
      addCmd.className = "cmd add";
      addCmd.innerHTML = `<span class="cico">＋</span><span class="cname">添加命令</span>`;
      addCmd.title = "添加运行命令或发布构建命令";
      addCmd.addEventListener("click", () => void openCommandDialog(p));
      list.appendChild(addCmd);

      const tplImport = document.createElement("div");
      tplImport.className = "cmd add";
      tplImport.innerHTML = `<span class="cico">⤓</span><span class="cname">从模板导入…</span>`;
      tplImport.title = "从全局命令模板中按需导入";
      tplImport.addEventListener("click", () => openTemplateImport(p));
      list.appendChild(tplImport);

      box.appendChild(list);
    }

    tree.appendChild(box);
  }
}

/** 树里真正显示的条目数：docker 命令折叠成服务节点、项目级动作藏在右键里，
 *  所以不能直接数 commands.length（否则状态栏数字和树对不上） */
function visibleEntryCount(): number {
  let n = 0;
  for (const p of state.projects) {
    const groups = new Set<string>();
    for (const c of p.commands) {
      if (c.group) groups.add(c.group);
      else if (!c.role) n += 1;
    }
    n += groups.size;
  }
  return n;
}

/* ---------------- 渲染：状态栏 ---------------- */

function renderStatus(): void {
  const el = req<HTMLSpanElement>("#sb-state");
  el.textContent = `${state.projects.length} 个项目 · ${visibleEntryCount()} 条命令`;
  el.title = statePath ? `状态文件：${statePath}` : "";
  const fname = statePath ? (statePath.split(/[\\/]/).pop() ?? "") : "";
  req<HTMLSpanElement>("#sb-path").textContent = fname;
  req<HTMLSpanElement>("#sb-path").title = statePath;

  const sbSess = req<HTMLSpanElement>("#sb-sessions");
  sbSess.textContent = `会话 ${sessions.length}`;
}

function render(): void {
  renderTabs();
  renderTree();
  renderStatus();
  updateControls();
  updateEmptyState();
}

/* ---------------- 动作 ---------------- */

function selectCommand(id: string): void {
  if (selectedCommand === id) return;
  selectedCommand = id;
  renderTree();
}

/** npm / docker / qt 是「外部程序」：后端直接执行 program+args，没有交互 shell。
 *  kind 同为 run，但它们的停止 / 重跑 / 状态判定和 flutter run 完全不同。 */
function isExternalSource(source: string | undefined): boolean {
  return source === "npm" || source === "docker" || source === "qt";
}

function isExternalRunSession(s: TermSession): boolean {
  return s.kind === "run" && isExternalSource(s.source);
}

function mountSession(
  res: StartResponse,
  kind: string,
  mode: string,
  origin?: {
    projectId?: string;
    commandId?: string;
    templateId?: string;
    customCommandId?: string;
    platform?: string;
    action?: string;
    target?: string;
    source?: string;
  },
): TermSession {
  const externalRun = kind === "run" && isExternalSource(origin?.source);
  const session: TermSession = {
    id: res.id,
    title: res.title,
    pid: res.pid,
    device: res.device,
    mode,
    kind,
    cwd: res.cwd,
    artifacts: [],
    // 只有 `flutter run` 有明确的"就绪"标志（输出 Flutter run key commands.）。
    // 外部程序（npm run dev / docker logs -f）启动即已在跑，等标志只会永远黄点。
    status: kind === "run" && !externalRun ? "starting" : "running",
    scan: "",
    source: origin?.source,
    projectId: origin?.projectId,
    commandId: origin?.commandId,
    templateId: origin?.templateId,
    customCommandId: origin?.customCommandId,
    platform: origin?.platform,
    action: origin?.action,
    target: origin?.target,
  };
  sessions.push(session);
  activateSession(session.id);

  // 预填：等 shell 起好再输入（不回车，用户按 Enter 才执行）
  if (res.prefill) {
    const text = res.prefill;
    window.setTimeout(() => {
      void invoke("write_session", { id: res.id, data: text }).catch(() => {});
    }, 450);
  }

  // 立刻落盘一次：即使进程还在跑就关掉应用，tab 壳也不会丢
  schedulePersist();
  requestAnimationFrame(() => {
    session.fit?.fit();
    session.term?.focus();
    const rows = session.term?.rows ?? 30;
    const cols = session.term?.cols ?? 100;
    void invoke("resize_session", { id: session.id, rows, cols }).catch(() => {});
  });
  return session;
}

/** 同一身份（项目+命令 / 模板 / 自定义命令 / 平台动作）已经停止的会话。
 *  再次运行时用它原来的标签位置替换，避免同名 tab 越堆越多。 */
function staleSessionFor(match: (s: TermSession) => boolean): TermSession | undefined {
  return sessions.find((s) => s.status === "stopped" && match(s));
}

/** 用新会话替换旧会话，并**保持旧会话在标签栏里的位置**。
 *  重跑 / 同一命令再次运行都走这里：直接关旧开新会把它追加到列表末尾，顺序就乱了。 */
function replaceSessionInPlace(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const oldIdx = sessions.findIndex((s) => s.id === oldId);
  if (oldIdx < 0) return;
  if (!sessions.some((s) => s.id === newId)) return;

  const [old] = sessions.splice(oldIdx, 1);
  old.term?.dispose();
  old.pane?.remove();
  pendingOutput.delete(old.id);
  // 旧会话理论上已经结束；万一还活着（例如标记为已停止但 shell 还在），一并收掉
  void invoke("kill_session", { id: old.id }).catch(() => {});

  const newIdx = sessions.findIndex((s) => s.id === newId);
  if (newIdx >= 0) {
    const [fresh] = sessions.splice(newIdx, 1);
    sessions.splice(Math.min(oldIdx, sessions.length), 0, fresh);
  }
  renderTabs();
  renderStatus();
  updateControls();
  schedulePersist();
}

/** 同一身份（项目+命令 / 模板 / 自定义命令 / 平台动作）当前活着的会话。
 *  用于"重复点 ▶ 只切回已有标签"——同一个命令起两个进程通常只会互相抢端口。 */
function liveSessionFor(match: (s: TermSession) => boolean): TermSession | undefined {
  return sessions.find((s) => !s.restored && s.status !== "stopped" && match(s));
}

/** 正在启动的 key：双击 ▶ 时第二次点击往往早于第一次的会话挂载完成，
 *  此时 liveSessionFor 还看不到它，只能靠这个集合挡住。 */
const launchingKeys = new Set<string>();

/** 返回 true 表示这次点击被吞掉（同一个 key 已经在启动中） */
function markLaunching(key: string): boolean {
  if (launchingKeys.has(key)) {
    toast("正在启动，请稍候…");
    return true;
  }
  launchingKeys.add(key);
  return false;
}

async function runCommand(p: Proj, c: Cmd, deviceId?: string): Promise<TermSession | null> {
  selectCommand(c.id);

  // 普通命令（docker up/stop、npm test…）跑完就退出，没必要占一个标签：
  // 投递到项目的常驻终端里，跑完 shell 还在，可以接着敲
  if (c.kind === "custom") {
    return runInTerminal(p, c);
  }

  const sameCommand = (s: TermSession): boolean =>
    s.projectId === p.id && s.commandId === c.id && s.kind !== "terminal";

  // 同一条命令已经在跑：切回那个标签，不再起第二个进程 / 第二个标签
  const live = liveSessionFor(sameCommand);
  if (live) {
    activateSession(live.id);
    toast(`该命令已在运行：${live.title}`);
    return live;
  }

  // 之前跑过、已经停止的同名标签：新会话放回它原来的位置，而不是在末尾再挂一个
  const stale = staleSessionFor(sameCommand);

  const key = `cmd|${p.id}|${c.id}`;
  if (markLaunching(key)) return null;

  try {
    const res = await invoke<StartResponse>("start_session", {
      projectId: p.id,
      commandId: c.id,
      deviceId: deviceId ?? null,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(res, c.kind, c.flutterMode ?? "debug", {
      projectId: p.id,
      commandId: c.id,
      source: c.source ?? undefined,
    });
    if (stale && stale.id !== session.id) replaceSessionInPlace(stale.id, session.id);
    return session;
  } catch (e) {
    toast(String(e), "error");
    return null;
  } finally {
    launchingKeys.delete(key);
  }
}

/** 项目终端：优先活着的 shell；停止过但 shell 可能还在的也留给复用，
 *  真正失效时后端会退回新建，前端再把旧标签原位替换掉。 */
function projectShell(p: Proj): TermSession | undefined {
  const shells = sessions.filter(
    (s) => s.kind === "terminal" && s.projectId === p.id,
  );
  return shells.find((s) => s.status !== "stopped") ?? shells[0];
}

/** 同一项目的命令投递串行化：双击时第二次会等第一次把 shell 建好再复用，
 *  否则两个并发请求都看不到 shell，各开一个终端。 */
const terminalQueue = new Map<string, Promise<unknown>>();

/** 自定义命令的「双击防抖」：鼠标双击会连发两次 click，
 *  第二个 click 不该把同一条命令再敲一遍（重跑传 reuse，不走这层）。 */
const lastTerminalRun = new Map<string, number>();

function runInTerminal(p: Proj, c: Cmd, reuse?: TermSession): Promise<TermSession | null> {
  if (!reuse) {
    const runKey = `${p.id}|${c.id}`;
    const now = Date.now();
    if (now - (lastTerminalRun.get(runKey) ?? 0) < 800) return Promise.resolve(null);
    lastTerminalRun.set(runKey, now);
  }

  const prev = terminalQueue.get(p.id) ?? Promise.resolve();
  const task = prev
    .catch(() => undefined)
    .then(() => runInTerminalNow(p, c, reuse));
  terminalQueue.set(p.id, task);
  void task
    .finally(() => {
      if (terminalQueue.get(p.id) === task) terminalQueue.delete(p.id);
    })
    .catch(() => undefined);
  return task;
}

/** 把一条命令打进项目的常驻终端：有就复用，没有就新开一个 shell */
async function runInTerminalNow(
  p: Proj,
  c: Cmd,
  reuse?: TermSession,
): Promise<TermSession | null> {
  // 串行化之后这里再取一次：上一次点击可能刚建好 shell
  const existing = reuse ?? projectShell(p);
  try {
    const res = await invoke<StartResponse>("run_in_terminal", {
      projectId: p.id,
      commandId: c.id,
      reuseSessionId: existing?.id ?? null,
      rows: 30,
      cols: 100,
    });

    if (res.reused && existing) {
      // 记住「这个 shell 最近一次执行的是哪条命令」，重跑按钮据此可用
      existing.commandId = c.id;
      // 命令开始执行：标签恢复绿色（停止后会被标记成已停止）
      if (existing.status !== "running") {
        existing.status = "running";
        renderTabs();
      }
      activateSession(existing.id);
      updateControls();
      return existing;
    }

    const session = mountSession(res, "terminal", "debug", {
      projectId: p.id,
      commandId: c.id,
    });
    // 同一个项目里旧的终端标签（已停止/已结束）占着位置：新 shell 放回原位
    const stale = staleSessionFor(
      (s) => s.kind === "terminal" && s.projectId === p.id && s.id !== session.id,
    );
    if (stale) replaceSessionInPlace(stale.id, session.id);
    return session;
  } catch (e) {
    toast(String(e), "error");
    return null;
  }
}

/// 全局模板：不写入项目命令列表，直接起一个会话
async function runTemplate(p: Proj, t: Cmd, deviceId?: string): Promise<void> {
  const sameTemplate = (s: TermSession): boolean =>
    s.projectId === p.id && s.templateId === t.id;

  // 同一个模板已在跑：切回它，不再多开一个进程
  const live = liveSessionFor(sameTemplate);
  if (live) {
    activateSession(live.id);
    toast(`该模板已在运行：${live.title}`);
    return;
  }

  const stale = staleSessionFor(sameTemplate);

  const key = `tpl|${p.id}|${t.id}`;
  if (markLaunching(key)) return;

  try {
    const res = await invoke<StartResponse>("start_template_session", {
      projectId: p.id,
      templateId: t.id,
      deviceId: deviceId ?? null,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(res, t.kind, t.flutterMode ?? "debug", {
      projectId: p.id,
      templateId: t.id,
      source: t.source ?? undefined,
    });
    if (stale && stale.id !== session.id) replaceSessionInPlace(stale.id, session.id);
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launchingKeys.delete(key);
  }
}

function sendKey(data: string): void {
  const s = activeSession();
  if (!s) return;
  void invoke("write_session", { id: s.id, data }).catch(() => {});
}

async function stopActive(): Promise<void> {
  const s = activeSession();
  if (!s) return;

  // 自定义命令是直接进程，没有 shell 可回；结束进程但保留标签与历史
  if (s.kind === "custom") {
    await invoke("kill_session", { id: s.id }).catch(() => {});
    return;
  }

  // 项目终端的「停止」只中断当前命令，不关 shell：
  // go run / flutter 等长命令按 Ctrl+C 就会回到提示符，历史和环境都还在。
  // 但状态要跟着命令走：命令停了就把标签标成「已停止」（红点），
  // 下次投递命令时再恢复「运行中」——否则点完停止还是一直挂绿点。
  if (s.kind === "terminal") {
    await invoke("write_session", { id: s.id, data: "\x03" }).catch(() => {});
    if (s.status !== "stopped") {
      s.status = "stopped";
      renderTabs();
      updateControls();
      schedulePersist();
    }
    return;
  }

  // 外部程序（npm run dev / docker logs -f）和 build 没有 flutter 的 `q` 退出键：
  // 发 q 只会往 stdin 里打一个字母，再等 5 秒强关标签。直接结束进程树，
  // 退出事件会把状态标成「已停止」，标签与历史都保留。
  if (isExternalRunSession(s) || s.kind === "build") {
    await invoke("kill_session", { id: s.id }).catch(() => {});
    return;
  }

  // flutter run：q 是 flutter 自己的退出键，先礼后兵
  sendKey("q");
  window.setTimeout(() => {
    const still = sessions.find((x) => x.id === s.id && x.status !== "stopped");
    if (still) void closeSession(s.id);
  }, 5000);
}

async function refreshFlutter(id: string): Promise<void> {
  try {
    const info = await invoke<FlutterInfo>("detect_flutter", { projectId: id });
    flutterInfo.set(id, info);
    renderTree();
  } catch {
    /* 忽略单个项目的探测失败 */
  }
}

async function addProject(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Flutter 项目或工作区目录",
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;

  try {
    state = await invoke<State>("add_project", { path });
    render();
    const added = state.projects[state.projects.length - 1];
    toast(`已添加：${added.name}`);

    if (added.kind === "workspace") {
      await importLaunch(added.id, true);
    }
    void refreshFlutter(added.id);
  } catch (e) {
    const msg = String(e);
    // 普通目录不是"错误"：指一下新加的文件夹入口，别让人以为程序坏了
    toast(
      msg.includes("不是 Flutter 项目")
        ? `${msg}；若只想挂任意目录，请用「导入 → 添加文件夹 / 目录」`
        : msg,
      "error",
    );
  }
}

/** 添加一个普通文件夹/目录：不解析任何配置，导入后命令列表为空 */
async function addFolder(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择要添加的文件夹 / 目录",
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    state = await invoke<State>("add_folder", { path });
    render();
    const added = state.projects[state.projects.length - 1];
    // 刻意不探测 flutter、也不自动导入 launch.json：空文件夹就是空文件夹
    toast(`已添加文件夹「${added.name}」，用「添加命令」或「从模板导入」补充`);
  } catch (e) {
    toast(String(e), "error");
  }
}

async function importLaunch(projectId: string, silent = false): Promise<void> {
  try {
    const res = await invoke<ImportResponse>("import_launch", { projectId });
    state = res.state;
    render();

    const base = `导入完成：${res.imported}/${res.total} 条`;
    const warn = res.warnings.length ? `，${res.warnings.length} 条告警` : "";
    toast(
      silent ? `已自动导入 ${res.imported} 条命令` : base + warn,
      res.warnings.length ? "error" : "info",
    );
    if (res.warnings.length) console.warn("[launch.json]", res.warnings);
  } catch (e) {
    toast(String(e), "error");
  }
}

interface ImportPathResponse {
  state: State;
  projectId: string;
  projectName: string;
  kind: string;
  created: boolean;
  total: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

/** 从目录导入 launch.json：有 pubspec 当 Flutter 项目，否则当命令集 */
async function importLaunchPath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择包含 .vscode/launch.json 的目录",
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<ImportPathResponse>("import_launch_path", { path });
    state = res.state;
    render();
    void refreshFlutter(res.projectId);

    const what = res.kind === "single" ? "Flutter 项目" : "命令集";
    const how = res.created ? "已导入" : "已更新";
    const warn = res.warnings.length ? `，${res.warnings.length} 条告警` : "";
    toast(`${how}${what}「${res.projectName}」：${res.imported}/${res.total} 条命令${warn}`);

    if (res.warnings.length) console.warn("[launch.json]", res.warnings);
  } catch (e) {
    toast(String(e), "error");
  }
}

interface NpmImportResponse {
  state: State;
  projectId: string;
  projectName: string;
  manager: string;
  created: boolean;
  added: string[];
  kept: string[];
  stale: string[];
}

/** 导入 package.json：把 scripts 变成命令（dev → 长时间运行，build → 一次性产物） */
async function importPackagePath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: false,
      multiple: false,
      title: "选择 package.json",
      filters: [{ name: "package.json", extensions: ["json"] }],
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开文件选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<NpmImportResponse>("import_package_path", { path });
    state = res.state;
    render();
    void refreshFlutter(res.projectId);

    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    const how = res.created ? "已导入" : "已更新";
    const detail = parts.length ? `（${parts.join(" · ")}）` : "";
    toast(`${how}「${res.projectName}」：${res.manager}${detail}`);

    if (res.stale.length) console.warn("[package.json] 脚本已不存在：", res.stale);
  } catch (e) {
    toast(String(e), "error");
  }
}

interface QtImportResponse {
  state: State;
  projectId: string;
  projectName: string;
  created: boolean;
  configurePresets: string[];
  buildPresets: string[];
  runScript: string | null;
  warnings: string[];
  added: string[];
  kept: string[];
  stale: string[];
}

/** 导入 Qt / CMake 工程：按 CMakePresets 生成「配置 / 构建」，根目录有 run 脚本再加「运行」 */
async function importQtPath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Qt / CMake 工程目录",
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<QtImportResponse>("import_qt_path", { path });
    state = res.state;
    render();
    void refreshFlutter(res.projectId);

    const how = res.created ? "已导入" : "已更新";
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    const detail = parts.length ? `（${parts.join(" · ")}）` : "";
    toast(`${how}「${res.projectName}」：Qt / CMake${detail}`);

    // 一条命令都没生成（如 qmake 工程）时，提示要显眼；其余警告只写控制台
    if (res.warnings.length) {
      if (res.added.length === 0) toast(res.warnings.join("\n"), "error");
      else console.warn("[Qt]", res.warnings);
    }
    if (res.stale.length) console.warn("[Qt] 已消失的预设：", res.stale);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目右键「重新读取 CMakePresets.json」 */
async function rereadQt(p: Proj): Promise<void> {
  try {
    const res = await invoke<QtImportResponse>("import_qt_path", { path: p.path });
    state = res.state;
    render();
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    toast(`「${res.projectName}」Qt / CMake（${parts.join(" · ") || "无变化"}）`);
    if (res.warnings.length) console.warn("[Qt]", res.warnings);
  } catch (e) {
    toast(String(e), "error");
  }
}

interface ComposeImportResponse {
  state: State;
  projectId: string;
  projectName: string;
  created: boolean;
  services: number;
  added: string[];
  kept: string[];
  stale: string[];
}

/** 导入 docker-compose：每个 service 生成「启动 / 日志」，另加一条「全部停止」 */
async function importComposePath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: false,
      multiple: false,
      title: "选择 docker-compose.yml（或 compose.yaml）",
      filters: [{ name: "Compose", extensions: ["yml", "yaml"] }],
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开文件选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<ComposeImportResponse>("import_compose_path", { path });
    state = res.state;
    render();

    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    const how = res.created ? "已导入" : "已更新";
    const detail = parts.length ? `（${parts.join(" · ")}）` : "";
    toast(`${how}「${res.projectName}」：${res.services} 个服务${detail}`);

    if (res.stale.length) console.warn("[compose] 已消失的服务：", res.stale);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目右键「重新读取 docker-compose.yaml」：路径直接给项目根，后端自己找 compose 文件 */
async function rereadCompose(p: Proj): Promise<void> {
  try {
    const res = await invoke<ComposeImportResponse>("import_compose_path", { path: p.path });
    state = res.state;
    render();
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    toast(`「${res.projectName}」${res.services} 个服务（${parts.join(" · ") || "无变化"}）`);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目右键「重新读取 package.json」 */
async function rereadPackage(p: Proj): Promise<void> {
  try {
    const res = await invoke<NpmImportResponse>("import_package_path", { path: p.path });
    state = res.state;
    render();
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    toast(`「${res.projectName}」${res.manager}（${parts.join(" · ") || "无变化"}）`);
  } catch (e) {
    toast(String(e), "error");
  }
}

let lastImportDir: string | null = null;

async function removeProject(p: Proj): Promise<void> {
  const ok = await confirm(`确定要从列表中移除「${p.name}」吗？\n（不会删除磁盘上的任何文件）`, {
    title: "移除项目",
    kind: "warning",
  });
  if (!ok) return;

  try {
    state = await invoke<State>("remove_project", { id: p.id });
    flutterInfo.delete(p.id);
    render();
    toast(`已移除：${p.name}`);
  } catch (e) {
    toast(String(e), "error");
  }
}

/**
 * 重命名项目：只改显示名，不动磁盘目录。
 *
 * 不做原生 prompt（没装 dialog 的 prompt 能力），用一个轻量输入弹窗；
 * 回车保存、Esc 取消。名称的最终清洗在后端（`ops::rename_project_in`）。
 */
async function renameProject(p: Proj): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 460px">
      <div class="modal-head">
        <span>重命名项目</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="set-row">
          <label>项目名称</label>
          <input
            class="set-input"
            id="rename-input"
            maxlength="60"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="set-desc" id="rename-path"></div>
        <div class="set-desc">只改显示名，不会重命名磁盘上的文件夹。</div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="rename-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="rename-cancel">取消</button>
        <button class="btn primary" id="rename-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#rename-input") as HTMLInputElement;
  const hint = overlay.querySelector("#rename-hint") as HTMLSpanElement;
  const pathEl = overlay.querySelector("#rename-path") as HTMLDivElement;

  input.value = p.name;
  pathEl.textContent = p.path;
  pathEl.title = p.path;
  pathEl.style.overflowWrap = "anywhere";

  const close = (): void => overlay.remove();

  const save = (): void => {
    void (async () => {
      const name = input.value.trim();
      if (!name) {
        hint.textContent = "请填写项目名称";
        return;
      }
      if (name === p.name) {
        close();
        return;
      }

      try {
        const oldName = p.name;
        state = await invoke<State>("rename_project", { id: p.id, name });
        // 已打开标签的标题是后端拼的「项目名 · 命令/终端」，同步改掉前缀
        let touched = false;
        for (const s of sessions) {
          if (s.projectId === p.id && s.title.startsWith(oldName)) {
            s.title = name + s.title.slice(oldName.length);
            touched = true;
          }
        }
        // 顺手把会话日志里的标题也落盘，重启后恢复出来的标签不会还是旧名字
        if (touched) schedulePersist();
        close();
        render();
        toast(`已重命名：${oldName} → ${name}`);
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  };

  overlay.querySelector(".modal-x")?.addEventListener("click", close);
  overlay.querySelector("#rename-cancel")?.addEventListener("click", close);
  overlay.querySelector("#rename-save")?.addEventListener("click", save);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener("keydown", (e) => {
    // 别让 Esc / 回车漏给全局快捷键或终端
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  input.focus();
  input.select();
}

/* ---------------- Flutter 重命名（rename CLI） ---------------- */

interface FlutterRenameStatus {
  installed: boolean;
  version: string | null;
  onPath: boolean;
  exe: string | null;
  pubBin: string;
  flutter: string | null;
  flutterSource: string;
  error: string | null;
}

interface FlutterRenameActivation {
  status: FlutterRenameStatus;
  log: string;
}

interface FlutterRenameInfo {
  projectName: string;
  projectPath: string;
  platforms: string[];
  bundleIds: Record<string, string | null>;
  appNames: Record<string, string | null>;
  log: string;
}

interface FlutterRenameApply {
  ok: boolean;
  command: string;
  log: string;
  values: Record<string, string | null>;
}

const RENAME_PLATFORM_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  macos: "macOS",
  linux: "Linux",
  web: "Web",
  windows: "Windows",
};

type RenameAction = "bundle" | "name";

/**
 * Flutter 重命名面板：读取/修改包名与应用名称。
 * 实际执行 `rename setBundleId/setAppName --targets ... --value ...`。
 */
async function openFlutterRename(p: Proj): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal fl-rename-modal">
      <div class="modal-head">
        <span>Flutter 重命名 · ${esc(p.name)}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="rename-banner" id="flr-banner">正在检查 rename CLI…</div>
        <div class="rename-warning">
          会直接修改项目里的包名 / 应用名称；建议先提交 Git。
          只修改勾选的平台，未勾选的平台保持原样。
        </div>
        <div id="flr-body"></div>
        <pre class="rename-log" id="flr-log" hidden></pre>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="flr-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="flr-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#flr-body") as HTMLDivElement;
  const banner = overlay.querySelector("#flr-banner") as HTMLDivElement;
  const logEl = overlay.querySelector("#flr-log") as HTMLPreElement;
  const hint = overlay.querySelector("#flr-hint") as HTMLSpanElement;

  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#flr-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  const setBanner = (kind: "ok" | "warn" | "bad", text: string): void => {
    banner.className = `rename-banner ${kind}`;
    banner.textContent = text;
  };

  const showLog = (text: string): void => {
    logEl.hidden = false;
    logEl.textContent = text;
  };

  let status: FlutterRenameStatus;
  try {
    status = await invoke<FlutterRenameStatus>("rename_status");
  } catch (e) {
    setBanner("bad", `检查 rename 失败：${String(e)}`);
    return;
  }

  if (!status.installed) {
    setBanner(
      "bad",
      `未安装 rename。请执行 flutter pub global activate rename，或到「设置 → Flutter」里安装。` +
        (status.pubBin ? `\npub bin：${status.pubBin}` : "") +
        (status.error ? `\n${status.error}` : ""),
    );
    const go = document.createElement("button");
    go.className = "btn";
    go.textContent = "打开设置 → Flutter";
    go.addEventListener("click", () => {
      close();
      openSettings();
    });
    body.appendChild(go);
    return;
  }

  setBanner(
    status.onPath ? "ok" : "warn",
    status.onPath
      ? `rename ${status.version ?? ""} 已就绪${status.exe ? `（${status.exe}）` : ""}`
      : `rename ${status.version ?? ""} 已安装，但不在 PATH。AppDeck 会用\n` +
          `${status.exe ?? status.pubBin} 直接调用；想在终端里直接输入 rename，请把 ${status.pubBin} 加入 PATH。`,
  );

  let info: FlutterRenameInfo;
  const loading = document.createElement("div");
  loading.className = "set-desc";
  loading.textContent = "正在读取当前包名 / 应用名称…";
  body.appendChild(loading);
  try {
    info = await invoke<FlutterRenameInfo>("rename_project_info", { projectId: p.id });
  } catch (e) {
    loading.remove();
    setBanner("bad", `读取包名/应用名称失败：${String(e)}`);
    showLog(String(e));
    return;
  }
  loading.remove();

  const pathLine = document.createElement("div");
  pathLine.className = "set-desc rename-path";
  pathLine.textContent = info.projectPath;
  pathLine.title = info.projectPath;
  body.appendChild(pathLine);

  const commonValue = (
    map: Record<string, string | null>,
    targets: string[],
  ): string => {
    const vals = targets.map((t) => (map[t] ?? "").trim()).filter(Boolean);
    if (vals.length !== targets.length) return "";
    return vals.every((v) => v === vals[0]) ? vals[0] : "";
  };

  const makeSection = (
    action: RenameAction,
    title: string,
    desc: string,
    map: Record<string, string | null>,
  ): void => {
    // rename 3.1.0 对包名只支持 android/ios/macos；应用名称支持全部。
    // 以「读到的平台」为准，避免用户勾选后必然报错的平台。
    const sectionPlatforms = info.platforms.filter((x) => map[x] != null);
    if (!sectionPlatforms.length) return;

    const section = document.createElement("div");
    section.className = "rename-section";

    const head = document.createElement("div");
    head.className = "rename-head";
    const h = document.createElement("h3");
    h.textContent = title;
    const d = document.createElement("span");
    d.className = "set-desc";
    d.textContent = desc;
    head.append(h, d);
    section.appendChild(head);

    const preferred = sectionPlatforms.filter((x) => x === "android" || x === "ios");
    const selected = new Set<string>(
      preferred.length ? preferred : sectionPlatforms.slice(0, 1),
    );
    let userEdited = false;

    const current = document.createElement("div");
    current.className = "rename-current";
    section.appendChild(current);

    const row = document.createElement("div");
    row.className = "set-row";
    const lab = document.createElement("label");
    lab.textContent = action === "bundle" ? "新包名" : "新名称";
    const cell = document.createElement("div");
    cell.className = "set-cell";
    const input = document.createElement("input");
    input.className = "set-input";
    input.spellcheck = false;
    input.value = commonValue(map, [...selected]);
    input.placeholder =
      action === "bundle" ? "如 com.example.app" : "如 Today";
    cell.appendChild(input);
    row.append(lab, cell);
    section.appendChild(row);

    const platforms = document.createElement("div");
    platforms.className = "rename-platforms";
    for (const p2 of sectionPlatforms) {
      const l = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p2;
      cb.checked = selected.has(p2);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(p2);
        else selected.delete(p2);
        fillFromCommon();
        sync();
      });
      l.append(cb, document.createTextNode(RENAME_PLATFORM_LABELS[p2] ?? p2));
      platforms.appendChild(l);
    }
    section.appendChild(platforms);

    const skipped = info.platforms.filter((x) => !sectionPlatforms.includes(x));
    if (skipped.length) {
      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent = `rename 3.1.0 没有提供这些平台的该操作：${skipped
        .map((x) => RENAME_PLATFORM_LABELS[x] ?? x)
        .join(" / ")}`;
      section.appendChild(note);
    }

    const cmd = document.createElement("code");
    cmd.className = "rename-cmd";
    section.appendChild(cmd);

    const actions = document.createElement("div");
    actions.className = "rename-actions";
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = action === "bundle" ? "更新包名" : "更新名称";
    actions.appendChild(btn);
    section.appendChild(actions);

    const targetsNow = (): string[] => sectionPlatforms.filter((x) => selected.has(x));
    const commandText = (): string => {
      const targets = targetsNow();
      const value = input.value.trim() || "…";
      const cmdName = action === "bundle" ? "setBundleId" : "setAppName";
      return `rename ${cmdName} --targets ${targets.join(",") || "…"} --value "${value}"`;
    };

    const sync = (): void => {
      const targets = targetsNow();
      current.textContent =
        "当前：" +
        (targets.length
          ? targets
              .map((t) => `${RENAME_PLATFORM_LABELS[t] ?? t}=${map[t] ?? "读取失败"}`)
              .join("  ·  ")
          : "未选择平台");
      cmd.textContent = commandText();
      btn.disabled = targets.length === 0 || !input.value.trim();
    };
    // 切换平台时，只有在用户没改过输入框的情况下才用当前值补空
    const fillFromCommon = (): void => {
      if (userEdited || input.value.trim()) return;
      const common = commonValue(map, targetsNow());
      if (common) input.value = common;
    };
    input.addEventListener("input", () => {
      userEdited = true;
      sync();
    });
    btn.addEventListener("click", () => {
      void (async () => {
        const targets = targetsNow();
        const value = input.value.trim();
        hint.textContent = "";
        if (!targets.length) {
          hint.textContent = "请选择至少一个平台";
          return;
        }
        if (!value) {
          hint.textContent = "请填写新值";
          return;
        }
        if (action === "bundle" && /\s/.test(value)) {
          hint.textContent = "包名不能包含空格";
          return;
        }

        btn.disabled = true;
        btn.textContent = "更新中…";
        showLog(`$ ${commandText()}\n\n执行中…`);

        try {
          const res = await invoke<FlutterRenameApply>("rename_apply", {
            projectId: p.id,
            action,
            targets,
            value,
          });
          for (const [k, v] of Object.entries(res.values)) {
            if (v) map[k] = v;
          }
          showLog(`$ ${res.command}\n\n${res.log}`);
          sync();
          toast(`已更新${title}（${targets.join(", ")}）`);
        } catch (e) {
          showLog(`$ ${commandText()}\n\n${String(e)}`);
          toast(String(e), "error");
        } finally {
          btn.disabled = false;
          btn.textContent = action === "bundle" ? "更新包名" : "更新名称";
        }
      })();
    });

    body.appendChild(section);
    sync();
  };

  makeSection(
    "bundle",
    "包名（Bundle ID）",
    "Android applicationId / iOS PRODUCT_BUNDLE_IDENTIFIER 等",
    info.bundleIds,
  );
  makeSection(
    "name",
    "应用名称",
    "桌面图标与安装后显示的应用名称",
    info.appNames,
  );
}

/* ---------------- 工具栏自定义命令 ---------------- */

interface ShortcutInfo {
  target: string;
  args: string;
  cwd: string;
  description: string;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

async function runCustomCommand(c: CustomCommand, replaceId?: string): Promise<void> {
  const sameCustom = (s: TermSession): boolean =>
    s.kind === "custom" && s.customCommandId === c.id;

  // 同一个自定义命令已在跑：切回已有标签（「重跑」传了 replaceId，跳过这层）
  if (!replaceId) {
    const live = liveSessionFor(sameCustom);
    if (live) {
      activateSession(live.id);
      toast(`该命令已在运行：${live.title}`);
      return;
    }
  }

  const stale = staleSessionFor(sameCustom);

  const key = `custom|${c.id}`;
  if (markLaunching(key)) return;

  try {
    const res = await invoke<StartResponse>("start_custom_command", {
      commandId: c.id,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(res, "custom", "—", { customCommandId: c.id });
    // 重跑传了 replaceId 就替换它；否则把同名且已停止的旧标签原位替换掉
    const oldId = replaceId ?? stale?.id;
    if (oldId && oldId !== session.id) replaceSessionInPlace(oldId, session.id);
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launchingKeys.delete(key);
  }
}

async function deleteCustomCommand(c: CustomCommand): Promise<void> {
  const ok = await confirm(`删除自定义命令「${c.name}」？`, {
    title: "删除自定义命令",
    kind: "warning",
  });
  if (!ok) return;
  try {
    state = await invoke<State>("remove_custom_command", { id: c.id });
    closeAllMenus();
    toast(`已删除：${c.name}`);
  } catch (e) {
    toast(String(e), "error");
  }
}

async function openCustomCommandDialog(existing?: CustomCommand): Promise<void> {
  const draft = {
    name: existing?.name ?? "",
    program: existing?.program ?? "",
    target: existing?.target ?? "",
    args: existing?.args ?? "",
    cwd: existing?.cwd ?? "",
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 700px">
      <div class="modal-head">
        <span>${existing ? "编辑自定义命令" : "添加自定义命令"}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="set-row">
          <label>名称</label>
          <div class="set-cell">
            <input class="set-input" id="cc-name" maxlength="60" placeholder="如 NPC 服务" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
          </div>
        </div>
        <div class="set-row">
          <label>程序 / 快捷方式</label>
          <div class="set-cell">
            <input class="set-input" id="cc-program" placeholder="选择 .lnk / .exe，或直接填路径" spellcheck="false" autocomplete="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
            <button class="btn" id="cc-browse">浏览…</button>
            <button class="btn" id="cc-resolve">解析快捷方式</button>
          </div>
        </div>
        <div class="set-desc" id="cc-target"></div>
        <div class="set-row">
          <label>参数</label>
          <div class="set-cell">
            <input class="set-input" id="cc-args" placeholder="原样传给程序；快捷方式会自动填入" spellcheck="false" autocomplete="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
          </div>
        </div>
        <div class="set-row">
          <label>工作目录</label>
          <div class="set-cell">
            <input class="set-input" id="cc-cwd" placeholder="可空；快捷方式会自动填入" spellcheck="false" autocomplete="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
            <button class="btn" id="cc-browse-cwd">浏览…</button>
          </div>
        </div>
        <div class="set-desc">
          直接启动目标程序（.lnk 会先解析成 exe），不经过 ShellExecute，
          因此不会弹出系统控制台，也不会在任务栏多一个窗口。
        </div>
        <div class="set-desc" id="cc-hint"></div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint">快捷方式参数里的引号会自动去掉再传给目标</span>
        <span class="flex1"></span>
        <button class="btn" id="cc-cancel">取消</button>
        <button class="btn primary" id="cc-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameEl = overlay.querySelector("#cc-name") as HTMLInputElement;
  const programEl = overlay.querySelector("#cc-program") as HTMLInputElement;
  const argsEl = overlay.querySelector("#cc-args") as HTMLInputElement;
  const cwdEl = overlay.querySelector("#cc-cwd") as HTMLInputElement;
  const targetEl = overlay.querySelector("#cc-target") as HTMLDivElement;
  const hint = overlay.querySelector("#cc-hint") as HTMLDivElement;
  const saveBtn = overlay.querySelector("#cc-save") as HTMLButtonElement;

  nameEl.value = draft.name;
  programEl.value = draft.program;
  argsEl.value = draft.args;
  cwdEl.value = draft.cwd;
  nameEl.addEventListener("input", () => (draft.name = nameEl.value));
  programEl.addEventListener("input", () => {
    draft.program = programEl.value.trim();
    if (!draft.program.toLowerCase().endsWith(".lnk")) draft.target = "";
    renderTarget();
  });
  argsEl.addEventListener("input", () => (draft.args = argsEl.value));
  cwdEl.addEventListener("input", () => (draft.cwd = cwdEl.value.trim()));

  const renderTarget = (): void => {
    if (draft.target) {
      targetEl.textContent = `目标：${draft.target}`;
      targetEl.title = draft.target;
    } else if (draft.program.toLowerCase().endsWith(".lnk")) {
      targetEl.textContent = "快捷方式尚未解析；保存或运行时会自动解析。";
    } else {
      targetEl.textContent = "";
    }
  };
  renderTarget();

  const resolve = async (): Promise<boolean> => {
    const program = programEl.value.trim();
    if (!program.toLowerCase().endsWith(".lnk")) {
      draft.target = "";
      renderTarget();
      return true;
    }
    hint.textContent = "正在解析快捷方式…";
    try {
      const info = await invoke<ShortcutInfo>("resolve_shortcut", { path: program });
      draft.program = program;
      draft.target = info.target;
      draft.args = info.args;
      draft.cwd = info.cwd;
      argsEl.value = draft.args;
      cwdEl.value = draft.cwd;
      hint.textContent = "";
      renderTarget();
      return true;
    } catch (e) {
      hint.textContent = String(e);
      return false;
    }
  };

  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#cc-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  (overlay.querySelector("#cc-browse") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        const picked = await open({
          multiple: false,
          title: "选择程序或快捷方式",
          filters: [
            { name: "程序与快捷方式", extensions: ["lnk", "exe"] },
            { name: "全部文件", extensions: ["*"] },
          ],
          defaultPath: programEl.value || undefined,
        });
        if (!picked) return;
        const p = Array.isArray(picked) ? picked[0] : picked;
        programEl.value = p;
        draft.program = p;
        if (p.toLowerCase().endsWith(".lnk")) {
          await resolve();
        } else {
          draft.target = p;
          renderTarget();
          if (!cwdEl.value.trim()) {
            const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
            if (i > 0) {
              cwdEl.value = p.slice(0, i);
              draft.cwd = cwdEl.value;
            }
          }
        }
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  (overlay.querySelector("#cc-browse-cwd") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        const picked = await open({
          directory: true,
          multiple: false,
          title: "选择工作目录",
          defaultPath: cwdEl.value || undefined,
        });
        if (typeof picked !== "string") return;
        cwdEl.value = picked;
        draft.cwd = picked;
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  (overlay.querySelector("#cc-resolve") as HTMLButtonElement).addEventListener("click", () => {
    void resolve();
  });

  saveBtn.addEventListener("click", () => {
    void (async () => {
      const name = nameEl.value.trim();
      const program = programEl.value.trim();
      if (!name) {
        hint.textContent = "请填写名称";
        return;
      }
      if (!program) {
        hint.textContent = "请选择程序或快捷方式";
        return;
      }
      const lower = program.toLowerCase();
      if (lower.endsWith(".bat") || lower.endsWith(".cmd")) {
        hint.textContent = "暂不支持直接运行 .bat/.cmd，请选择 .lnk 或 .exe";
        return;
      }
      if (program.toLowerCase().endsWith(".lnk") && !draft.target) {
        if (!(await resolve())) return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        const command: CustomCommand = {
          id: existing?.id ?? "",
          name,
          program,
          target: draft.target.trim() || null,
          args: argsEl.value.trim(),
          cwd: cwdEl.value.trim() || null,
        };
        state = await invoke<State>("upsert_custom_command", { command });
        close();
        toast(existing ? "自定义命令已更新" : "自定义命令已添加");
      } catch (e) {
        hint.textContent = String(e);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "保存";
      }
    })();
  });

  nameEl.focus();
}

function openCustomCommandMenu(): void {
  closeAllMenus();

  const menu = document.createElement("div");
  menu.className = "device-menu custom-cmd-menu";
  const btn = req<HTMLButtonElement>("#btn-custom-menu");
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 360))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 320)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>自定义命令</span>
      <span class="dm-tag">${state.customCommands?.length ?? 0}</span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const rows: MenuRow[] = [];
  const commands = state.customCommands ?? [];
  for (const c of commands) {
    rows.push({
      kind: "item",
      name: c.name,
      detail: `${basename(c.target || c.program)}${c.cwd ? ` · ${c.cwd}` : ""}`,
      children: [
        {
          kind: "item",
          name: "运行",
          detail: "在 AppDeck 内嵌终端运行",
          onClick: () => void runCustomCommand(c),
        },
        {
          kind: "item",
          name: "编辑…",
          detail: "名称 / 程序 / 参数 / 工作目录",
          onClick: () => void openCustomCommandDialog(c),
        },
        { kind: "sep" },
        {
          kind: "item",
          name: "删除…",
          detail: "从工具栏移除（不影响磁盘文件）",
          onClick: () => void deleteCustomCommand(c),
        },
      ],
    });
  }

  if (!commands.length) {
    const empty = document.createElement("div");
    empty.className = "dm-empty";
    empty.textContent = "还没有自定义命令";
    (menu.querySelector(".dm-body") as HTMLDivElement).appendChild(empty);
  }

  rows.push(
    { kind: "sep" },
    {
      kind: "item",
      name: "＋ 添加命令…",
      detail: "快捷方式 / exe，可填参数与工作目录",
      onClick: () => void openCustomCommandDialog(),
    },
  );

  renderMenuRows(menu.querySelector(".dm-body") as HTMLDivElement, rows);
}

/* ---------------- PTY 事件 ---------------- */

/** 打开「进程与端口」面板（工具栏按钮 / 开发期 FLA_PROCESSES 共用） */
function openProcessPanel(): void {
  openProcessManager({
    notify: toast,
    initialPrefs: {
      hideRules: [...(state.ui?.processHideRules ?? [])],
      hideRulesEnabled: state.ui?.processHideRulesEnabled ?? true,
      autoRefresh: state.ui?.processAutoRefresh ?? true,
    },
    savePrefs: async (prefs) => {
      state = await invoke<State>("save_process_prefs", {
        hideRules: prefs.hideRules,
        hideRulesEnabled: prefs.hideRulesEnabled,
        autoRefresh: prefs.autoRefresh,
      });
    },
    // 把 AppDeck 自己拉起的会话标出来，避免误杀时不知道是哪个标签
    sessionPids: () => {
      const map = new Map<number, string>();
      for (const s of sessions) {
        if (s.pid) map.set(s.pid, s.title);
      }
      return map;
    },
  });
}

/** 在项目目录开一个交互终端（继承项目环境）。 */
async function openProjectTerminal(p: Proj): Promise<void> {
  try {
    const res = await invoke<StartResponse>("open_terminal", {
      projectId: p.id,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(res, "terminal", "terminal", { projectId: p.id });
    // 已结束的旧终端标签别留着变成同名重复 tab：新终端放回它的位置
    const stale = staleSessionFor(
      (s) => s.kind === "terminal" && s.projectId === p.id && s.id !== session.id,
    );
    if (stale) replaceSessionInPlace(stale.id, session.id);
  } catch (e) {
    toast(String(e), "error");
  }
}

/* ---------------- 项目环境变量 ---------------- */

interface EnvEntry {
  key: string;
  value: string;
  /** 全局 / .fvmrc / 项目 */
  source: string;
}

interface ProjectEnvInfo {
  harmony: boolean;
  exe: string;
  flutterSource: string;
  shim: string | null;
  entries: EnvEntry[];
}

async function openEnvDialog(p: Proj): Promise<void> {
  let info: ProjectEnvInfo;
  try {
    info = await invoke<ProjectEnvInfo>("project_env", { projectId: p.id });
  } catch (e) {
    toast(String(e), "error");
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 760px">
      <div class="modal-head">
        <span>环境变量 · ${esc(projectLabel(p))}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="env-body"></div>
      <div class="modal-foot">
        <span class="modal-hint">${esc(p.path)}</span>
        <span class="flex1"></span>
        <button class="btn" id="env-reset">重置项目覆盖</button>
        <button class="btn primary" id="env-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#env-body") as HTMLDivElement;
  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);

  // 生效来源一览
  const sum = document.createElement("div");
  sum.className = "env-summary";
  sum.innerHTML = `
    <div class="fl-row"><span class="fl-label">flutter</span><span class="fl-value">${esc(
      info.exe || "（未解析到）",
    )}</span></div>
    <div class="fl-row"><span class="fl-label">来源</span><span class="fl-value">${esc(
      info.flutterSource || "—",
    )}</span></div>
    <div class="fl-row"><span class="fl-label">PATH shim</span><span class="fl-value">${esc(
      info.shim ?? "（未生成：与 PATH 中的 flutter 相同或非鸿蒙工程）",
    )}</span></div>
  `;
  body.appendChild(sum);

  if (!info.harmony) {
    const warn = document.createElement("div");
    warn.className = "fl-banner";
    warn.textContent =
      "该项目没有 ohos/ 目录，不属于鸿蒙工程：下面这些变量不会注入（仅 .fvmrc 的 env 除外）。";
    body.appendChild(warn);
  }

  const listTitle = document.createElement("div");
  listTitle.className = "set-sub";
  listTitle.textContent = `生效环境变量（${info.entries.length}）`;
  body.appendChild(listTitle);

  const list = document.createElement("div");
  list.className = "env-list";
  for (const e of info.entries) {
    const row = document.createElement("div");
    row.className = "env-row";
    const k = document.createElement("span");
    k.className = "env-tag-key";
    k.textContent = e.key;
    const v = document.createElement("span");
    v.className = "env-tag-value";
    v.textContent = e.value;
    const src = document.createElement("span");
    src.className = "chip env-src";
    src.textContent = e.source;
    row.append(k, v, src);
    list.appendChild(row);
  }
  if (info.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "set-desc";
    empty.textContent = "（暂无，可在下方添加项目级变量）";
    list.appendChild(empty);
  }
  body.appendChild(list);

  // 项目级覆盖编辑器
  const pTitle = document.createElement("div");
  pTitle.className = "set-sub";
  pTitle.textContent = "项目级变量（优先级最高）";
  body.appendChild(pTitle);

  const editBox = document.createElement("div");
  editBox.className = "env-list";
  body.appendChild(editBox);

  const rows: Array<[string, string]> = Object.entries(p.env ?? {});
  const collect = (): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const [k, v] of rows) if (k.trim() !== "") m[k.trim()] = v;
    return m;
  };

  const renderEdit = (): void => {
    editBox.innerHTML = "";

    rows.forEach(([k, v], idx) => {
      const row = document.createElement("div");
      row.className = "env-row";

      const kEl = document.createElement("input");
      kEl.className = "set-input env-key";
      kEl.value = k;
      kEl.placeholder = "KEY";
      kEl.addEventListener("input", () => {
        rows[idx][0] = kEl.value;
      });

      const vEl = document.createElement("input");
      vEl.className = "set-input";
      vEl.value = v;
      vEl.placeholder = "value";
      vEl.addEventListener("input", () => {
        rows[idx][1] = vEl.value;
      });

      const del = document.createElement("button");
      del.className = "btn";
      del.textContent = "×";
      del.title = "删除该变量";
      del.addEventListener("click", () => {
        rows.splice(idx, 1);
        renderEdit();
      });

      row.append(kEl, vEl, del);
      editBox.appendChild(row);
    });

    const add = document.createElement("button");
    add.className = "btn";
    add.textContent = "＋ 添加变量";
    add.addEventListener("click", () => {
      rows.push(["", ""]);
      renderEdit();
    });
    editBox.appendChild(add);
  };
  renderEdit();

  (overlay.querySelector("#env-reset") as HTMLButtonElement).addEventListener("click", () => {
    rows.length = 0;
    renderEdit();
  });

  (overlay.querySelector("#env-save") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        state = await invoke<State>("save_project_env", {
          projectId: p.id,
          env: collect(),
        });
        render();
        toast("环境变量已保存（下次启动会话生效）");
        close();
      } catch (e) {
        toast(String(e), "error");
      }
    })();
  });
}

/* ---------------- 备案信息（安卓） ---------------- */

let lastApkDir: string | null = null;
let lastFiling: FilingInfo | null = null;

async function pickApkAndInspect(): Promise<void> {
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "选择要查看的 APK",
      defaultPath: lastApkDir ?? undefined,
      filters: [{ name: "Android 安装包", extensions: ["apk"] }],
    });
    if (typeof picked !== "string") return;
    lastApkDir = picked.replace(/[\\/][^\\/]+$/, "");
    await showFilingInfo(picked);
  } catch (e) {
    toast(String(e), "error");
  }
}

function filingField(label: string, value: string | null | undefined, big = false): string {
  const v = value?.trim() || "";
  return `
    <div class="fl-row${big ? " big" : ""}">
      <span class="fl-label">${esc(label)}</span>
      <code class="fl-value">${v ? esc(v) : '<span class="fl-empty">—</span>'}</code>
      ${v ? `<button class="btn fl-copy" data-copy="${esc(v)}">复制</button>` : ""}
    </div>`;
}

async function showFilingInfo(apk: string): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 820px">
      <div class="modal-head">
        <span>安卓备案信息</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="fl-body">
        <div class="dm-loading">正在读取 APK 签名与清单…</div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="fl-hint">${esc(apk)}</span>
        <span class="flex1"></span>
        <button class="btn" id="fl-copy-all">复制全部</button>
        <button class="btn" id="fl-repick">换一个 APK</button>
        <button class="btn primary" id="fl-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#fl-body") as HTMLDivElement;
  const close = (): void => overlay.remove();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#fl-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  (overlay.querySelector("#fl-copy-all") as HTMLButtonElement).addEventListener("click", () =>
    copyAllFiling(),
  );
  (overlay.querySelector("#fl-repick") as HTMLButtonElement).addEventListener("click", () => {
    close();
    void pickApkAndInspect();
  });

  let info: FilingInfo;
  try {
    info = await invoke<FilingInfo>("filing_info", { apk });
  } catch (e) {
    body.innerHTML = `<div class="dr-raw">${esc(String(e))}</div>`;
    return;
  }
  lastFiling = info;

  if (info.error) {
    body.innerHTML = `<div class="dr-raw">${esc(info.error)}</div>`;
    return;
  }

  const debugSigned = (info.dn ?? "").toLowerCase().includes("android debug");

  body.innerHTML = `
    ${debugSigned ? '<div class="fl-banner">当前为调试签名，请勿用于备案</div>' : ""}
    <div class="fl-section">备案三要素</div>
    ${filingField("应用名称", info.appLabel, true)}
    ${filingField("应用包名", info.package, true)}
    ${filingField("应用 MD5", info.md5, true)}
    ${
      info.publicKey
        ? filingField("应用公钥", info.publicKey, true)
        : `<div class="fl-row big">
             <span class="fl-label">应用公钥</span>
             <code class="fl-value"><span class="fl-empty">待解析（第二期提供：解析 APK 签名块）</span></code>
           </div>`
    }

    <div class="fl-section">附加信息</div>
    ${filingField("版本", [info.versionName, info.versionCode ? `(${info.versionCode})` : ""].filter(Boolean).join(" "))}
    ${filingField("SDK", [info.minSdk ? `min ${info.minSdk}` : "", info.targetSdk ? `target ${info.targetSdk}` : ""].filter(Boolean).join(" · "))}
    ${filingField("签名方案", info.scheme ? `V${info.scheme}` : null)}
    ${filingField("证书 DN", info.dn)}
    ${filingField("SHA-1", info.sha1)}
    ${filingField("SHA-256", info.sha256)}

    ${
      info.warnings.length
        ? `<div class="fl-section">提示</div>${info.warnings
            .map((w) => `<div class="fl-warn">${esc(w)}</div>`)
            .join("")}`
        : ""
    }
  `;

  body.querySelectorAll<HTMLButtonElement>(".fl-copy").forEach((b) => {
    b.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(b.dataset.copy ?? "")
        .then(() => toast("已复制"))
        .catch((e) => toast(String(e), "error"));
    });
  });
}

function copyAllFiling(): void {
  const i = lastFiling;
  if (!i) return;

  const lines = [
    `应用名称：${i.appLabel ?? ""}`,
    `应用包名：${i.package ?? ""}`,
    `应用公钥：${i.publicKey ?? "（待解析）"}`,
    `应用MD5：${i.md5 ?? ""}`,
    `版本：${i.versionName ?? ""} (${i.versionCode ?? ""})`,
    `SHA1：${i.sha1 ?? ""}`,
    `SHA256：${i.sha256 ?? ""}`,
    `证书DN：${i.dn ?? ""}`,
    `签名方案：${i.scheme ? `V${i.scheme}` : ""}`,
  ];

  void navigator.clipboard
    .writeText(lines.join("\n"))
    .then(() => toast("备案信息已复制"))
    .catch((e) => toast(String(e), "error"));
}

/* ---------------- 体检（§14 / §6.6）：工具栏按钮 ---------------- */

interface DoctorCheck {
  key: string;
  name: string;
  summary: string;
  status: string;
  details: string[];
  fix: string | null;
  canRun: boolean;
}

interface DoctorReport {
  checks: DoctorCheck[];
  issues: number;
  summary: string | null;
  raw: string;
  error: string | null;
  ranAt: number;
}

let doctorReport: DoctorReport | null = null;
let doctorBusy = false;

const DOCTOR_ICON: Record<string, string> = {
  ok: "√",
  warn: "!",
  error: "✗",
};

function doctorIssues(): DoctorCheck[] {
  return (doctorReport?.checks ?? []).filter((c) => c.status !== "ok");
}

/** 工具栏按钮即体检入口：状态直接体现在按钮上 */
function renderDoctorButton(): void {
  const item = document.querySelector<HTMLElement>("#tools-doctor");
  if (!item) return;
  const detail = item.querySelector<HTMLElement>(".dm-sub");
  if (!detail) return;

  item.classList.toggle("checking", doctorBusy);
  const rep = doctorReport;

  if (doctorBusy) {
    detail.textContent = "正在运行 flutter doctor…";
    item.title = "正在运行 flutter doctor…";
    return;
  }

  // 没跑过：不自动触发（flutter doctor 要 20+ 秒），等用户点
  if (!rep) {
    detail.textContent = "未体检 · 点击运行（约 20 秒）";
    item.title = "点击运行 flutter doctor（结果会缓存）";
    return;
  }

  if (rep.error) {
    detail.textContent = `失败：${rep.error}`;
    item.title = `体检未能完成：${rep.error}\n点击查看详情`;
    return;
  }

  const bad = doctorIssues();
  if (bad.length === 0) {
    detail.textContent = `${rep.checks.length} 项全部正常 · 点击查看`;
    item.title = `${rep.checks.length} 项检查全部正常\n点击查看详情`;
  } else {
    detail.textContent = `${bad.length} 项异常 · 点击查看`;
    item.title = `${bad.map((c) => c.name).join("、")}\n点击查看详情`;
  }
}

function openDoctorEntry(): void {
  if (doctorBusy) {
    toast("体检进行中…");
    return;
  }
  if (doctorReport) openDoctorReport();
  else void refreshDoctor(true);
}

function openToolsMenu(anchor: HTMLElement): void {
  if (toolsMenuEl) {
    closeAllMenus();
    return;
  }
  closeAllMenus();

  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "device-menu tools-menu";
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 220)}px`;
  menu.innerHTML = `
    <div class="dm-head"><span>工具</span></div>
    <div class="dm-body">
      <div class="dm-item" id="tools-filing">
        <span class="dm-name">📋 备案</span>
        <span class="dm-sub">安卓 APK 包名 / MD5 / 公钥</span>
      </div>
      <div class="dm-item" id="tools-doctor">
        <span class="dm-name">🩺 体检</span>
        <span class="dm-sub"></span>
      </div>
      <div class="dm-item" id="tools-processes">
        <span class="dm-name">🧩 进程</span>
        <span class="dm-sub">进程与端口管理</span>
      </div>
    </div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;
  toolsMenuEl = menu;

  menu.querySelector("#tools-filing")?.addEventListener("click", () => {
    closeAllMenus();
    void pickApkAndInspect();
  });
  menu.querySelector("#tools-doctor")?.addEventListener("click", () => {
    closeAllMenus();
    openDoctorEntry();
  });
  menu.querySelector("#tools-processes")?.addEventListener("click", () => {
    closeAllMenus();
    openProcessPanel();
  });

  renderDoctorButton();
}

/**
 * 启动时只读体检缓存，**绝不触发** `flutter doctor`（实测 20+ 秒）。
 * 没有缓存就保持"未体检"状态，等用户点工具栏的「体检」。
 */
async function loadCachedDoctor(): Promise<void> {
  try {
    const rep = await invoke<DoctorReport>("flutter_doctor", {
      projectId: state.projects[0]?.id ?? null,
      force: false,
      cachedOnly: true,
    });
    // ranAt === 0 表示后端没有缓存（不是"检查通过"）
    doctorReport = rep.ranAt ? rep : null;
  } catch {
    doctorReport = null;
  }
  renderDoctorButton();
}

async function refreshDoctor(force = false): Promise<void> {
  if (doctorBusy) return;

  doctorBusy = true;
  renderDoctorButton();

  try {
    doctorReport = await invoke<DoctorReport>("flutter_doctor", {
      projectId: state.projects[0]?.id ?? null,
      force,
    });
  } catch (e) {
    doctorReport = {
      checks: [],
      issues: 0,
      summary: null,
      raw: "",
      error: String(e),
      ranAt: Date.now(),
    };
  } finally {
    doctorBusy = false;
    renderDoctorButton();
  }
}

function openDoctorReport(): void {
  const rep = doctorReport;
  if (!rep) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const body = rep.error
    ? `<div class="dr-raw">${esc(rep.error)}</div>`
    : rep.checks
        .map((c) => {
          const details = c.details.length
            ? `<div class="dr-details">${c.details.map((d) => esc(d)).join("<br>")}</div>`
            : "";
          const fix = c.fix
            ? `<div class="dr-fix">
                 <span class="dr-fix-label">修复：</span>
                 <code>${esc(c.fix)}</code>
                 <button class="btn dr-copy" data-copy="${esc(c.fix)}">复制</button>
                 ${c.canRun ? `<button class="btn primary dr-run" data-fix="${esc(c.fix)}">在终端执行</button>` : ""}
               </div>`
            : "";
          return `
            <div class="dr-check ${c.status}">
              <div class="dr-head">
                <span class="dr-icon">${DOCTOR_ICON[c.status] ?? "?"}</span>
                <span class="dr-name">${esc(c.name)}</span>
                <span class="dr-summary">${esc(c.summary)}</span>
              </div>
              ${details}
              ${fix}
            </div>`;
        })
        .join("");

  overlay.innerHTML = `
    <div class="modal" style="width: 780px">
      <div class="modal-head">
        <span>flutter doctor 体检报告</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="dr-body">${body}</div>
      <div class="modal-foot">
        <span class="modal-hint">${esc(rep.summary ?? "")}</span>
        <span class="flex1"></span>
        <button class="btn" id="dr-copy-raw">复制原始输出</button>
        <button class="btn" id="dr-rerun">重新体检</button>
        <button class="btn primary" id="dr-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#dr-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#dr-rerun") as HTMLButtonElement).addEventListener("click", () => {
    close();
    void refreshDoctor(true);
  });

  (overlay.querySelector("#dr-copy-raw") as HTMLButtonElement).addEventListener("click", () => {
    void navigator.clipboard
      .writeText(rep.raw || rep.error || "")
      .then(() => toast("原始输出已复制"))
      .catch((e) => toast(String(e), "error"));
  });

  overlay.querySelectorAll<HTMLButtonElement>(".dr-copy").forEach((b) => {
    b.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(b.dataset.copy ?? "")
        .then(() => toast("命令已复制"))
        .catch((e) => toast(String(e), "error"));
    });
  });

  overlay.querySelectorAll<HTMLButtonElement>(".dr-run").forEach((b) => {
    b.addEventListener("click", () => {
      const project = state.projects[0];
      if (!project) {
        toast("需要先添加一个项目", "error");
        return;
      }
      close();
      void invoke<StartResponse>("start_doctor_fix", {
        projectId: project.id,
        fix: b.dataset.fix ?? "",
        rows: 30,
        cols: 100,
      })
        .then((res) => {
          mountSession(res, "custom", "debug", { projectId: project.id });
          toast("已在终端启动修复流程，按提示输入 y 确认");
        })
        .catch((e) => toast(String(e), "error"));
    });
  });
}

/* ---------------- 会话恢复（D-10） ---------------- */

interface SessionLog {
  id: string;
  title: string;
  projectId: string | null;
  commandId: string | null;
  templateId: string | null;
  customCommandId: string | null;
  platform: string | null;
  action: string | null;
  target: string | null;
  device: string;
  mode: string;
  kind: string;
  cwd: string;
  exitCode: number | null;
  status: string;
  artifacts: string[];
  ansi: string;
  savedAt: number;
}

let persistTimer: number | null = null;

/** 合并高频变更，避免每次输出都序列化整个缓冲 */
/** 输出驱动自动落盘：最多 5 秒一次，避免关窗口时丢掉最后一段输出 */
let lastAutoSave = 0;
function autosaveSessions(): void {
  const now = Date.now();
  if (now - lastAutoSave < 5000) return;
  lastAutoSave = now;
  void persistSessions();
}

function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persistSessions();
  }, 700);
}

async function persistSessions(): Promise<void> {
  const logs: SessionLog[] = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    projectId: s.projectId ?? null,
    commandId: s.commandId ?? null,
    templateId: s.templateId ?? null,
    customCommandId: s.customCommandId ?? null,
    platform: s.platform ?? null,
    action: s.action ?? null,
    target: s.target ?? null,
    device: s.device,
    mode: s.mode,
    kind: s.kind,
    cwd: s.cwd,
    exitCode: s.exitCode ?? null,
    status: s.restored ? "stopped" : s.status,
    artifacts: s.artifacts,
    // 恢复时写进去的分隔线不能一起落盘，否则每恢复一次就多一条
    ansi: stripRestoreMarker(s.serialize?.serialize() ?? ""),
    savedAt: Date.now(),
  }));

  try {
    await invoke("save_session_logs", { logs });
  } catch {
    /* 落盘失败不打断使用 */
  }
}

/** 恢复时插入的分隔线标记（落盘前会被剥掉，避免反复累积） */
const RESTORE_MARKER = "──── 历史输出已恢复";

function stripRestoreMarker(ansi: string): string {
  if (!ansi.includes(RESTORE_MARKER)) return ansi;
  return ansi
    .split(/\r?\n/)
    .filter((line) => !line.includes(RESTORE_MARKER))
    .join("\r\n");
}

async function restoreSessions(): Promise<void> {
  let logs: SessionLog[] = [];
  try {
    logs = await invoke<SessionLog[]>("load_session_logs");
  } catch {
    return;
  }
  if (logs.length === 0) return;

  // 同一身份（项目 + 命令/平台动作）只保留最新一条：
  // 早期版本"重跑"是追加标签，会累积一堆同名死会话，恢复时全列出来只会让人分不清。
  // id 形如 sess-<毫秒>-<序号>，按 id 比较即按时间比较。
  const identity = (l: SessionLog): string =>
    l.customCommandId
      ? `custom|${l.customCommandId}`
      : l.platform
        ? `${l.projectId}|${l.platform}|${l.action}|${l.target ?? ""}`
        : `${l.projectId}|${l.commandId ?? l.templateId ?? ""}`;

  const newest = new Map<string, SessionLog>();
  for (const l of logs) {
    const k = identity(l);
    const prev = newest.get(k);
    if (!prev || l.id > prev.id) newest.set(k, l);
  }
  logs = Array.from(newest.values());

  for (const log of logs) {
    // 老版本会话记录可能没有 kind：按它引用的命令/动作反推，
    // 否则 run 会话会被当成其他类型（导致「重跑」不会替换标签）
    const referenced = state.projects
      .find((p) => p.id === log.projectId)
      ?.commands.find((c) => c.id === log.commandId);
    const inferredKind = log.kind || (log.platform ? "run" : (referenced?.kind ?? "run"));

    const s: TermSession = {
      id: log.id,
      title: log.title,
      device: log.device || "—",
      mode: log.mode || "debug",
      kind: inferredKind,
      cwd: log.cwd || "",
      artifacts: log.artifacts ?? [],
      status: "stopped",
      exitCode: log.exitCode ?? null,
      scan: "",
      // 日志里没存 source：按它引用的命令/模板补回来，否则恢复的 npm 会话
      // 会被当成 flutter run（停止时发 q、重跑走错分支）
      source:
        referenced?.source ??
        state.commandTemplates.find((t) => t.id === log.templateId)?.source ??
        undefined,
      projectId: log.projectId ?? undefined,
      commandId: log.commandId ?? undefined,
      templateId: log.templateId ?? undefined,
      customCommandId: log.customCommandId ?? undefined,
      platform: log.platform ?? undefined,
      action: log.action ?? undefined,
      target: log.target ?? undefined,
      restored: true,
    };
    sessions.push(s);
    ensureTerm(s);
    if (log.ansi) s.term!.write(log.ansi);
    // 终端标签会被重新拉起成可输入的 shell，不该再提示"点重跑"
    const tail =
      s.kind === "terminal" ? "────" : "（进程未运行，点下方「⟳ 重跑」重新执行）────";
    s.term!.write(`\r\n\x1b[90m${RESTORE_MARKER}${tail}\x1b[0m\r\n`);
  }

  renderTabs();

  // 终端标签恢复成**可以直接输入的 shell**：历史留在上面，下面接一个新提示符。
  // （run / build 标签仍保持"只读历史 + 重跑"，因为它们绑定了具体命令）
  for (const s of sessions) {
    if (s.kind !== "terminal" || !s.projectId) continue;
    void (async () => {
      try {
        // 历史输出已经写进缓冲区；再补一整屏空行，把历史顶到回滚区。
        // 新 shell 的 ConPTY 是从自己的第 0 行开始画提示符的，直接接在历史后面时，
        // 提示符/命令会覆盖到历史顶部，和日志混在一起（实测）。
        if (s.term) {
          await new Promise<void>((resolve) => {
            // 恢复时终端还没 fit，rows 可能只是默认的 24；至少补 60 行，
            // 保证把历史顶出当前可见区域，给新 shell 留一整屏空白。
            s.term!.write("\r\n".repeat(Math.max(s.term!.rows * 2, 60)), resolve);
          });
          await new Promise<void>((resolve) => {
            // 清掉可见区（历史已经在上方回滚区），并把光标归位到左上角。
            // 新 shell 的 ConPTY 也从它自己的第 0 行开始画提示符，坐标对齐后，
            // 后续 ↑/↓ 重绘不会再跑到顶部和旧日志叠在一起。
            s.term!.write("\x1b[2J\x1b[H", resolve);
          });
        }

        const started = await invoke<boolean>("resume_terminal", {
          projectId: s.projectId,
          sessionId: s.id,
          rows: 30,
          cols: 100,
        });
        if (!started) return;
        s.restored = false;
        s.status = "running";
        renderTabs();
        updateControls();
      } catch {
        /* 项目已移除就保持只读历史 */
      }
    })();
  }

  activateSession(sessions[0].id);
  renderStatus();
}

async function rerunSession(s: TermSession): Promise<void> {
  // 连点「重跑」时第二次点击会看到同一个旧会话，不能让它再起一个进程
  const key = `rerun|${s.id}`;
  if (markLaunching(key)) return;
  try {
    await rerunSessionNow(s);
  } finally {
    launchingKeys.delete(key);
  }
}

async function rerunSessionNow(s: TermSession): Promise<void> {
  // 工具栏自定义命令：先结束旧进程，再启动一条新标签，成功后才移除旧标签
  if (s.kind === "custom") {
    const cmd = state.customCommands?.find((c) => c.id === s.customCommandId);
    if (!cmd) {
      toast("原自定义命令已删除", "error");
      return;
    }
    if (s.status !== "stopped") {
      await invoke("kill_session", { id: s.id }).catch(() => {});
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    await runCustomCommand(cmd, s.id);
    return;
  }

  const project = state.projects.find((p) => p.id === s.projectId);
  if (!project) {
    toast("原项目已不存在，无法重跑", "error");
    return;
  }

  // 项目终端：先 Ctrl+C 中断当前命令，等回到提示符，再把同一条命令带 Enter 写进去。
  // 这样 go run 之类的长命令不需要用户再手动敲一次、按一次回车。
  if (s.kind === "terminal") {
    if (s.restored) {
      toast("终端还在恢复，请稍等", "error");
      return;
    }
    const cmd = s.commandId
      ? project.commands.find((c) => c.id === s.commandId)
      : undefined;
    if (!cmd || cmd.kind !== "custom") {
      toast("这个终端还没有可重跑的命令", "error");
      return;
    }
    // 已经停止（刚点过停止）就不用再发 Ctrl+C，直接在同一个 shell 里重跑
    if (s.status !== "stopped") {
      await invoke("write_session", { id: s.id, data: "\x03" }).catch(() => {});
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    await runInTerminal(project, cmd, s);
    return;
  }

  if (s.commandId) {
    const cmd = project.commands.find((c) => c.id === s.commandId);
    if (cmd) {
      // run 会话的「重跑」= 立刻重跑：外部程序（npm run dev 等）重新起一条会话，
      // flutter run 重新走「shell + 哨兵」的执行链。
      // 以前这里走 prefill_run（只把命令敲到提示符、不回车），用户还得手动按 Enter。
      // 新会话先挂上（失败时旧标签还在），成功后再把旧标签**原位替换**——
      // 直接关旧开新会把标签追加到列表末尾，顺序全乱。
      // 用命令本身的类型判定，而不是会话记录里的 kind——
      // 老会话记录可能没有 kind 字段，会导致 run 走错分支（不替换标签）
      const replace = cmd.kind === "run" && s.kind !== "terminal" ? s.id : null;
      const fresh = await runCommand(project, cmd);
      if (fresh && replace && fresh.id !== replace) {
        // runCommand 通常已经按「同名停止标签」替换过了；这里兜底旧标签还在的情况
        if (sessions.some((x) => x.id === replace)) {
          replaceSessionInPlace(replace, fresh.id);
        }
      }
      return;
    }
  }

  if (s.templateId) {
    const tpl = state.commandTemplates.find((t) => t.id === s.templateId);
    if (tpl) {
      await runTemplate(project, tpl);
      return;
    }
  }

  // 派生动作（平台菜单）：按平台重新走一遍，设备会重新解析
  if (s.platform && s.action) {
    // run 类：替换旧标签（flutter run 没有"恢复现场"，死标签只会混淆）
    // build 类：保留旧标签，历史输出还有参考价值
    const replaceId = s.action === "build" ? undefined : s.id;
    await runPlatformAction(
      project,
      s.platform,
      {
        action: s.action,
        command: "",
        label: s.title,
        target: s.target ?? null,
        enabled: true,
        reason: null,
      },
      replaceId,
    );
    return;
  }

  toast("找不到原命令（可能已被删除），请重新选择", "error");
}

function handleOutput(id: string, data: string): void {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;

  if (!s.term) {
    const buf = pendingOutput.get(id) ?? [];
    buf.push(data);
    pendingOutput.set(id, buf);
  } else {
    s.term.write(data);
  }

  // 锚点可能被切块，用滚动窗口匹配
  s.scan = (s.scan + data).slice(-4000);

  // 构建产物：flutter 输出形如 "✓ Built build\app\outputs\flutter-apk\app-release.apk"
  if (s.kind === "build") {
    let added = false;
    for (const m of data.matchAll(/Built\s+([^\r\n]+)/g)) {
      const p = (m[1] ?? "").replace(/["']/g, "").trim();
      if (p && !s.artifacts.includes(p)) {
        s.artifacts.push(p);
        added = true;
      }
    }
    if (added && s.id === activeSessionId) updateControls();
  }

  if (s.status !== "running" && s.scan.includes("Flutter run key commands.")) {
    s.status = "running";
    s.flutterRunning = true;
    renderTabs();
    updateControls();
  }

  // 哨兵：shell 模式下 flutter run 退出时会打印（前后被 ESC[2K\r 抹掉，用户看不见）
  const runEnd = s.scan.match(/__FLA_RUN_END__:(-?\d+)/);
  if (runEnd && s.flutterRunning) {
    s.flutterRunning = false;
    s.status = "stopped";
    s.exitCode = Number(runEnd[1]);
    renderTabs();
    updateControls();
  }

  if (!s.devToolsUrl) {
    const m = s.scan.match(
      /The Flutter DevTools debugger and profiler on .*? is available at:\s*(\S+)/,
    );
    if (m) {
      s.devToolsUrl = m[1];
      updateControls();
    }
  }

  // 批处理提示：不回答的话 cmd.exe 会一直等，会话状态就永远停不下来
  answerBatchPrompt(s, data);
}

/** cmd.exe 在批处理里收到 Ctrl+C 会问「终止批处理操作吗(Y/N)?」并一直等输入。
 *  没人回答时 `cmd /c` 这层包装永远不退出 → pty://exit 不来，
 *  于是终端里程序已经没了、状态还显示「运行中」。
 *  用户按 Ctrl+C 就是要停，这里替他回答 Y（一次提示只答一次）。 */
const BATCH_JOB_PROMPT = /(?:终止批处理操作吗|Terminate batch job)[^\r\n]*?\(Y\/N\)\?\s*$/i;

function answerBatchPrompt(s: TermSession, chunk: string): void {
  s.promptTail = ((s.promptTail ?? "") + chunk).slice(-200);
  if (!BATCH_JOB_PROMPT.test(s.promptTail)) return;
  s.promptTail = "";
  void invoke("write_session", { id: s.id, data: "Y\r" }).catch(() => {});
}

function handleExit(id: string, code: number | null): void {
  const s = sessions.find((x) => x.id === id);
  if (!s || s.status === "stopped") return;

  s.status = "stopped";
  s.exitCode = code;
  // 进程都没了就不可能还在跑 flutter，否则热重载工具条会一直亮着
  s.flutterRunning = false;
  const label = code == null ? "已终止" : `退出码 ${code}`;
  s.term?.write(`\r\n\x1b[90m──── 会话结束（${label}）────\x1b[0m\r\n`);
  renderTabs();
  renderStatus();
  updateControls();

  // D-11：构建结束发系统通知
  if (s.kind === "build") void notifyBuild(s);

  schedulePersist();
}

async function notifyBuild(s: TermSession): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;

    const failed = (s.exitCode ?? 0) !== 0;
    sendNotification({
      title: failed ? "构建失败" : "构建完成",
      body: failed
        ? `${s.title} · 退出码 ${s.exitCode ?? "未知"}`
        : `${s.title}${s.artifacts.length ? ` · ${s.artifacts[s.artifacts.length - 1]}` : ""}`,
    });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

async function revealArtifact(s: TermSession, rel: string): Promise<void> {
  const base = s.cwd.replace(/[\\/]+$/, "");
  const abs = /^[a-zA-Z]:[\\/]/.test(rel) ? rel : `${base}\\${rel.replace(/\//g, "\\")}`;
  try {
    await revealItemInDir(abs);
  } catch (e) {
    toast(`打开失败：${String(e)}`, "error");
  }
}

/* ---------------- 设备菜单（M3） ---------------- */

let deviceMenuEl: HTMLDivElement | null = null;

function closeDeviceMenu(): void {
  deviceMenuEl?.remove();
  deviceMenuEl = null;
}

/** 服务节点右键：停止 / 重启 / 删除容器 / 日志 / 进入 shell */
function openServiceMenu(
  ev: MouseEvent,
  p: Proj,
  service: string,
  actions: Cmd[],
): void {
  closeAllMenus();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 340)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 360)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>📦 ${esc(service)} <span class="dm-tag">服务</span></span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const byRole = (role: string): Cmd | undefined => actions.find((a) => a.role === role);

  const rows: MenuRow[] = [];

  const start = byRole("up");
  if (start) {
    rows.push({
      kind: "item",
      name: "启动",
      detail: "up -d（后台运行）",
      onClick: () => void runCommand(p, start),
    });
  }

  const stop = byRole("stop");
  if (stop) {
    rows.push({
      kind: "item",
      name: "停止",
      detail: "容器保留，可再次启动",
      onClick: () => void runCommand(p, stop),
    });
  }

  const restart = byRole("restart");
  if (restart) {
    rows.push({
      kind: "item",
      name: "重启",
      detail: "不重建容器",
      onClick: () => void runCommand(p, restart),
    });
  }

  const logs = byRole("logs");
  if (logs) {
    rows.push({
      kind: "item",
      name: "日志",
      detail: "logs -f，持续输出",
      onClick: () => void runCommand(p, logs),
    });
  }

  const shell = byRole("shell");
  if (shell) {
    rows.push({
      kind: "item",
      name: "进入 shell",
      detail: "exec sh，退出即结束",
      onClick: () => void runCommand(p, shell),
    });
  }

  const rm = byRole("rm");
  if (rm) {
    rows.push({ kind: "sep" });
    rows.push({
      kind: "item",
      name: "删除容器…",
      detail: "rm -f -s：容器删除，卷保留",
      onClick: () => {
        void (async () => {
          const ok = await confirm(
            `删除服务「${service}」的容器？\n\n` +
              `docker compose rm -f -s ${service}\n\n` +
              `容器会被删除（不可撤销），数据卷默认保留。`,
            { title: "删除容器", kind: "warning" },
          );
          if (ok) void runCommand(p, rm);
        })();
      },
    });
  }

  const box = document.createElement("div");
  menu.querySelector(".dm-body")!.appendChild(box);
  renderMenuRows(box, rows);
}

/**
 * 这条命令是否真的需要挑设备。
 *
 * 只有「跑起来并连设备」的 flutter run 类命令才有意义；
 * npm / docker / build / 模板命令（如 Pub Get）跟设备毫无关系，
 * 给它们弹「自动选择 / windows / chrome / Pixel5」是纯误导。
 */
function needsDevice(c: Cmd): boolean {
  if (c.kind !== "run") return false;
  const src = (c.source ?? "").toLowerCase();
  if (src === "npm" || src === "docker") return false;
  // launch.json 里的命令都是 flutter run 配置，program 是空的（后端才拼 flutter run）
  if (src === "launch-json") return true;
  const prog = (c.program ?? "").toLowerCase();
  return prog.includes("flutter");
}

/** 命令右键：需要设备 → 设备菜单；否则 → 普通命令菜单 */
function openCommandMenu(ev: MouseEvent, p: Proj, c: Cmd): void {
  if (needsDevice(c)) {
    openDeviceMenu(ev, p, c);
    return;
  }

  ev.preventDefault();
  closeDeviceMenu();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - 320))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - 220))}px`;
  menu.innerHTML = `
    <div class="dm-head">${esc(c.name)}</div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  deviceMenuEl = menu;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  const addGroup = (title: string): void => {
    const g = document.createElement("div");
    g.className = "dm-group";
    g.textContent = title;
    body.appendChild(g);
  };

  const addItem = (name: string, sub: string, onClick: () => void): void => {
    const item = document.createElement("div");
    item.className = "dm-item";
    item.innerHTML = `<span class="dm-name">${esc(name)}</span>${sub ? `<span class="dm-sub">${esc(sub)}</span>` : ""}`;
    item.addEventListener("click", () => {
      closeDeviceMenu();
      onClick();
    });
    body.appendChild(item);
  };

  // 运行提示按类型说清楚它会落在哪：普通命令进项目终端，run/build 各占一个标签
  const where =
    c.kind === "custom"
      ? "在项目终端里执行（跑完还能接着敲）"
      : c.kind === "build"
        ? "独立标签，结束发通知、识别产物"
        : "独立标签运行";

  addItem("运行", where, () => void runCommand(p, c));

  addGroup("命令");
  addItem("编辑命令…", "名称 / 参数 / 环境变量", () => void openCommandDialog(p, c));
  addItem("删除命令", "从项目里移除（不影响磁盘文件）", () => {
    void (async () => {
      const ok = await confirm(`删除命令「${c.name}」？`, {
        title: "删除命令",
        kind: "warning",
      });
      if (!ok) return;
      try {
        state = await invoke<State>("remove_command", {
          projectId: p.id,
          commandId: c.id,
        });
        render();
        toast("命令已删除");
      } catch (e) {
        toast(String(e), "error");
      }
    })();
  });
}

/** 设备/模拟器列表：查一次就缓存，之后靠菜单里的「刷新设备列表」手动更新。
 *  每次打开菜单都去问 flutter daemon 太浪费（首次要拉起 daemon，好几秒）。 */
let devicePayloadCache: DevicesPayload | null = null;

function openDeviceMenu(ev: MouseEvent, p: Proj, c: Cmd): void {
  ev.preventDefault();
  closeDeviceMenu();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - 320))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - 360))}px`;
  menu.innerHTML = `
    <div class="dm-head">为「${esc(c.name)}」选择设备</div>
    <div class="dm-body"><div class="dm-loading">正在查询设备…</div></div>
  `;
  document.body.appendChild(menu);
  deviceMenuEl = menu;
  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  void (async () => {
    let payload: DevicesPayload | null = devicePayloadCache;
    let error: string | null = null;
    if (!payload) {
      try {
        payload = await invoke<DevicesPayload>("list_devices", { projectId: p.id });
        devicePayloadCache = payload;
      } catch (e) {
        error = String(e);
      }
      if (deviceMenuEl !== menu) return; // 期间已被关闭
    }
    body.innerHTML = "";

    const addGroup = (title: string): void => {
      const g = document.createElement("div");
      g.className = "dm-group";
      g.textContent = title;
      body.appendChild(g);
    };

    const addItem = (name: string, sub: string, onClick: () => void, cls = ""): void => {
      const item = document.createElement("div");
      item.className = `dm-item ${cls}`.trim();
      item.innerHTML = `<span class="dm-name">${esc(name)}</span>${sub ? `<span class="dm-sub">${esc(sub)}</span>` : ""}`;
      item.addEventListener("click", () => {
        closeDeviceMenu();
        onClick();
      });
      body.appendChild(item);
    };

    addItem("自动选择", "不传 -d，由 flutter 自行决定", () => void runCommand(p, c));

    if (error) {
      const e = document.createElement("div");
      e.className = "dm-error";
      e.textContent = error;
      body.appendChild(e);
      return;
    }

    const devices = payload?.devices ?? [];
    const emulators = payload?.emulators ?? [];

    addGroup(`在线设备 (${devices.length})`);
    if (devices.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dm-empty";
      empty.textContent = "暂无在线设备";
      body.appendChild(empty);
    } else {
      for (const d of devices) {
        addItem(d.name, `${d.id} · ${d.platform ?? d.category ?? ""}`, () =>
          void runCommand(p, c, d.id),
        );
      }
    }

    if (emulators.length > 0) {
      addGroup(`可启动模拟器 (${emulators.length})`);
      for (const m of emulators) {
        addItem(
          m.name,
          `${m.id} · ${m.category ?? ""}`,
          () => {
            toast(`正在启动模拟器：${m.name}`);
            void invoke("launch_emulator", { projectId: p.id, emulatorId: m.id }).catch((e2) =>
              toast(String(e2), "error"),
            );
          },
          "emulator",
        );
      }
    }

    addGroup("设备");
    addItem("⟳ 刷新设备列表", "重新查询（首次会拉起 flutter daemon，约几秒）", () => {
      devicePayloadCache = null;
      openDeviceMenu(ev, p, c);
    });

    addGroup("命令");
    addItem("编辑命令…", "名称 / 设备 / 参数 / 构建目标", () => void openCommandDialog(p, c));
  })();
}

/* ---------------- 命令编辑（M5：构建命令） ---------------- */

function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** 常用配置示例：新用户不知道占位符和脚本怎么写，给一份可照抄的清单 */
function showUsageExamples(
  apply: (ex: { program: string; args: string; cwd: string; scope: string }) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 760px">
      <div class="modal-head">
        <span>使用示例</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="ex-body"></div>
      <div class="modal-foot">
        <span class="modal-hint">点示例右侧「填入」可直接写进当前表单</span>
        <span class="flex1"></span>
        <button class="btn primary" id="ex-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#ex-body") as HTMLDivElement;
  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#ex-close") as HTMLButtonElement).addEventListener("click", close);

  const note = document.createElement("div");
  note.className = "set-desc";
  note.textContent =
    "占位符：%FLUTTER% = 该项目的 flutter；%PROJECT% = 项目根目录；%CWD% = 实际工作目录。"
    + " program / args / cwd 里都能用。";
  body.appendChild(note);

  const examples: Array<{
    title: string;
    desc: string;
    program: string;
    args: string;
    cwd: string;
    scope: string;
  }> = [
    {
      title: "跑项目里的 PowerShell 脚本",
      desc: "自动用 PowerShell 执行（含 -ExecutionPolicy Bypass），以项目根为工作目录",
      program: String.raw`D:\demo\code\flutter\library\projects\jbook\build_abb.ps1`,
      args: "",
      cwd: "",
      scope: "项目",
    },
    {
      title: "脚本 + 传项目目录",
      desc: "把项目根作为命名参数传进去（位置参数可能被脚本当成别的选项）",
      program: String.raw`D:\path\to\i18n_update.ps1`,
      args: "-ScanDir %PROJECT%",
      cwd: "",
      scope: "全局",
    },
    {
      title: "只靠工作目录找项目",
      desc: "脚本自己从 cwd 向上找 pubspec.yaml —— 全局模板最常用，任何项目都能跑",
      program: String.raw`D:\path\to\tool.ps1`,
      args: "",
      cwd: "",
      scope: "全局",
    },
    {
      title: "用项目自己的 flutter",
      desc: "鸿蒙工程会自动指向鸿蒙分支；配合 args 可执行任意 flutter 子命令",
      program: "%FLUTTER%",
      args: "pub get",
      cwd: "",
      scope: "全局",
    },
    {
      title: "在子目录执行",
      desc: "cwd 相对项目根，也可用 %PROJECT% 显式拼接",
      program: "%FLUTTER%",
      args: "pub get",
      cwd: "%PROJECT%\\packages\\tao996",
      scope: "项目",
    },
    {
      title: "运行批处理",
      desc: ".bat / .cmd 会自动经 cmd.exe 包装，无需自己拼 cmd /c",
      program: String.raw`D:\path\to\build.bat`,
      args: "--release",
      cwd: "",
      scope: "项目",
    },
  ];

  for (const ex of examples) {
    const card = document.createElement("div");
    card.className = "ex-card";

    const head = document.createElement("div");
    head.className = "ex-head";

    const title = document.createElement("span");
    title.className = "ex-title";
    title.textContent = ex.title;

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = ex.scope;

    const fill = document.createElement("button");
    fill.className = "btn";
    fill.textContent = "填入";
    fill.addEventListener("click", () => {
      apply({ program: ex.program, args: ex.args, cwd: ex.cwd, scope: ex.scope });
      close();
      toast("已填入表单（记得点保存）");
    });

    head.append(title, chip, fill);
    card.appendChild(head);

    const desc = document.createElement("div");
    desc.className = "set-desc";
    desc.textContent = ex.desc;
    card.appendChild(desc);

    for (const [k, v] of [
      ["程序", ex.program],
      ["参数", ex.args || "（空）"],
      ["cwd", ex.cwd || "（空 = 项目根）"],
    ] as Array<[string, string]>) {
      const line = document.createElement("div");
      line.className = "ex-line";
      const key = document.createElement("span");
      key.className = "ex-key";
      key.textContent = k;
      const val = document.createElement("code");
      val.textContent = v;
      line.append(key, val);
      card.appendChild(line);
    }

    body.appendChild(card);
  }

  document.body.appendChild(overlay);
}

/** 模板库窗口开着时，保存模板后要立刻刷新列表（否则得关掉重开才看到） */
let templateListRefresh: (() => void) | null = null;

/* ---------------- 命令类型：flutter / 自定义 / 三种 Shell ---------------- */

type ShellType = "powershell" | "cmd" | "bash";
type CmdType = "run" | "build" | "custom" | ShellType;

/**
 * Shell 类型只是「预设程序 + 参数包装」的 UI 糖：
 * 落盘仍是 kind=custom，后端无需区分；编辑时再按 program/args 反推回类型。
 */
const SHELL_SPECS: Record<
  ShellType,
  {
    exe: string;
    label: string;
    placeholder: string;
    wrap: (script: string) => string[];
    note: string;
  }
> = {
  powershell: {
    exe: "powershell.exe",
    label: "PowerShell",
    placeholder: "Get-Process | Sort-Object WS -Descending | Select-Object -First 10",
    wrap: (script) => [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    note: "以 powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 执行。",
  },
  cmd: {
    exe: "cmd.exe",
    label: "CMD",
    placeholder: "dir /b",
    wrap: (script) => ["/C", script],
    note: "以 cmd.exe /C 执行，支持 && / || 等 CMD 语法。",
  },
  bash: {
    exe: "bash.exe",
    label: "Bash",
    placeholder: "ls -la",
    wrap: (script) => ["-lc", script],
    note: "以 bash.exe -lc 执行（PATH 中需要有 Git Bash / WSL 的 bash）。",
  },
};

const isShellType = (t: string): t is ShellType =>
  t === "powershell" || t === "cmd" || t === "bash";

/** 选中 Shell 类型时自动填的名字：切类型时如果还是自动名字就跟着换 */
const SHELL_AUTO_NAMES = new Set(
  Object.values(SHELL_SPECS).map((spec) => `${spec.label} 命令`),
);

/** 从已保存的命令反推 Shell 类型；不是我们生成的包装就返回 null */
function shellTypeOf(c: Cmd | undefined): ShellType | null {
  if (!c || c.kind !== "custom") return null;

  const base = (c.program ?? "").trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const args = c.args ?? [];
  const flag = (name: string): boolean => args.some((a) => a.toLowerCase() === name);

  if (
    ["powershell.exe", "powershell"].includes(base) &&
    flag("-command")
  ) {
    return "powershell";
  }
  if (["cmd.exe", "cmd"].includes(base) && args[0]?.toLowerCase() === "/c") {
    return "cmd";
  }
  if (["bash.exe", "bash"].includes(base) && args[0] === "-lc") {
    return "bash";
  }
  return null;
}

/** 从包装参数里取回用户写的命令文本 */
function shellScriptOf(c: Cmd, type: ShellType): string {
  const args = c.args ?? [];
  if (type === "powershell") {
    const i = args.findIndex((a) => a.toLowerCase() === "-command");
    return i >= 0 ? args.slice(i + 1).join(" ") : "";
  }
  return args.slice(1).join(" ");
}

async function openCommandDialog(p: Proj | null, existing?: Cmd): Promise<void> {
  const isTemplate = p === null;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 640px">
      <div class="modal-head">
        <span>${existing ? (isTemplate ? "编辑模板" : "编辑命令") : isTemplate ? "新建模板" : "添加命令"}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="cmd-body"></div>
      <div class="modal-foot">
        <span class="modal-hint" id="cmd-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="cmd-examples">使用示例</button>
        ${existing ? '<button class="btn" id="cmd-del">删除</button>' : ""}
        <button class="btn" id="cmd-cancel">取消</button>
        <button class="btn primary" id="cmd-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#cmd-body") as HTMLDivElement;
  const hint = overlay.querySelector("#cmd-hint") as HTMLSpanElement;
  const close = (): void => overlay.remove();

  // 从已有 args 里拆出 flavor
  let flavor = "";
  let restArgs = [...(existing?.args ?? [])];
  const fi = restArgs.findIndex((a) => a === "--flavor");
  if (fi >= 0) {
    flavor = restArgs[fi + 1] ?? "";
    restArgs = restArgs.filter((_, i) => i !== fi && i !== fi + 1);
  }

  const inferredShell = shellTypeOf(existing);
  const initialType: CmdType =
    inferredShell ??
    (existing
      ? existing.kind === "run" || existing.kind === "build"
        ? existing.kind
        : "custom"
      : p?.kind === "folder"
        ? "custom"
        : "run");

  const draft = {
    name: existing?.name ?? "",
    type: initialType,
    program: existing?.program ?? "",
    cwd: existing?.cwd ?? "",
    mode: existing?.flutterMode ?? "debug",
    target: existing?.buildType ?? "apk",
    flavor,
    args: restArgs.join(" "),
    script: inferredShell && existing ? shellScriptOf(existing, inferredShell) : "",
    envPairs: Object.entries(existing?.env ?? {}) as Array<[string, string]>,
    scope: existing?.scope === "global" ? "global" : "project",
  };

  let targets: BuildTarget[] | null = null;

  const row = (label: string): [HTMLDivElement, HTMLElement] => {
    const r = document.createElement("div");
    r.className = "set-row";
    const l = document.createElement("label");
    l.textContent = label;
    const cell = document.createElement("div");
    cell.className = "set-cell";
    r.append(l, cell);
    body.appendChild(r);
    return [r, cell];
  };

  const input = (parent: HTMLElement, value: string, placeholder: string, onInput: (v: string) => void): void => {
    const el = document.createElement("input");
    el.className = "set-input";
    el.value = value;
    el.placeholder = placeholder;
    el.addEventListener("input", () => onInput(el.value));
    parent.appendChild(el);
  };

  const build = async (): Promise<void> => {
    body.innerHTML = "";

    {
      const [, cell] = row("名称");
      input(cell, draft.name, "如 GooglePlayReleaseProd", (v) => {
        draft.name = v;
      });
    }

    {
      const [, cell] = row("类型");
      const sel = document.createElement("select");
      sel.className = "set-input";
      const types: Array<[CmdType, string]> = [
        ["run", "run（flutter 调试运行）"],
        ["build", "build（flutter 发布构建）"],
        ["custom", "custom（自定义命令）"],
        ["powershell", "powershell（执行 PowerShell 命令）"],
        ["cmd", "cmd（执行 CMD 命令）"],
        ["bash", "bash（执行 Bash 命令）"],
      ];
      for (const [k, label] of types) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = label;
        if (draft.type === k) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = Boolean(existing);
      sel.addEventListener("change", () => {
        const autoNamed = SHELL_AUTO_NAMES.has(draft.name.trim());
        draft.type = sel.value as CmdType;
        // 新建 Shell 命令时给一个能直接保存的名称；用户已经填了就不动
        if (!draft.name.trim() || autoNamed) {
          draft.name = isShellType(draft.type)
            ? `${SHELL_SPECS[draft.type].label} 命令`
            : "";
        }
        void build();
      });
      cell.appendChild(sel);
    }

    if (draft.type === "custom") {
      const [, c1] = row("程序");
      input(c1, draft.program, "%FLUTTER% 或 C:\\path\\to\\tool.exe", (v) => {
        draft.program = v;
      });
      // 选脚本/可执行文件，省得手打长路径
      const pick = document.createElement("button");
      pick.className = "btn";
      pick.textContent = "浏览…";
      pick.title = "选择脚本或可执行文件";
      pick.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择要执行的程序",
              filters: [
                { name: "脚本与程序", extensions: ["ps1", "bat", "cmd", "exe"] },
                { name: "全部文件", extensions: ["*"] },
              ],
              defaultPath: draft.program || undefined,
            });
            if (!picked) return;
            draft.program = Array.isArray(picked) ? picked[0] : picked;
            void build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });
      c1.appendChild(pick);

      const [, c2] = row("cwd");
      input(c2, draft.cwd, "可空（相对项目根，支持 %PROJECT%）", (v) => {
        draft.cwd = v;
      });
      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent =
        "%FLUTTER% → 该项目的 flutter；%PROJECT% → 项目根；%CWD% → 实际工作目录。" +
        ".ps1 自动用 PowerShell（含 -ExecutionPolicy Bypass）执行；.bat / .cmd 自动用 cmd 包装。";
      body.appendChild(note);
    } else if (isShellType(draft.type)) {
      const spec = SHELL_SPECS[draft.type];

      const [, c1] = row("命令");
      const ta = document.createElement("textarea");
      ta.className = "set-input cmd-script";
      ta.rows = 3;
      ta.value = draft.script;
      ta.placeholder = spec.placeholder;
      ta.spellcheck = false;
      ta.addEventListener("input", () => {
        draft.script = ta.value;
      });
      c1.appendChild(ta);

      const [, c2] = row("cwd");
      input(c2, draft.cwd, "可空（相对项目根，支持 %PROJECT%）", (v) => {
        draft.cwd = v;
      });

      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent = `${spec.note} 命令在项目终端中执行，输出进入当前标签。`;
      body.appendChild(note);
    } else if (draft.type === "run") {
      const [, c1] = row("program");
      input(c1, draft.program, "lib/main.dart（可空）", (v) => {
        draft.program = v;
      });
      const [, c2] = row("cwd");
      input(c2, draft.cwd, "projects/xxx（可空）", (v) => {
        draft.cwd = v;
      });
      const [, c3] = row("模式");
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["debug", "profile", "release"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        if (draft.mode === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.mode = sel.value;
      });
      c3.appendChild(sel);
    } else {
      if (targets === null) {
        hint.textContent = "正在探测构建目标…";
        try {
          targets = await invoke<BuildTarget[]>("build_targets", {
            projectId: p?.id ?? null,
          });
          hint.textContent = "";
        } catch (e) {
          hint.textContent = String(e);
          targets = [];
        }
      }

      const [, c1] = row("构建目标");
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const t of targets) {
        const o = document.createElement("option");
        o.value = t.name;
        o.textContent = `${t.name} — ${t.description}`;
        if (draft.target === t.name) o.selected = true;
        sel.appendChild(o);
      }
      const cur = targets.find((t) => t.name === draft.target);
      if (!cur && targets.length > 0) draft.target = targets[0].name;
      sel.addEventListener("change", () => {
        draft.target = sel.value;
        void build();
      });
      c1.appendChild(sel);

      const [, c2] = row("flavor");
      input(c2, draft.flavor, "可空（如 prod）", (v) => {
        draft.flavor = v;
      });
      const supported = targets.find((t) => t.name === draft.target)?.supportsFlavor ?? false;
      c2.classList.toggle("disabled", !supported);
      const note = document.createElement("div");
      note.className = "set-note";
      note.textContent = supported ? "该目标支持 --flavor" : "该目标不支持 --flavor（留空）";
      c2.appendChild(note);
    }

    // Shell 类型把「命令」单独收在 textarea 里，不再有额外参数
    if (!isShellType(draft.type)) {
      const [, cell] = row("额外参数");
      input(
        cell,
        draft.args,
        draft.type === "custom" ? "原样传给程序" : "--dart-define=ENV=prod",
        (v) => {
          draft.args = v;
        },
      );
    }

    // 环境变量
    {
      const title = document.createElement("div");
      title.className = "set-title";
      title.style.marginTop = "14px";
      title.textContent = "环境变量";
      body.appendChild(title);

      const list = document.createElement("div");
      list.className = "env-list";

      draft.envPairs.forEach((pair, idx) => {
        const r = document.createElement("div");
        r.className = "env-row";

        const kEl = document.createElement("input");
        kEl.className = "set-input env-key";
        kEl.value = pair[0];
        kEl.placeholder = "KEY";
        kEl.addEventListener("input", () => {
          draft.envPairs[idx][0] = kEl.value;
        });

        const vEl = document.createElement("input");
        vEl.className = "set-input";
        vEl.value = pair[1];
        vEl.placeholder = "value";
        vEl.addEventListener("input", () => {
          draft.envPairs[idx][1] = vEl.value;
        });

        const del = document.createElement("button");
        del.className = "btn";
        del.textContent = "×";
        del.title = "删除该变量";
        del.addEventListener("click", () => {
          draft.envPairs.splice(idx, 1);
          void build();
        });

        r.append(kEl, vEl, del);
        list.appendChild(r);
      });

      const add = document.createElement("button");
      add.className = "btn";
      add.textContent = "＋ 添加变量";
      add.addEventListener("click", () => {
        draft.envPairs.push(["", ""]);
        void build();
      });
      list.appendChild(add);
      body.appendChild(list);
    }

    // 作用域（仅模板有意义）
    if (isTemplate) {
      const [, cell] = row("作用域");
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const sc of ["project", "global"]) {
        const o = document.createElement("option");
        o.value = sc;
        o.textContent =
          sc === "global"
            ? "全局（项目右键直接执行，无需加入项目）"
            : "项目（导入到项目后才能执行）";
        if (draft.scope === sc) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.scope = sel.value;
      });
      cell.appendChild(sel);
    }

    if (draft.type === "build") {
      const tip = document.createElement("div");
      tip.className = "set-desc";
      tip.style.marginTop = "10px";
      tip.textContent = "构建始终以 --release 执行；产物路径会在终端中解析，并在结束后发系统通知。";
      body.appendChild(tip);
    }
  };

  await build();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#cmd-cancel") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#cmd-examples") as HTMLButtonElement).addEventListener("click", () =>
    showUsageExamples((ex) => {
      // 示例都是 custom 的写法；新建时切过去，编辑已有命令时不偷偷改类型
      if (!existing) draft.type = "custom";
      draft.program = ex.program;
      draft.args = ex.args;
      draft.cwd = ex.cwd;
      draft.scope = ex.scope === "全局" ? "global" : "project";
      void build();
      toast("已填入表单，记得点「保存」");
    }),
  );
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector("#cmd-del")?.addEventListener("click", () => {
    void (async () => {
      if (!existing) return;
      const ok = await confirm(
        `删除${isTemplate ? "模板" : "命令"}「${existing.name}」？`,
        { title: isTemplate ? "删除模板" : "删除命令", kind: "warning" },
      );
      if (!ok) return;
      try {
        state = isTemplate
          ? await invoke<State>("remove_template", { id: existing.id })
          : await invoke<State>("remove_command", {
              projectId: p!.id,
              commandId: existing.id,
            });
        close();
        render();
        toast(isTemplate ? "模板已删除" : "命令已删除");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  (overlay.querySelector("#cmd-save") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      if (!draft.name.trim()) {
        hint.textContent = "请填写名称";
        return;
      }

      const shellSpec = isShellType(draft.type) ? SHELL_SPECS[draft.type] : null;
      if (shellSpec && !draft.script.trim()) {
        hint.textContent = "请填写要执行的命令";
        return;
      }

      const args = shellSpec ? shellSpec.wrap(draft.script.trim()) : splitArgs(draft.args);
      if (draft.type === "build" && draft.flavor.trim()) {
        args.unshift("--flavor", draft.flavor.trim());
      }

      const cmd: Cmd = {
        id: existing?.id ?? "",
        name: draft.name.trim(),
        // Shell 类型落盘仍是 custom，避免后端为每种 shell 再加一套分支
        kind: shellSpec ? "custom" : draft.type,
        program: shellSpec
          ? shellSpec.exe
          : draft.type === "custom" || draft.type === "run"
            ? draft.program.trim() || null
            : null,
        cwd:
          shellSpec || draft.type === "custom" || draft.type === "run"
            ? draft.cwd.trim() || null
            : null,
        flutterMode: draft.type === "run" ? draft.mode : null,
        args,
        env: Object.fromEntries(
          draft.envPairs
            .filter(([k]) => k.trim() !== "")
            .map(([k, v]) => [k.trim(), v]),
        ),
        toolArgs: existing?.toolArgs ?? [],
        deviceId: existing?.deviceId ?? null,
        emulatorId: existing?.emulatorId ?? null,
        buildType: draft.type === "build" ? draft.target : null,
        source: isTemplate ? "template" : "manual",
        scope: isTemplate ? draft.scope : "project",
        // 编辑已有命令时保留来源归属，否则 docker 服务节点会被打散
        stale: existing?.stale ?? false,
        group: existing?.group ?? null,
        role: existing?.role ?? null,
      };

      try {
        state = isTemplate
          ? await invoke<State>("upsert_template", { template: cmd })
          : await invoke<State>("upsert_command", { projectId: p!.id, command: cmd });
        close();
        render();
        // 模板库窗口还开着时要立刻刷新，否则要关掉重开才看得到新模板
        if (isTemplate) templateListRefresh?.();
        toast(existing ? "已更新" : isTemplate ? "模板已保存" : "命令已添加");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 通用菜单（支持二级） ---------------- */

type MenuRow =
  | { kind: "group"; text: string }
  | { kind: "sep" }
  | {
      kind: "item";
      name: string;
      detail?: string;
      disabled?: boolean;
      onClick?: () => void;
      children?: MenuRow[];
      /** 点击后不关菜单（用于"原地刷新某一段"这类动作） */
      keepOpen?: boolean;
    };

/** 二级子菜单（本项目最多两层：右键菜单 → 平台 → 动作） */
let subMenuEl: HTMLDivElement | null = null;

function closeSubMenu(): void {
  subMenuEl?.remove();
  subMenuEl = null;
}

let toolsMenuEl: HTMLDivElement | null = null;

function closeAllMenus(): void {
  closeSubMenu();
  projMenuEl?.remove();
  projMenuEl = null;
  toolsMenuEl = null;
}

function renderMenuRows(parent: HTMLDivElement, rows: MenuRow[]): void {
  for (const r of rows) {
    if (r.kind === "group") {
      const g = document.createElement("div");
      g.className = "dm-group";
      g.textContent = r.text;
      parent.appendChild(g);
      continue;
    }

    if (r.kind === "sep") {
      const s = document.createElement("div");
      s.className = "dm-sep";
      parent.appendChild(s);
      continue;
    }

    const el = document.createElement("div");
    el.className =
      "dm-item" + (r.disabled ? " disabled" : "") + (r.children ? " has-sub" : "");
    el.innerHTML = `
      <span class="dm-name">${esc(r.name)}</span>
      ${r.detail ? `<span class="dm-sub">${esc(r.detail)}</span>` : ""}
      ${r.children ? '<span class="dm-caret">▸</span>' : ""}
    `;

    // 鼠标移到任意一行：先关掉"不属于这一行"的二级菜单。
    // 否则从「平台」滑到 iOS 这类无子项的行，旧的平台子菜单会一直挂着。
    // 不能无脑 closeSubMenu()——本行若就在子菜单里，会把鼠标所在的菜单删掉。
    el.addEventListener("mouseenter", () => {
      if (subMenuEl && !subMenuEl.contains(el)) closeSubMenu();
    });

    if (r.disabled) {
      el.title = r.detail ?? "";
    } else if (r.children) {
      el.addEventListener("mouseenter", () => {
        closeSubMenu();
        openSubMenu(el, r.children!);
      });
      // 除了悬停，点击也能展开二级菜单（触摸/点击操作更直观）
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSubMenu();
        openSubMenu(el, r.children!);
      });
    } else {
      el.addEventListener("click", () => {
        // keepOpen：原地刷新某一段（如「平台」），菜单保持打开
        if (!r.keepOpen) closeAllMenus();
        r.onClick?.();
      });
    }

    parent.appendChild(el);
  }
}

function openSubMenu(anchor: HTMLElement, rows: MenuRow[]): void {
  const sub = document.createElement("div");
  sub.className = "device-menu sub";
  sub.innerHTML = `<div class="dm-body"></div>`;
  document.body.appendChild(sub);
  renderMenuRows(sub.querySelector(".dm-body") as HTMLDivElement, rows);

  const r = anchor.getBoundingClientRect();
  const w = sub.offsetWidth || 240;
  const h = sub.offsetHeight || 200;

  // 右侧放不下就翻到左边
  let left = r.right + 2;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 2);

  let top = r.top;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);

  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
  subMenuEl = sub;

  sub.addEventListener("mouseleave", () => {
    window.setTimeout(() => {
      if (subMenuEl === sub && !sub.matches(":hover")) closeSubMenu();
    }, 180);
  });
}

/* ---------------- 项目右键：平台 / 全局命令 / 项目命令 ---------------- */

let projMenuEl: HTMLDivElement | null = null;
/** 开发期：自动展开指定平台子菜单，便于无人值守截图 */
let devSubmenu: string | null = null;

function openProjectMenu(ev: MouseEvent, p: Proj): void {
  // 文件夹项目没有可解析的配置文件：直接出精简菜单，省一次后端往返
  if (p.kind === "folder") {
    renderFolderMenu(ev, p);
    return;
  }

  // 先看目录里有没有 package.json / compose 文件，再决定菜单项（几毫秒，用户感知不到）
  void (async () => {
    let files: ProjectFiles = {
      packageJson: null,
      compose: null,
      android: false,
      qt: false,
      cmakePresets: null,
    };
    try {
      files = await invoke<ProjectFiles>("project_files", { path: p.path });
    } catch {
      /* 读不到就当没有：少两项菜单，不影响其它功能 */
    }
    renderProjectMenu(ev, p, files);
  })();
}

/**
 * 文件夹项目的右键：只保留四个通用操作。
 *
 * 它没有平台、没有可重读的生态文件，把 Flutter / Compose / 数据库那套菜单挂上来
 * 只会让人以为这个目录被识别成了什么工程。
 */
function renderFolderMenu(ev: MouseEvent, p: Proj): void {
  closeAllMenus();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 320)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 240)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>${esc(projectLabel(p))}</span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const gitReady = (state.settings?.git?.desktopPath ?? "").trim() !== "";

  const rows: MenuRow[] = [
    {
      kind: "item",
      name: "在终端中打开",
      detail: "注入项目环境后开一个交互终端",
      onClick: () => void openProjectTerminal(p),
    },
    {
      kind: "item",
      name: "用编辑器打开目录",
      detail: "用默认编辑器打开该文件夹",
      onClick: () => void editFile(p.path),
    },
    {
      kind: "item",
      name: "在文件管理器中打开",
      detail: "用资源管理器打开该文件夹",
      onClick: () => void openInFileExplorer(p.path),
    },
    gitReady
      ? {
          kind: "item",
          name: "在 Git Desktop 中打开",
          detail: "GitHub Desktop 等客户端，直接打开该目录",
          onClick: () => {
            void invoke("open_in_git_desktop", { path: p.path }).catch((e) =>
              toast(String(e), "error"),
            );
          },
        }
      : {
          kind: "item",
          name: "在 Git Desktop 中打开",
          detail: "未配置：设置 → Git",
          disabled: true,
        },
    { kind: "sep" },
    {
      kind: "item",
      name: "添加命令",
      detail: "新建 run / build / custom 命令",
      onClick: () => void openCommandDialog(p),
    },
    { kind: "sep" },
    {
      kind: "item",
      name: "重命名项目…",
      detail: "只改显示名，不动磁盘目录",
      onClick: () => void renameProject(p),
    },
    {
      kind: "item",
      name: "移除项目…",
      detail: "仅从项目列表移除，不影响磁盘文件",
      onClick: () => void removeProject(p),
    },
  ];

  const box = document.createElement("div");
  (menu.querySelector(".dm-body") as HTMLDivElement).appendChild(box);
  renderMenuRows(box, rows);
}

function renderProjectMenu(ev: MouseEvent, p: Proj, files: ProjectFiles): void {
  closeAllMenus();

  // 命令集（无 pubspec 的 workspace）本身就是命令列表：不显示平台，也不显示全局命令
  const isCommandSet = p.kind !== "single";

  // 生态判定：看它有哪些来源的命令（一个目录可能同时有 npm / docker / qt）
  const dockerCmds = p.commands.filter((c) => c.source === "docker");
  const npmCmds = p.commands.filter((c) => c.source === "npm");
  const qtCmds = p.commands.filter((c) => c.source === "qt");
  const launchCmds = p.commands.filter((c) => c.source === "launch-json");
  const ecoTag = dockerCmds.length
    ? "Docker"
    : npmCmds.length
      ? "Npm"
      : qtCmds.length
        ? "Qt"
        : "命令集";

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 360)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 420)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>${esc(projectLabel(p))}${isCommandSet ? ` <span class="dm-tag">${ecoTag}</span>` : ""}</span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  // 0) Compose 项目级动作（全部启动 / 全部日志 / 全部停止）
  if (dockerCmds.length) {
    const pick = (role: string): Cmd | undefined =>
      dockerCmds.find((c) => c.role === role && !c.group);

    const upAll = pick("up-all");
    const logsAll = pick("logs-all");
    const down = pick("down");

    const rows: MenuRow[] = [{ kind: "group", text: "Compose" }];
    if (upAll) {
      rows.push({
        kind: "item",
        name: "全部启动",
        detail: "up -d，后台运行所有服务",
        onClick: () => void runCommand(p, upAll),
      });
    }
    if (logsAll) {
      rows.push({
        kind: "item",
        name: "全部日志",
        detail: "logs -f，持续输出",
        onClick: () => void runCommand(p, logsAll),
      });
    }
    if (down) {
      rows.push({
        kind: "item",
        name: "全部停止",
        detail: "down：删除容器与网络（卷保留）",
        onClick: () => void runCommand(p, down),
      });
    }

    const box = document.createElement("div");
    body.appendChild(box);
    renderMenuRows(box, rows);
  }

  // 1) 平台（仅 Flutter 项目）
  let platformBox: HTMLDivElement | null = null;
  if (!isCommandSet) {
    platformBox = document.createElement("div");
    platformBox.innerHTML = `<div class="dm-group">平台 · 正在分析…</div>`;
    body.appendChild(platformBox);
    void loadPlatformRows(p, platformBox, menu);
  }

  // 2) 全局命令
  if (!isCommandSet) {
    const globals = state.commandTemplates.filter((t) => t.scope === "global");
    const rows: MenuRow[] = [{ kind: "group", text: `全局命令 (${globals.length})` }];

    if (globals.length === 0) {
      rows.push({
        kind: "item",
        name: "（暂无全局模板）",
        detail: "设置 → 命令模板 → 作用域选「全局」",
        disabled: true,
      });
    }
    for (const t of globals) {
      rows.push({
        kind: "item",
        name: t.name,
        detail: [t.kind, t.buildType, t.args.join(" ")].filter(Boolean).join(" · "),
        onClick: () => void runTemplate(p, t),
      });
    }

    const box = document.createElement("div");
    body.appendChild(box);
    renderMenuRows(box, rows);
  }

  // 3) 项目级操作
  const tail: MenuRow[] = [{ kind: "sep" }];

  if (!isCommandSet) {
    tail.push({
      kind: "item",
      name: "重新分析平台信息",
      detail: "刷新宿主可构建的平台与该平台设备",
      // 不关菜单：只把「平台」那一段原地刷新（关掉再开等于闪一下，还会丢滚动位置）
      keepOpen: true,
      onClick: () => {
        if (platformBox) {
          platformBox.innerHTML = `<div class="dm-group">平台 · 正在重新分析…</div>`;
        }
        void (async () => {
          try {
            await invoke("platform_matrix", { projectId: p.id, force: true });
            if (platformBox) await loadPlatformRows(p, platformBox, menu);
            toast("平台信息已刷新");
          } catch (e) {
            toast(String(e), "error");
            if (platformBox) await loadPlatformRows(p, platformBox, menu);
          }
        })();
      },
    });
  }

  tail.push({
    kind: "item",
    name: "在终端中打开",
    detail: "注入项目环境后开一个交互终端",
    onClick: () => void openProjectTerminal(p),
  });

  tail.push({
    kind: "item",
    name: "用编辑器打开目录",
    detail: "用默认编辑器打开项目文件夹（整个目录当工作区）",
    onClick: () => void editFile(p.path),
  });

  tail.push({
    kind: "item",
    name: "在文件管理器中打开",
    detail: "用资源管理器打开项目文件夹",
    onClick: () => void openInFileExplorer(p.path),
  });

  // 只有真正的 Android 工程才有「数据库」可看（工作区/命令集没有 applicationId）
  if (files.android) {
    tail.push({
      kind: "item",
      name: "数据库…",
      detail: "只读查看设备上应用的 SQLite（支持 SQL 查询）",
      onClick: () => void openDbInspector(p),
    });
  }

  // 只有设置里填了程序才显示：没配置的人不需要看到一个点了必然报错的菜单项
  if ((state.settings?.git?.desktopPath ?? "").trim()) {
    tail.push({
      kind: "item",
      name: "在 Git Desktop 中打开",
      detail: "GitHub Desktop 等客户端，直接打开项目目录",
      onClick: () => {
        void invoke("open_in_git_desktop", { path: p.path }).catch((e) =>
          toast(String(e), "error"),
        );
      },
    });
  }

  if (!isCommandSet) {
    tail.push({
      kind: "item",
      name: "环境变量…",
      detail: "鸿蒙工程的全局 / 项目级变量与 PATH shim",
      onClick: () => void openEnvDialog(p),
    });
  }

  // 按项目"有什么文件"决定重读哪一份（以前一律显示 launch.json，对 docker/npm 项目是错的）
  if (files.compose) {
    const name = files.compose.split(/[\\/]/).pop() ?? "docker-compose.yaml";
    tail.push({
      kind: "item",
      name: `编辑 ${name}`,
      detail: "用默认编辑器打开",
      onClick: () => void editFile(files.compose!),
    });
  }
  if (files.packageJson) {
    tail.push({
      kind: "item",
      name: "编辑 package.json",
      detail: "用默认编辑器打开",
      onClick: () => void editFile(files.packageJson!),
    });
  }
  if (files.cmakePresets) {
    tail.push({
      kind: "item",
      name: "编辑 CMakePresets.json",
      detail: "用默认编辑器打开",
      onClick: () => void editFile(files.cmakePresets!),
    });
  }

  if (dockerCmds.length) {
    tail.push({
      kind: "item",
      name: "重新读取 docker-compose.yaml",
      detail: "按 compose 文件刷新服务列表",
      onClick: () => void rereadCompose(p),
    });
  }
  if (npmCmds.length) {
    tail.push({
      kind: "item",
      name: "重新读取 package.json",
      detail: "按 scripts 刷新命令",
      onClick: () => void rereadPackage(p),
    });
  }
  if (launchCmds.length) {
    tail.push({
      kind: "item",
      name: "重新读取 launch.json",
      detail: "按 .vscode/launch.json 刷新命令",
      onClick: () => void importLaunch(p.id),
    });
  }
  if (qtCmds.length || files.qt) {
    tail.push({
      kind: "item",
      name: "重新读取 Qt / CMake",
      detail: "按 CMakePresets.json 刷新配置 / 构建命令",
      onClick: () => void rereadQt(p),
    });
  }

  tail.push(
    {
      kind: "item",
      name: "从模板导入…",
      detail: "把模板加入本项目",
      onClick: () => openTemplateImport(p),
    },
    {
      kind: "item",
      name: "添加命令…",
      detail: "新建 run / build / custom 命令",
      onClick: () => void openCommandDialog(p),
    },
  );

  // 仅 Flutter 工程显示；文件夹项目没有 pubspec/平台目录
  if (p.kind !== "folder" && flutterInfo.get(p.id)?.ok) {
    tail.push({
      kind: "item",
      name: "Flutter 重命名…",
      detail: "包名 / 应用名称（rename CLI）",
      onClick: () => void openFlutterRename(p),
    });
  }

  tail.push(
    { kind: "sep" },
    {
      kind: "item",
      name: "重命名项目…",
      detail: "只改显示名，不动磁盘目录",
      onClick: () => void renameProject(p),
    },
    {
      kind: "item",
      name: "移除项目…",
      detail: "仅从项目列表移除，不影响磁盘文件",
      onClick: () => void removeProject(p),
    },
  );

  const box = document.createElement("div");
  body.appendChild(box);
  renderMenuRows(box, tail);
}

/** 平台行渲染。结果由后端缓存，只有「重新分析」才会真正重算。 */
async function loadPlatformRows(
  p: Proj,
  box: HTMLDivElement,
  menu: HTMLDivElement,
): Promise<void> {
  try {
    const m = await invoke<PlatformMatrix>("platform_matrix", { projectId: p.id });
    if (projMenuEl !== menu) return;
    box.innerHTML = "";

    const rows: MenuRow[] = [{ kind: "group", text: "平台" }];
    for (const pf of m.platforms) {
      if (!pf.enabled) {
        rows.push({
          kind: "item",
          name: pf.label,
          detail: pf.reason ?? "当前不可用",
          disabled: true,
        });
        continue;
      }
      const usable = pf.actions.filter((a) => a.enabled).length;
      const total = pf.actions.length;
      rows.push({
        kind: "item",
        name: pf.label,
        detail: [
          usable === total ? `${total} 个动作` : `${usable}/${total} 可用`,
          pf.device ?? "无设备",
        ].join(" · "),
        children: [
          // 展开后第一行直接告诉你"跑在哪台设备上"，省得再回上一级看
          { kind: "group" as const, text: `设备 · ${pf.device ?? "无"}` },
          ...pf.actions.map((a) => ({
            kind: "item" as const,
            name: a.command,
            detail: a.enabled ? a.label : `${a.label} · ${a.reason ?? "不可用"}`,
            disabled: !a.enabled,
            onClick: () => void runPlatformAction(p, pf.id, a),
          })),
        ],
      });
    }
    renderMenuRows(box, rows);

    // 开发期：自动展开某个平台，便于截图
    if (devSubmenu) {
      const el = Array.from(box.querySelectorAll<HTMLDivElement>(".dm-item.has-sub")).find(
        (x) => x.querySelector(".dm-name")?.textContent === devSubmenu,
      );
      if (el) el.dispatchEvent(new MouseEvent("mouseenter"));

      // 开发期：再"悬停"到另一行，验证旧子菜单是否被关掉
      const hover = await invoke<string | null>("dev_env", { name: "FLA_HOVER" });
      if (hover) {
        const row = Array.from(
          box.parentElement!.querySelectorAll<HTMLDivElement>(".dm-item"),
        ).find((x) => x.querySelector(".dm-name")?.textContent === hover);
        if (row) row.dispatchEvent(new MouseEvent("mouseenter"));
      }
    }
  } catch (e) {
    if (projMenuEl !== menu) return;
    box.innerHTML = "";
    renderMenuRows(box, [{ kind: "group", text: "平台" }]);
    const err = document.createElement("div");
    err.className = "dm-error";
    err.textContent = String(e);
    box.appendChild(err);
  }
}

async function runPlatformAction(
  p: Proj,
  platform: string,
  a: PlatformAction,
  /** 「重跑」时传旧会话 id：新会话挂上后原位替换旧的（不是追加到末尾） */
  replaceId?: string,
): Promise<void> {
  const sameAction = (s: TermSession): boolean =>
    s.projectId === p.id &&
    s.platform === platform &&
    s.action === a.action &&
    (s.target ?? "") === (a.target ?? "");

  // 同一个平台动作已经在跑：切回已有标签，别重复起进程（重跑路径跳过这层）
  if (!replaceId) {
    const live = liveSessionFor(sameAction);
    if (live) {
      activateSession(live.id);
      toast(`该动作已在运行：${live.title}`);
      return;
    }
  }

  const stale = staleSessionFor(sameAction);

  const key = `plat|${p.id}|${platform}|${a.action}|${a.target ?? ""}`;
  if (markLaunching(key)) return;

  try {
    const res = await invoke<StartResponse>("start_platform_action", {
      projectId: p.id,
      platform,
      action: a.action,
      target: a.target ?? null,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(
      res,
      a.action === "build" ? "build" : "run",
      a.action === "profile" ? "profile" : "debug",
      {
        projectId: p.id,
        platform,
        action: a.action,
        target: a.target ?? undefined,
      },
    );
    const oldId = replaceId ?? stale?.id;
    if (oldId && oldId !== session.id) replaceSessionInPlace(oldId, session.id);
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launchingKeys.delete(key);
  }
}

/* ---------------- 命令模板库 ---------------- */

function openTemplateManager(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 740px">
      <div class="modal-head">
        <span>命令模板库</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="tpl-body"></div>
      <div class="modal-foot">
        <span class="modal-hint">新建「单应用」项目时会自动套用这些模板</span>
        <span class="flex1"></span>
        <button class="btn" id="tpl-new">＋ 新建模板</button>
        <button class="btn primary" id="tpl-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const body = overlay.querySelector("#tpl-body") as HTMLDivElement;
  const close = (): void => {
    templateListRefresh = null;
    overlay.remove();
  };

  const renderList = (): void => {
    body.innerHTML = "";
    if (state.commandTemplates.length === 0) {
      const e = document.createElement("div");
      e.className = "set-desc";
      e.textContent = "模板库为空，点「＋ 新建模板」添加。";
      body.appendChild(e);
      return;
    }

    // 按分类分组显示（flutter → npm → docker → 其他），组内按名字排
    const ordered = [...state.commandTemplates].sort((a, b) => {
      const d =
        CATEGORY_ORDER.indexOf(templateCategory(a) as (typeof CATEGORY_ORDER)[number]) -
        CATEGORY_ORDER.indexOf(templateCategory(b) as (typeof CATEGORY_ORDER)[number]);
      return d !== 0 ? d : a.name.localeCompare(b.name, "zh");
    });

    let lastCategory = "";
    for (const t of ordered) {
      const cat = templateCategory(t);
      if (cat !== lastCategory) {
        lastCategory = cat;
        const head = document.createElement("div");
        head.className = "tpl-group";
        head.textContent = CATEGORY_LABEL[cat] ?? cat;
        body.appendChild(head);
      }

      const row = document.createElement("div");
      row.className = "tpl-row";

      const main = document.createElement("div");
      main.className = "tpl-main";
      main.innerHTML = `
        <span class="tpl-name">${esc(t.name)}</span>
        <span class="chip ${t.kind === "build" ? "src-custom" : "src-fvm"}">${esc(t.kind)}</span>
        ${t.buildType ? `<span class="fver">${esc(t.buildType)}</span>` : ""}
        ${t.flutterMode ? `<span class="fver">${esc(t.flutterMode)}</span>` : ""}
        <span class="tpl-args">${esc(t.args.join(" "))}</span>
      `;

      const edit = document.createElement("button");
      edit.className = "btn";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => void openCommandDialog(null, t));

      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "删除";
      del.addEventListener("click", () => {
        void (async () => {
          const ok = await confirm(`删除模板「${t.name}」？`, {
            title: "删除模板",
            kind: "warning",
          });
          if (!ok) return;
          try {
            state = await invoke<State>("remove_template", { id: t.id });
            renderList();
            render();
            toast("模板已删除");
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      // 分类可直接改（改了就落盘，用于纠正自动推断）
      const catSel = document.createElement("select");
      catSel.className = "set-input tpl-cat";
      catSel.title = "模板分类";
      for (const c of CATEGORY_ORDER) {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = CATEGORY_LABEL[c];
        opt.selected = cat === c;
        catSel.appendChild(opt);
      }
      catSel.addEventListener("change", () => {
        void (async () => {
          try {
            state = await invoke<State>("upsert_template", {
              template: { ...t, category: catSel.value },
            });
            renderList();
            render();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      row.append(main, catSel, edit, del);
      body.appendChild(row);
    }
  };

  renderList();
  // 让「新建/编辑模板」保存后能立刻刷新这个列表（否则得关掉重开才看到）
  templateListRefresh = renderList;

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#tpl-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#tpl-new") as HTMLButtonElement).addEventListener("click", () => {
    void openCommandDialog(null);
  });
}

function openTemplateImport(p: Proj): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 680px">
      <div class="modal-head">
        <span>从模板导入 · ${esc(p.name)}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="imp-filter" id="imp-filter"></div>
      <div class="modal-body" id="imp-body"></div>
      <div class="modal-foot">
        <span class="modal-hint" id="imp-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="imp-all">全选</button>
        <button class="btn" id="imp-none">全不选</button>
        <button class="btn" id="imp-cancel">取消</button>
        <button class="btn primary" id="imp-go">导入</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#imp-body") as HTMLDivElement;
  const hint = overlay.querySelector("#imp-hint") as HTMLSpanElement;
  const selected = new Set<string>();
  const close = (): void => overlay.remove();

  const updateHint = (): void => {
    hint.textContent = `已选 ${selected.size} / ${state.commandTemplates.length}`;
  };

  const filterBar = overlay.querySelector("#imp-filter") as HTMLDivElement;
  let filter = "all";

  const renderFilter = (): void => {
    filterBar.innerHTML = "";
    const opts: [string, string][] = [
      ["all", "全部"],
      ...CATEGORY_ORDER.map((c) => [c, CATEGORY_LABEL[c]] as [string, string]),
    ];
    for (const [value, label] of opts) {
      const n =
        value === "all"
          ? state.commandTemplates.length
          : state.commandTemplates.filter((t) => templateCategory(t) === value).length;
      const chip = document.createElement("button");
      chip.className = "chip imp-chip" + (filter === value ? " on" : "");
      chip.textContent = n > 0 ? `${label} ${n}` : label;
      chip.disabled = n === 0;
      chip.addEventListener("click", () => {
        filter = value;
        renderFilter();
        renderList();
      });
      filterBar.appendChild(chip);
    }
  };

  const renderList = (): void => {
    body.innerHTML = "";
    if (state.commandTemplates.length === 0) {
      const e = document.createElement("div");
      e.className = "set-desc";
      e.textContent = "模板库为空，请先到「设置 → 命令模板」里添加。";
      body.appendChild(e);
      updateHint();
      return;
    }

    for (const t of state.commandTemplates) {
      if (filter !== "all" && templateCategory(t) !== filter) continue;

      const row = document.createElement("label");
      row.className = "imp-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(t.id);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(t.id);
        else selected.delete(t.id);
        updateHint();
      });

      const main = document.createElement("div");
      main.className = "imp-main";
      main.innerHTML = `
        <span class="tpl-name">${esc(t.name)}</span>
        <span class="chip ${t.kind === "build" ? "src-custom" : "src-fvm"}">${esc(t.kind)}</span>
        ${t.buildType ? `<span class="fver">${esc(t.buildType)}</span>` : ""}
        ${t.flutterMode ? `<span class="fver">${esc(t.flutterMode)}</span>` : ""}
        <span class="tpl-args">${esc(t.args.join(" "))}</span>
      `;

      row.append(cb, main);
      body.appendChild(row);
    }
    updateHint();
  };

  renderFilter();
  renderList();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#imp-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#imp-all") as HTMLButtonElement).addEventListener("click", () => {
    // 只全选当前筛选下看得见的，避免"看不见的被选中"
    for (const t of state.commandTemplates) {
      if (filter === "all" || templateCategory(t) === filter) selected.add(t.id);
    }
    renderList();
  });
  (overlay.querySelector("#imp-none") as HTMLButtonElement).addEventListener("click", () => {
    selected.clear();
    renderList();
  });

  (overlay.querySelector("#imp-go") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      if (selected.size === 0) {
        hint.textContent = "请至少选择一条模板";
        return;
      }
      try {
        const res = await invoke<{ state: State; added: number }>("import_templates", {
          projectId: p.id,
          templateIds: [...selected],
        });
        state = res.state;
        close();
        render();
        toast(
          res.added === 0 ? "所选命令已存在，未新增" : `已导入 ${res.added} 条命令`,
        );
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 模拟器菜单（工具栏） ---------------- */

let emuMenuEl: HTMLDivElement | null = null;
/** 模拟器列表缓存：模拟器不常变，没点刷新就直接用缓存，避免每次打开都重新查询 */
let emulatorCache: AllEmulators | null = null;

function closeEmuMenu(): void {
  emuMenuEl?.remove();
  emuMenuEl = null;
}

function renderEmulatorBody(data: AllEmulators, error: string | null): void {
  const menu = emuMenuEl;
  if (!menu) return;

  // 标题栏右侧显示"设备更新于"：点了 ⟳ 有没有真的生效，一眼能看出来
  const stamp = menu.querySelector<HTMLSpanElement>(".dm-updated");
  if (stamp) {
    stamp.textContent = data.devicesAt
      ? `设备更新于 ${new Date(data.devicesAt).toLocaleTimeString()}`
      : "";
  }

  const body = menu.querySelector(".dm-body") as HTMLDivElement;
  body.innerHTML = "";

  const group = (t: string): void => {
    const g = document.createElement("div");
    g.className = "dm-group";
    g.textContent = t;
    body.appendChild(g);
  };
  const note = (t: string, cls = "dm-empty"): void => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = t;
    body.appendChild(d);
  };
  const item = (name: string, detail: string, onClick: () => void): void => {
    const el = document.createElement("div");
    el.className = "dm-item emulator";
    el.innerHTML = `<span class="dm-name">${esc(name)}</span>${detail ? `<span class="dm-sub">${esc(detail)}</span>` : ""}`;
    el.addEventListener("click", () => {
      closeEmuMenu();
      onClick();
    });
    body.appendChild(el);
  };

  if (error) {
    note(error, "dm-error");
    return;
  }

  // 已连接的设备放最前面：刚从手机插上就想确认"它认到了没"
  const connected = (data.devices ?? []).filter((d) => d.isConnected !== false);
  group(`已连接设备 (${connected.length})`);
  if (connected.length === 0) {
    note(
      "未检测到已连接设备（手机需开启 USB 调试并授权；插上后可再点 ⟳ 刷新）",
    );
  }
  for (const d of connected) {
    const sub = [d.id, d.sdk ?? d.platformType ?? d.category ?? ""].filter(Boolean).join(" · ");
    item(d.name, sub, () => {
      // 设备已经在跑，点它只是复制 id——真要跑请用命令/平台菜单
      void navigator.clipboard?.writeText(d.id).catch(() => undefined);
      toast(`已复制设备 ID：${d.id}`);
    });
  }

  group(`Android 模拟器 (${data.android.length})`);
  if (data.android.length === 0) note("无可用 AVD");
  for (const a of data.android) {
    item(a.name, a.detail, () => {
      const pid = state.projects[0]?.id;
      if (!pid) {
        toast("启动 Android 模拟器需要先添加一个 Flutter 项目", "error");
        return;
      }
      toast(`正在启动：${a.name}`);
      void invoke("launch_emulator", { projectId: pid, emulatorId: a.id }).catch((e2) =>
        toast(String(e2), "error"),
      );
    });
  }

  group(`HarmonyOS 模拟器 (${data.harmony.length})`);
  if (data.harmony.length === 0) note("未发现鸿蒙模拟器（可在设置里指定 DevEco 目录）");
  for (const h of data.harmony) {
    item(h.name, h.detail, () => {
      toast(`正在启动：${h.name}`);
      void invoke("launch_harmony_emulator", { name: h.id }).catch((e2) =>
        toast(String(e2), "error"),
      );
    });
  }

  if (data.notes.length > 0) {
    group("提示");
    for (const n of data.notes) note(n);
  }
}

/** 真正去查一次。force=false 时后端会用磁盘缓存（模拟器），设备每次都现查。
 *  quiet=true：不清空现有内容，静默刷新（打开菜单时先显示缓存、再补齐设备）。 */
async function loadEmulators(force: boolean, quiet = false): Promise<void> {
  const menu = emuMenuEl;
  if (!menu) return;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;
  const refresh = menu.querySelector<HTMLButtonElement>(".dm-refresh");
  if (!quiet) body.innerHTML = `<div class="dm-loading">正在检查电脑上的模拟器…</div>`;
  if (refresh) refresh.disabled = true;

  let data: AllEmulators | null = null;
  let error: string | null = null;
  try {
    data = await invoke<AllEmulators>("list_all_emulators", {
      projectId: state.projects[0]?.id ?? null,
      force,
    });
  } catch (e) {
    error = String(e);
  }

  if (emuMenuEl !== menu) return;
  if (refresh) refresh.disabled = false;

  if (data) emulatorCache = data;
  renderEmulatorBody(data ?? { android: [], harmony: [], notes: [] }, error);
}

/* ---------------- 工具栏「导入」菜单 ---------------- */

let importMenuEl: HTMLDivElement | null = null;

function closeImportMenu(): void {
  importMenuEl?.remove();
  importMenuEl = null;
}

/** 工具栏的「导入」下拉：项目 / 文件夹 / launch.json / package.json / compose */
function openImportMenu(anchor: HTMLElement): void {
  if (importMenuEl) {
    closeImportMenu();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "device-menu import-menu";
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(menu);
  importMenuEl = menu;

  type Item = {
    icon: string;
    label: string;
    hint: string;
    disabled?: boolean;
    run?: () => void;
  };

  const items: Item[] = [
    {
      icon: "＋",
      label: "添加 Flutter 项目",
      hint: "选择项目目录",
      run: () => void addProject(),
    },
    {
      icon: "📁",
      label: "添加文件夹 / 目录",
      hint: "导入为空，命令稍后添加",
      run: () => void addFolder(),
    },
    {
      icon: "📂",
      label: "导入 launch.json",
      hint: ".vscode/launch.json",
      run: () => void importLaunchPath(),
    },
    {
      icon: "📦",
      label: "导入 package.json",
      hint: "按 scripts 生成命令",
      run: () => void importPackagePath(),
    },
    {
      icon: "🐳",
      label: "导入 docker-compose.yaml",
      hint: "按 service 生成命令",
      run: () => void importComposePath(),
    },
    {
      icon: "🛠️",
      label: "导入 Qt / CMake 工程",
      hint: "CMakePresets",
      run: () => void importQtPath(),
    },
  ];

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "dm-item import-item" + (it.disabled ? " disabled" : "");

    const icon = document.createElement("span");
    icon.className = "import-icon";
    icon.textContent = it.icon;

    const label = document.createElement("span");
    label.className = "import-label";
    label.textContent = it.label;

    const hint = document.createElement("span");
    hint.className = "import-hint";
    hint.textContent = it.hint;

    row.append(icon, label, hint);

    if (!it.disabled && it.run) {
      row.addEventListener("click", () => {
        closeImportMenu();
        it.run!();
      });
    } else {
      row.title = "暂未实现";
    }

    menu.appendChild(row);
  }

  const dismiss = (e: MouseEvent): void => {
    const t = e.target as Node;
    if (importMenuEl && !importMenuEl.contains(t) && !anchor.contains(t)) {
      closeImportMenu();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  document.addEventListener("mousedown", dismiss);

  // Esc 关闭
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      closeImportMenu();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
}

function openEmulatorMenu(anchor: HTMLElement): void {
  if (emuMenuEl) {
    closeEmuMenu();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 336))}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>设备与模拟器</span>
      <span class="dm-updated"></span>
      <button class="dm-refresh" title="重新检查设备与模拟器（模拟器结果会缓存，设备每次现查）">⟳</button>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  emuMenuEl = menu;

  // ⟳：强制重新检查电脑上的模拟器
  menu.querySelector(".dm-refresh")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void loadEmulators(true);
  });

  // 有内存缓存就先把模拟器渲染出来（秒开），但设备列表**每次打开都重查**：
  // 手机是随时插上的，用旧缓存会让人以为"插上了也不认"。
  if (emulatorCache) {
    renderEmulatorBody(emulatorCache, null);
    void loadEmulators(false, true);
  } else {
    void loadEmulators(false);
  }
}


/* ---------------- Android 数据库（只读快照） ---------------- */

interface DbDeviceInfo {
  serial: string;
  state: string;
  model: string;
  product: string;
}

interface DbEnvInfo {
  adb: string | null;
  adbVersion: string | null;
  devices: DbDeviceInfo[];
  package: string | null;
  foreground: string | null;
  notes: string[];
}

interface DbFileInfo {
  path: string;
  size: number;
}

interface DbTableInfo {
  name: string;
  sql: string | null;
}

interface DbOpenInfo {
  sessionId: string;
  localPath: string;
  remotePath: string;
  size: number;
  wal: boolean;
  tables: DbTableInfo[];
}

interface DbPageInfo {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  elapsedMs: number;
  total: number | null;
}

interface PrefEntry {
  key: string;
  /** string / int / long / float / boolean / set */
  type: string;
  value: string;
}

function dbSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dbPkgKey(projectId: string): string {
  return `appdeck.db.package.${projectId}`;
}

/** 把 run-as 的原始报错翻译成能指导下一步操作的提示 */
function dbErrorText(e: unknown): string {
  const msg = String(e);
  if (/unknown package|not debuggable|run-as/i.test(msg)) {
    return `${msg}（只有 debug 包能用 run-as 读取；可用 adb shell pm list packages -3 确认包名）`;
  }
  return msg;
}

/**
 * Android 数据库查看器：`adb run-as` 拉取 db（+ `-wal`）到本机，只读打开。
 *
 * 与 Android Studio Database Inspector 的区别：
 * - 不需要 IDE、不走 JDWP，也不要求 app 集成任何依赖；
 * - 看到的是拉取那一刻的快照，点「读取数据库」可重新拉；
 * - release 包（非 debuggable）没有 `run-as`，这里会直接报错。
 */
/** 复制文本：优先 Clipboard API，失败时退回 textarea + execCommand（WebView 未聚焦时也能用） */
async function copyPlainText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("复制失败：剪贴板不可用");
  }
}

/** 右键单元格：复制完整内容（长文本在格子里是截断的，dataset.full 存原文） */
function showDbCellMenu(ev: MouseEvent, td: HTMLTableCellElement): void {
  closeAllMenus();

  const tr = td.parentElement as HTMLTableRowElement | null;
  const cellText = td.dataset.full ?? td.textContent ?? "";
  const rowText = tr
    ? Array.from(tr.children)
        .map((c) => (c as HTMLElement).dataset.full ?? c.textContent ?? "")
        .join("\t")
    : cellText;

  const menu = document.createElement("div");
  menu.className = "device-menu db-cell-menu";
  menu.innerHTML = `<div class="dm-head"><span>复制单元格</span></div><div class="dm-body"></div>`;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const rows: MenuRow[] = [
    {
      kind: "item",
      name: "复制单元格",
      detail: cellText.length > 80 ? `${cellText.slice(0, 80)}…` : cellText || "（空）",
      onClick: () =>
        void copyPlainText(cellText)
          .then(() => toast("已复制单元格"))
          .catch((e) => toast(String(e), "error")),
    },
    {
      kind: "item",
      name: "复制整行",
      detail: "列之间用 Tab 分隔，可直接粘到 Excel",
      onClick: () =>
        void copyPlainText(rowText)
          .then(() => toast("已复制整行"))
          .catch((e) => toast(String(e), "error")),
    },
  ];
  renderMenuRows(menu.querySelector(".dm-body") as HTMLDivElement, rows);

  const w = menu.offsetWidth || 280;
  const h = menu.offsetHeight || 120;
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - h - 8))}px`;
}

async function openDbInspector(p: Proj): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal db-modal">
      <div class="modal-head">
        <span>数据库 · ${esc(projectLabel(p))}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="db-toolbar">
        <label for="db-device">设备</label>
        <select id="db-device" class="set-input"></select>
        <label for="db-pkg">包名</label>
        <input id="db-pkg" class="set-input" spellcheck="false" autocomplete="off" />
        <button class="btn" id="db-load">读取数据库</button>
        <span class="db-hint" id="db-hint">正在探测设备…</span>
      </div>
      <div class="db-main">
        <aside class="db-side">
          <div class="db-side-title"><span>数据库</span><span id="db-file-count"></span></div>
          <div class="db-files" id="db-files"></div>
          <div class="db-side-title"><span>表</span><span id="db-table-count"></span></div>
          <div class="db-tables" id="db-tables"></div>
        </aside>
        <section class="db-work">
          <div class="db-tabs">
            <button class="db-tab active" data-mode="db">数据库</button>
            <button class="db-tab" data-mode="prefs">SharedPreferences</button>
            <span class="flex1"></span>
            <button class="btn" id="db-export" disabled>导出副本</button>
            <button class="btn" id="db-reveal" disabled>在资源管理器中显示</button>
          </div>
          <div class="db-subtabs" id="db-subtabs">
            <button class="db-subtab active" data-tab="data">数据</button>
            <button class="db-subtab" data-tab="sql">SQL</button>
          </div>
          <div class="db-pane" id="db-pane-data">
            <div class="db-grid-wrap"><table class="db-grid" id="db-grid"></table></div>
            <div class="db-pager">
              <button class="btn" id="db-prev" disabled>‹ 上一页</button>
              <span id="db-page-info">—</span>
              <button class="btn" id="db-next" disabled>下一页 ›</button>
              <select id="db-limit" class="set-input db-limit">
                <option value="100">100 行</option>
                <option value="200" selected>200 行</option>
                <option value="500">500 行</option>
                <option value="1000">1000 行</option>
              </select>
              <span class="db-status" id="db-status"></span>
            </div>
          </div>
          <div class="db-pane" id="db-pane-sql" hidden>
            <textarea id="db-sql" class="db-sql" spellcheck="false"
              placeholder="SELECT * FROM users LIMIT 50;   -- 只读：SELECT / PRAGMA / WITH / EXPLAIN"></textarea>
            <div class="db-sql-bar">
              <button class="btn primary" id="db-run">执行（Ctrl+Enter）</button>
              <span class="db-status" id="db-sql-status"></span>
            </div>
            <div class="db-grid-wrap"><table class="db-grid" id="db-sql-grid"></table></div>
          </div>
          <div class="db-pane" id="db-pane-prefs" hidden>
            <div class="prefs-bar">
              <label for="prefs-file">文件</label>
              <select id="prefs-file" class="set-input"></select>
              <button class="btn" id="prefs-refresh">刷新</button>
              <input id="prefs-search" class="set-input" placeholder="搜索 key / value" spellcheck="false" />
              <label class="prefs-check">
                <input type="checkbox" id="prefs-flutter" /> 只看 Flutter 键
              </label>
              <span class="db-status" id="prefs-status"></span>
            </div>
            <div class="db-grid-wrap prefs-table-wrap">
              <table class="db-grid prefs-grid" id="prefs-grid"></table>
            </div>
            <div class="prefs-path" id="prefs-path"></div>
          </div>
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const hint = req<HTMLSpanElement>("#db-hint", overlay);
  const deviceSel = req<HTMLSelectElement>("#db-device", overlay);
  const pkgInput = req<HTMLInputElement>("#db-pkg", overlay);
  const loadBtn = req<HTMLButtonElement>("#db-load", overlay);
  const filesEl = req<HTMLDivElement>("#db-files", overlay);
  const tablesEl = req<HTMLDivElement>("#db-tables", overlay);
  const fileCount = req<HTMLSpanElement>("#db-file-count", overlay);
  const tableCount = req<HTMLSpanElement>("#db-table-count", overlay);
  const dataGrid = req<HTMLTableElement>("#db-grid", overlay);
  const sqlGrid = req<HTMLTableElement>("#db-sql-grid", overlay);
  const pageInfo = req<HTMLSpanElement>("#db-page-info", overlay);
  const status = req<HTMLSpanElement>("#db-status", overlay);
  const sqlStatus = req<HTMLSpanElement>("#db-sql-status", overlay);
  const sqlInput = req<HTMLTextAreaElement>("#db-sql", overlay);
  const prevBtn = req<HTMLButtonElement>("#db-prev", overlay);
  const nextBtn = req<HTMLButtonElement>("#db-next", overlay);
  const limitSel = req<HTMLSelectElement>("#db-limit", overlay);
  const exportBtn = req<HTMLButtonElement>("#db-export", overlay);
  const revealBtn = req<HTMLButtonElement>("#db-reveal", overlay);
  const dataPane = req<HTMLDivElement>("#db-pane-data", overlay);
  const sqlPane = req<HTMLDivElement>("#db-pane-sql", overlay);
  const prefsPane = req<HTMLDivElement>("#db-pane-prefs", overlay);
  const dbSide = req<HTMLElement>(".db-side", overlay);
  const prefsFile = req<HTMLSelectElement>("#prefs-file", overlay);
  const prefsRefresh = req<HTMLButtonElement>("#prefs-refresh", overlay);
  const prefsSearch = req<HTMLInputElement>("#prefs-search", overlay);
  const prefsFlutter = req<HTMLInputElement>("#prefs-flutter", overlay);
  const prefsGrid = req<HTMLTableElement>("#prefs-grid", overlay);
  const prefsStatus = req<HTMLSpanElement>("#prefs-status", overlay);
  const prefsPathEl = req<HTMLDivElement>("#prefs-path", overlay);
  const topTabs = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".db-tab"));
  const subTabs = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".db-subtab"));
  const subtabsEl = req<HTMLDivElement>("#db-subtabs", overlay);

  let sessionId: string | null = null;
  let localPath = "";
  let files: DbFileInfo[] = [];
  let tables: DbTableInfo[] = [];
  let activeFile: string | null = null;
  let activeTable: string | null = null;
  let total = 0;
  let offset = 0;
  let limit = 200;
  let currentTab = "data";
  let dbSubTab = "data";
  let prefsFiles: DbFileInfo[] = [];
  let prefsEntries: PrefEntry[] = [];
  let prefsLoadedFor = "";
  let prefsActivePath = "";
  let savedDbHint = "";

  const clearGrid = (el: HTMLTableElement): void => {
    el.innerHTML = "";
  };

  const renderGrid = (el: HTMLTableElement, page: DbPageInfo): void => {
    el.innerHTML = "";
    if (page.columns.length === 0) return;

    const head = el.createTHead().insertRow();
    for (const c of page.columns) {
      const th = document.createElement("th");
      th.textContent = c;
      head.appendChild(th);
    }
    const body = el.createTBody();
    for (const row of page.rows) {
      const tr = body.insertRow();
      for (const cell of row) {
        const td = tr.insertCell();
        if (cell === null) {
          td.textContent = "NULL";
          td.className = "db-null";
        } else {
          td.textContent = cell.length > 500 ? `${cell.slice(0, 500)}…` : cell;
          if (cell.length > 500) {
            td.title = cell;
            td.dataset.full = cell;
          }
        }
      }
    }
  };

  const switchTab = (tab: "data" | "sql"): void => {
    const prevTab = currentTab;
    currentTab = tab;
    dbSubTab = tab;
    if (prevTab === "prefs" && savedDbHint) hint.textContent = savedDbHint;

    for (const t of topTabs) t.classList.toggle("active", t.dataset.mode === "db");
    for (const t of subTabs) t.classList.toggle("active", t.dataset.tab === tab);
    dbSide.hidden = false;
    subtabsEl.hidden = false;
    dataPane.hidden = tab !== "data";
    sqlPane.hidden = tab !== "sql";
    prefsPane.hidden = true;
    exportBtn.hidden = false;
    revealBtn.hidden = false;
    if (tab === "sql" && sqlInput.value.trim() === "") {
      sqlInput.value = activeTable
        ? `SELECT * FROM "${activeTable.replace(/"/g, '""')}" LIMIT 100;`
        : "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;";
    }
  };

  const switchMode = (mode: "db" | "prefs"): void => {
    if (mode === "prefs") {
      if (currentTab === "prefs") return;
      savedDbHint = hint.textContent;
      if (currentTab === "sql" || currentTab === "data") dbSubTab = currentTab;
      currentTab = "prefs";
      for (const t of topTabs) t.classList.toggle("active", t.dataset.mode === "prefs");
      dbSide.hidden = true;
      subtabsEl.hidden = true;
      dataPane.hidden = true;
      sqlPane.hidden = true;
      prefsPane.hidden = false;
      exportBtn.hidden = true;
      revealBtn.hidden = true;
      hint.textContent = "SharedPreferences 只读查看（run-as）";
      void loadPrefs();
      return;
    }

    if (currentTab === "prefs" && savedDbHint) hint.textContent = savedDbHint;
    switchTab(dbSubTab === "sql" ? "sql" : "data");
  };

  const renderFiles = (): void => {
    filesEl.innerHTML = "";
    fileCount.textContent = files.length > 0 ? `(${files.length})` : "";
    for (const f of files) {
      const el = document.createElement("div");
      el.className = `db-file${activeFile === f.path ? " active" : ""}`;
      const path = document.createElement("div");
      path.className = "db-file-path";
      path.textContent = f.path;
      const size = document.createElement("div");
      size.className = "db-file-size";
      size.textContent = dbSize(f.size);
      el.append(path, size);
      el.addEventListener("click", () => void openFile(f));
      filesEl.appendChild(el);
    }
    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "set-desc";
      empty.textContent = "（还没有读取）";
      filesEl.appendChild(empty);
    }
  };

  const renderTables = (): void => {
    tablesEl.innerHTML = "";
    tableCount.textContent = tables.length > 0 ? `(${tables.length})` : "";
    for (const t of tables) {
      const el = document.createElement("div");
      el.className = `db-table-item${t.name === activeTable ? " active" : ""}`;
      el.textContent = t.name;
      el.title = t.sql ?? t.name;
      el.addEventListener("click", () => void selectTable(t.name));
      tablesEl.appendChild(el);
    }
  };

  /* ---------- SharedPreferences ---------- */

  const parsePrefsXml = (xml: string): PrefEntry[] => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) {
      throw new Error(`SharedPreferences XML 解析失败：${err.textContent ?? "格式错误"}`);
    }
    const root = doc.documentElement;
    const out: PrefEntry[] = [];
    for (const el of Array.from(root.children)) {
      const key = el.getAttribute("name") ?? "";
      if (!key) continue;
      const type = el.tagName.toLowerCase();
      let value = "";
      if (type === "set") {
        value = Array.from(el.children)
          .map((c) => c.textContent ?? "")
          .join(", ");
      } else if (["int", "long", "float", "boolean"].includes(type)) {
        // Android 把这些类型写在 value 属性里：<int name="x" value="3" />
        value = el.getAttribute("value") ?? el.textContent ?? "";
      } else {
        value = el.textContent ?? "";
      }
      out.push({ key, type, value });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  };

  const renderPrefs = (): void => {
    const q = prefsSearch.value.trim().toLowerCase();
    const flutterOnly = prefsFlutter.checked;
    const list = prefsEntries.filter((e) => {
      if (flutterOnly && !e.key.startsWith("flutter.")) return false;
      if (!q) return true;
      return e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q);
    });

    prefsGrid.innerHTML = "";
    const head = prefsGrid.createTHead().insertRow();
    for (const h of ["键", "类型", "值"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    const body = prefsGrid.createTBody();
    for (const e of list) {
      const tr = body.insertRow();
      const k = tr.insertCell();
      k.textContent = e.key;
      k.className = "prefs-key";
      k.title = e.key;
      const t = tr.insertCell();
      t.textContent = e.type === "set" ? "set" : e.type;
      t.className = "prefs-type";
      const v = tr.insertCell();
      const shown = e.value.length > 1200 ? `${e.value.slice(0, 1200)}…` : e.value;
      v.textContent = shown;
      v.className = "prefs-value";
      if (e.value.length > 1200) {
        v.title = e.value;
        v.dataset.full = e.value;
      }
    }
    if (list.length === 0) {
      const tr = body.insertRow();
      const td = tr.insertCell();
      td.colSpan = 3;
      td.className = "db-null";
      td.textContent = prefsEntries.length
        ? "没有匹配的键"
        : "这个文件里没有键值（或尚未读取）";
    }

    const filtered = list.length !== prefsEntries.length;
    prefsStatus.textContent = prefsEntries.length
      ? `${list.length}${filtered ? ` / ${prefsEntries.length}` : ""} 项`
      : "";
    prefsPathEl.textContent = prefsActivePath;
    prefsPathEl.title = prefsActivePath;
  };

  const readPrefs = async (remotePath: string): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial || !pkg) return;
    prefsStatus.textContent = "读取中…";
    try {
      const xml = await invoke<string>("android_prefs_read", {
        serial,
        package: pkg,
        remotePath,
      });
      prefsEntries = parsePrefsXml(xml);
      prefsActivePath = remotePath;
      renderPrefs();
    } catch (e) {
      prefsEntries = [];
      prefsActivePath = remotePath;
      renderPrefs();
      prefsStatus.textContent = dbErrorText(e);
    }
  };

  const loadPrefs = async (force = false): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial) {
      prefsStatus.textContent = "没有可用设备（检查 USB 调试与授权）";
      return;
    }
    if (!pkg) {
      prefsStatus.textContent = "请填写包名（applicationId）";
      return;
    }
    const key = `${serial}|${pkg}`;
    if (!force && prefsLoadedFor === key && prefsFiles.length > 0) {
      renderPrefs();
      return;
    }

    prefsStatus.textContent = "读取 shared_prefs 列表…";
    prefsRefresh.disabled = true;
    try {
      const old = prefsFile.value;
      prefsFiles = await invoke<DbFileInfo[]>("android_prefs_files", {
        serial,
        package: pkg,
      });
      prefsFile.innerHTML = "";
      for (const f of prefsFiles) {
        const o = document.createElement("option");
        o.value = f.path;
        const name = f.path.split("/").pop() ?? f.path;
        o.textContent = `${name}（${dbSize(f.size)}）`;
        prefsFile.appendChild(o);
      }
      if (prefsFiles.length === 0) {
        prefsEntries = [];
        prefsActivePath = "";
        prefsLoadedFor = key;
        prefsFile.innerHTML = "";
        renderPrefs();
        prefsStatus.textContent =
          "没有找到 shared_prefs/*.xml（release 包、未安装，或 run-as 不可用）";
        return;
      }
      const wanted = prefsFiles.some((f) => f.path === old)
        ? old
        : prefsFiles[0].path;
      prefsFile.value = wanted;
      await readPrefs(wanted);
      prefsLoadedFor = key;
    } catch (e) {
      prefsStatus.textContent = dbErrorText(e);
    } finally {
      prefsRefresh.disabled = false;
    }
  };

  const closeSession = (): void => {
    if (sessionId) {
      const id = sessionId;
      sessionId = null;
      void invoke("android_db_close", { sessionId: id }).catch(() => undefined);
    }
    localPath = "";
  };

  const loadRows = async (): Promise<void> => {
    if (!sessionId || !activeTable) return;
    status.textContent = "读取中…";
    try {
      const page = await invoke<DbPageInfo>("android_db_rows", {
        sessionId,
        table: activeTable,
        offset,
        limit,
      });
      total = page.total ?? 0;
      renderGrid(dataGrid, page);
      const from = page.rows.length === 0 ? 0 : offset + 1;
      const to = offset + page.rows.length;
      pageInfo.textContent = total === 0 ? "空表" : `${from}–${to} / ${total}`;
      prevBtn.disabled = offset <= 0;
      nextBtn.disabled = total === 0 || offset + page.rows.length >= total;
      status.textContent = `${page.rows.length} 行 · ${page.elapsedMs} ms${page.truncated ? " · 已截断" : ""}`;
    } catch (e) {
      status.textContent = String(e);
    }
  };

  const selectTable = async (name: string): Promise<void> => {
    activeTable = name;
    offset = 0;
    renderTables();
    switchTab("data");
    await loadRows();
  };

  const openFile = async (f: DbFileInfo): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial || !pkg) return;

    closeSession();
    activeFile = f.path;
    activeTable = null;
    tables = [];
    offset = 0;
    total = 0;
    renderFiles();
    renderTables();
    clearGrid(dataGrid);
    clearGrid(sqlGrid);
    pageInfo.textContent = "—";
    status.textContent = "";
    sqlStatus.textContent = "";
    exportBtn.disabled = true;
    revealBtn.disabled = true;
    hint.textContent = `正在拉取 ${f.path} …`;

    try {
      const opened = await invoke<DbOpenInfo>("android_db_open", {
        serial,
        package: pkg,
        remotePath: f.path,
      });
      sessionId = opened.sessionId;
      localPath = opened.localPath;
      tables = opened.tables;
      renderTables();
      exportBtn.disabled = false;
      revealBtn.disabled = false;
      hint.textContent = `${dbSize(opened.size)} · ${opened.wal ? "已包含 WAL" : "无 WAL"} · 只读快照`;
      if (tables.length > 0) {
        await selectTable(tables[0].name);
      } else {
        status.textContent = "数据库里没有表";
      }
    } catch (e) {
      hint.textContent = dbErrorText(e);
    }
  };

  const loadFiles = async (): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial) {
      hint.textContent = "没有可用设备（检查 USB 调试与授权）";
      return;
    }
    if (!pkg) {
      hint.textContent = "请填写包名（applicationId）";
      return;
    }
    localStorage.setItem(dbPkgKey(p.id), pkg);

    closeSession();
    files = [];
    activeFile = null;
    activeTable = null;
    tables = [];
    prefsFiles = [];
    prefsEntries = [];
    prefsLoadedFor = "";
    prefsActivePath = "";
    prefsFile.innerHTML = "";
    prefsGrid.innerHTML = "";
    renderFiles();
    renderTables();
    clearGrid(dataGrid);
    clearGrid(sqlGrid);
    exportBtn.disabled = true;
    revealBtn.disabled = true;
    hint.textContent = "读取数据库列表…";
    loadBtn.disabled = true;
    try {
      files = await invoke<DbFileInfo[]>("android_db_files", { serial, package: pkg });
      renderFiles();
      if (files.length === 0) {
        hint.textContent = "没找到 .db / .sqlite 文件（release 包、未安装，或 run-as 不可用）";
        return;
      }
      hint.textContent = `找到 ${files.length} 个数据库文件`;
      await openFile(files[0]);
    } catch (e) {
      hint.textContent = dbErrorText(e);
    } finally {
      loadBtn.disabled = false;
    }
  };

  const runSql = async (): Promise<void> => {
    if (!sessionId) {
      sqlStatus.textContent = "先打开一个数据库";
      return;
    }
    const sql = sqlInput.value.trim();
    if (!sql) return;
    sqlStatus.textContent = "执行中…";
    try {
      const page = await invoke<DbPageInfo>("android_db_query", { sessionId, sql, limit });
      renderGrid(sqlGrid, page);
      sqlStatus.textContent = `${page.rows.length} 行${page.truncated ? "（已截断）" : ""} · ${page.elapsedMs} ms`;
    } catch (e) {
      sqlStatus.textContent = String(e);
    }
  };

  const exportCopy = async (): Promise<void> => {
    if (!sessionId) return;
    const base = (activeFile ?? "database.db").split("/").pop() ?? "database.db";
    const suggested = `${base.replace(/\.(db|sqlite|sqlite3|db3)$/i, "")}.view.db`;
    const dest = await save({
      title: "导出数据库副本",
      defaultPath: suggested,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite"] }],
    });
    if (typeof dest !== "string" || !dest) return;
    try {
      await invoke("android_db_export", { sessionId, dest });
      toast("已导出副本，可直接用 DB Browser / DataGrip 打开");
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const revealCopy = async (): Promise<void> => {
    if (!localPath) return;
    try {
      await revealItemInDir(localPath);
    } catch (e) {
      toast(String(e), "error");
    }
  };

  for (const t of topTabs) {
    t.addEventListener("click", () =>
      switchMode(t.dataset.mode === "prefs" ? "prefs" : "db"),
    );
  }
  for (const t of subTabs) {
    t.addEventListener("click", () =>
      switchTab(t.dataset.tab === "sql" ? "sql" : "data"),
    );
  }
  const bindCellCopy = (grid: HTMLTableElement): void => {
    grid.addEventListener("contextmenu", (e) => {
      const td = (e.target as HTMLElement).closest("td");
      if (!td || !grid.contains(td)) return;
      e.preventDefault();
      showDbCellMenu(e, td as HTMLTableCellElement);
    });
  };
  bindCellCopy(dataGrid);
  bindCellCopy(sqlGrid);
  bindCellCopy(prefsGrid);
  loadBtn.addEventListener("click", () => void loadFiles());
  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - limit);
    void loadRows();
  });
  nextBtn.addEventListener("click", () => {
    offset += limit;
    void loadRows();
  });
  limitSel.addEventListener("change", () => {
    limit = Number(limitSel.value) || 200;
    offset = 0;
    void loadRows();
  });
  exportBtn.addEventListener("click", () => void exportCopy());
  revealBtn.addEventListener("click", () => void revealCopy());
  req<HTMLButtonElement>("#db-run", overlay).addEventListener("click", () => void runSql());
  sqlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runSql();
    }
  });
  prefsFile.addEventListener("change", () => {
    if (prefsFile.value) void readPrefs(prefsFile.value);
  });
  prefsRefresh.addEventListener("click", () => void loadPrefs(true));
  prefsSearch.addEventListener("input", renderPrefs);
  prefsFlutter.addEventListener("change", renderPrefs);

  const close = (): void => {
    closeSession();
    overlay.remove();
  };
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const boot = async (): Promise<void> => {
    try {
      const env = await invoke<DbEnvInfo>("android_db_env", { projectId: p.id });
      const devices = env.devices.filter((d) => d.state === "device");
      deviceSel.innerHTML = "";
      for (const d of devices) {
        const o = document.createElement("option");
        o.value = d.serial;
        o.textContent = `${d.model || d.serial}（${d.serial}）`;
        deviceSel.appendChild(o);
      }
      const saved = localStorage.getItem(dbPkgKey(p.id)) ?? "";
      pkgInput.value = saved || env.package || env.foreground || "";
      hint.textContent =
        [env.adbVersion, ...env.notes].filter(Boolean).join(" · ") || "就绪";
      if (devices.length === 0) {
        hint.textContent = env.notes.join(" · ") || "没有可用设备（检查 USB 调试）";
        return;
      }
      if (pkgInput.value.trim()) void loadFiles();
    } catch (e) {
      hint.textContent = String(e);
    }
  };
  void boot();

  deviceSel.addEventListener("change", () => {
    if (currentTab === "prefs") {
      void loadPrefs(true);
      return;
    }
    if (pkgInput.value.trim()) void loadFiles();
  });
  pkgInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (currentTab === "prefs") void loadPrefs(true);
    else void loadFiles();
  });
}

/* ---------------- 设置页 ---------------- */

/** 最后一次编译（打包）的时间：exe 修改时间与前端打包时间取较大者。
 *  exe mtime ≈ 最后一次编译链接/打包；前端常量覆盖"只重打包了前端"的情况。 */
async function buildStamp(): Promise<string | null> {
  let ms = 0;
  try {
    const exeMs = await invoke<number | null>("build_time");
    if (typeof exeMs === "number" && exeMs > 0) ms = exeMs;
  } catch {
    // 老后端 / 非 Tauri 环境：忽略，退回前端打包时间
  }
  const feMs = Date.parse(__BUILD_TIME__);
  if (Number.isFinite(feMs) && feMs > ms) ms = feMs;
  if (!ms) return null;

  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function openSettings(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="modal-head">
        <span>设置</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="settings-body"></div>
      <div class="modal-foot">
        <span class="set-version" id="settings-version"></span>
        <span class="modal-hint" id="settings-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="set-detect">自动检测</button>
        <button class="btn" id="set-cancel">取消</button>
        <button class="btn primary" id="set-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#settings-body") as HTMLDivElement;

  // 单页滚动：所有分区按固定顺序排列（不再分页签）
  const SECTION_ORDER: Record<string, number> = {
    窗口与托盘: 1,
    命令模板: 2,
    会话恢复: 3,
    终端: 4,
    编辑器: 5,
    Git: 6,
    Flutter: 7,
    Android: 8,
    HarmonyOS: 9,
    Npm: 10,
    Docker: 11,
  };

  /** 上一次「自动检测」的结果；只用来在输入框下面提示，不直接改用户填的值 */
  let detected: Detected | null = null;

  const hint = overlay.querySelector("#settings-hint") as HTMLSpanElement;
  const draft: SettingsModel = JSON.parse(
    JSON.stringify(state.settings ?? defaultSettings()),
  ) as SettingsModel;

  const close = (): void => overlay.remove();

  // 左下角：最后一次编译（打包）时间。原来显示 "state schema vN"——
  // 内部版本号对用户没意义，拿到包只需要知道"这个版本是什么时候出的"。
  const versionEl = overlay.querySelector("#settings-version") as HTMLSpanElement;
  versionEl.textContent = `${APP_NAME} · 正在读取编译时间…`;
  void buildStamp().then((t) => {
    versionEl.textContent = t
      ? `${APP_NAME} · 最后编译 ${t}`
      : `${APP_NAME} · 编译时间未知`;
  });

  const section = (title: string, desc: string): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "set-section";
    // 单页里靠序号排序，避免 build() 里的书写顺序绑死展示顺序
    s.dataset.pri = String(SECTION_ORDER[title] ?? 99);
    s.dataset.title = title;
    const h = document.createElement("div");
    h.className = "set-title";
    h.textContent = title;
    s.appendChild(h);
    if (desc) {
      const d = document.createElement("div");
      d.className = "set-desc";
      d.textContent = desc;
      s.appendChild(d);
    }
    body.appendChild(s);
    return s;
  };

  /**
   * 某一项「自动检测」得到的结果。
   * 按「分区标题 + 字段标签」对应，这样 13 个输入框不用逐个改调用。
   */
  const detectedValueFor = (sec: string, label: string): string | null => {
    const d = detected;
    if (!d) return null;

    let v: string | null | undefined;
    if (sec === "Flutter") {
      v = label === "自定义路径" ? d.flutter : null;
    } else if (sec === "Android") {
      const m: Record<string, string | null | undefined> = {
        "SDK 目录": d.android.sdkPath,
        "emulator.exe": d.android.emulatorPath,
        "AVD 目录": d.android.avdPath,
        "build-tools": d.android.buildToolsPath,
        keytool: d.android.keytoolPath,
      };
      v = m[label];
    } else if (sec === "HarmonyOS") {
      const m: Record<string, string | null | undefined> = {
        "Emulator 目录": d.harmony.emulatorPath,
        实例目录: d.harmony.instancePath,
        镜像目录: d.harmony.imageRoot,
        "Flutter 分支": d.harmony.flutterPath,
        "SDK 目录": d.harmony.sdkPath,
      };
      v = m[label];
    } else if (sec === "编辑器") {
      v = label === "编辑器程序" ? d.editor.path : null;
    } else if (sec === "Git") {
      v = d.git.desktopPath;
    } else if (sec === "Npm") {
      v = label === "node 目录" ? d.npm.nodePath : null;
    } else if (sec === "Docker") {
      v = label === "docker 路径" ? d.docker.dockerPath : null;
    }

    const t = (v ?? "").trim();
    return t ? t : null;
  };

  /**
   * 一个输入行。
   * 与「自动检测」结果不一致时，在下方提示检测到的值并提供「填写」按钮——
   * 不直接覆盖，因为输入框里可能是用户手填的。
   */
  const field = (
    parent: HTMLElement,
    label: string,
    value: string | null,
    onChange: (v: string | null) => void,
    opts: { browse?: "dir" | "none" } = {},
  ): void => {
    const row = document.createElement("div");
    row.className = "set-row";

    const lab = document.createElement("label");
    lab.textContent = label;

    const input = document.createElement("input");
    input.className = "set-input";
    input.value = value ?? "";
    input.placeholder = "未配置";
    input.addEventListener("input", () => onChange(input.value.trim() || null));

    row.append(lab, input);

    // 选文件（exe）的字段自带专用按钮（带扩展名过滤），这里就不再给目录选择器
    if ((opts.browse ?? "dir") === "dir") {
      const browse = document.createElement("button");
      browse.className = "btn";
      browse.textContent = "浏览…";
      browse.addEventListener("click", () => {
        void (async () => {
          const picked = await open({ directory: true, multiple: false, title: `选择${label}` });
          if (typeof picked === "string") {
            input.value = picked;
            onChange(picked);
          }
        })();
      });
      row.appendChild(browse);
    }

    parent.appendChild(row);

    const auto = (detectedValueFor(parent.dataset.title ?? "", label) ?? "").trim();
    const current = (value ?? "").trim();
    if (auto && auto !== current) {
      const tip = document.createElement("div");
      tip.className = "set-detected";

      const text = document.createElement("span");
      text.className = "set-detected-val";
      text.textContent = `检测到：${auto}`;
      text.title = auto;

      const fill = document.createElement("button");
      fill.className = "btn btn-tiny";
      fill.textContent = "填写";
      fill.addEventListener("click", () => {
        onChange(auto);
        build();
      });

      tip.append(text, fill);
      parent.appendChild(tip);
    }
  };

  const build = (): void => {
    body.innerHTML = "";

    // 窗口与托盘
    {
      // 老状态文件里没有 window 字段：补默认值，别让下拉框空着
      if (draft.window?.closeBehavior !== "quit" && draft.window?.closeBehavior !== "tray") {
        draft.window = { closeBehavior: "quit" };
      }

      const s = section(
        "窗口与托盘",
        "点标题栏关闭按钮时做什么。托盘图标常驻，左键或双击可把窗口拉回来。",
      );

      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "关闭按钮";

      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const [value, text] of [
        ["quit", "退出程序"],
        ["tray", "最小化到托盘"],
      ] as const) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        if (draft.window.closeBehavior === value) o.selected = true;
        sel.appendChild(o);
      }

      const note = document.createElement("div");
      note.className = "set-desc";
      const syncNote = (): void => {
        note.textContent =
          draft.window.closeBehavior === "tray"
            ? "关闭后进程驻留托盘：正在跑的构建和终端不会中断；从托盘「显示主窗口」或双击图标恢复。"
            : "关闭即退出：先结束所有终端会话与 flutter daemon，再关闭程序。";
      };
      sel.addEventListener("change", () => {
        draft.window = { closeBehavior: sel.value };
        syncNote();
      });
      syncNote();

      row.append(lab, sel);
      s.appendChild(row);
      s.appendChild(note);
    }

    // Flutter
    {
      const s = section("Flutter", "auto：优先项目 .fvm，其次自定义路径，最后 PATH");
      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "模式";
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["auto", "custom", "fvm"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        if (draft.flutterTool.mode === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.flutterTool.mode = sel.value;
      });
      row.append(lab, sel);
      s.appendChild(row);
      field(s, "自定义路径", draft.flutterTool.customPath, (v) => {
        draft.flutterTool.customPath = v;
      });

      // rename CLI：检查 pub global 安装与 PATH；安装/更新也放这里，避免用户另开终端
      const renameRow = document.createElement("div");
      renameRow.className = "set-row";
      const renameLab = document.createElement("label");
      renameLab.textContent = "rename CLI";
      const renameCell = document.createElement("div");
      renameCell.className = "set-cell";
      const renameState = document.createElement("span");
      renameState.className = "set-desc";
      renameState.textContent = "检查中…";
      const renameCheck = document.createElement("button");
      renameCheck.className = "btn";
      renameCheck.textContent = "重新检查";
      const renameInstall = document.createElement("button");
      renameInstall.className = "btn";
      renameInstall.textContent = "安装 / 更新";
      const renameCopy = document.createElement("button");
      renameCopy.className = "btn";
      renameCopy.textContent = "复制 PATH 目录";
      renameCopy.hidden = true;
      renameCell.append(renameState, renameCheck, renameInstall, renameCopy);
      renameRow.append(renameLab, renameCell);
      s.appendChild(renameRow);

      const renameNote = document.createElement("div");
      renameNote.className = "set-desc";
      s.appendChild(renameNote);

      let renamePubBin = "";
      const renderRename = (st: FlutterRenameStatus): void => {
        renamePubBin = st.pubBin;
        renameState.classList.remove("rename-ok", "rename-warn", "rename-bad");
        if (!st.installed) {
          renameState.textContent = "未安装";
          renameState.classList.add("rename-bad");
        } else if (!st.onPath) {
          renameState.textContent = `已安装 ${st.version ?? ""} · 不在 PATH`;
          renameState.classList.add("rename-warn");
        } else {
          renameState.textContent = `已安装 ${st.version ?? ""} · PATH 已就绪`;
          renameState.classList.add("rename-ok");
        }

        const parts: string[] = [];
        if (st.exe) parts.push(`命令：${st.exe}`);
        if (!st.onPath) {
          parts.push(
            `pub bin：${st.pubBin}（把这个目录加入用户 PATH 后，终端里才能直接运行 rename）`,
          );
        }
        if (!st.installed) {
          parts.push("点「安装 / 更新」会执行：flutter pub global activate rename");
        }
        if (st.error) parts.push(st.error);
        renameNote.textContent = parts.join("\n");
        renameNote.style.whiteSpace = "pre-line";
        renameCopy.hidden = st.onPath;
        renameCopy.title = `复制 ${st.pubBin}`;
      };

      const refreshRename = async (force = false): Promise<void> => {
        renameCheck.disabled = true;
        renameState.textContent = "检查中…";
        try {
          const st = await invoke<FlutterRenameStatus>(
            force ? "rename_refresh" : "rename_status",
          );
          renderRename(st);
        } catch (e) {
          renameState.textContent = "检查失败";
          renameState.classList.add("rename-bad");
          renameNote.textContent = String(e);
        } finally {
          renameCheck.disabled = false;
        }
      };

      renameCheck.addEventListener("click", () => void refreshRename(true));
      renameInstall.addEventListener("click", () => {
        void (async () => {
          renameInstall.disabled = true;
          renameInstall.textContent = "安装中…";
          renameState.textContent = "正在执行 flutter pub global activate rename…";
          try {
            const res = await invoke<FlutterRenameActivation>("rename_activate");
            renderRename(res.status);
            toast(
              res.status.onPath
                ? `rename 已安装并在 PATH 中：${res.status.version ?? ""}`
                : `rename 已安装，但不在 PATH；请把 ${res.status.pubBin} 加入 PATH`,
            );
          } catch (e) {
            renameState.textContent = "安装失败";
            renameState.classList.add("rename-bad");
            renameNote.textContent = String(e);
            toast(String(e), "error");
          } finally {
            renameInstall.disabled = false;
            renameInstall.textContent = "安装 / 更新";
          }
        })();
      });
      renameCopy.addEventListener("click", () => {
        if (!renamePubBin) return;
        void navigator.clipboard
          .writeText(renamePubBin)
          .then(() => toast("已复制 PATH 目录"))
          .catch((e) => toast(String(e), "error"));
      });
      void refreshRename();
    }

    // 命令模板
    {
      const s = section(
        "命令模板",
        `共 ${state.commandTemplates.length} 条；新建「单应用」项目会自动套用，也可在项目树里按需导入`,
      );
      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "模板库";
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "管理命令模板…";
      btn.addEventListener("click", () => {
        // 不关闭设置面板：模板库叠在上面，关掉后还能继续改设置
        openTemplateManager();
      });
      row.append(lab, btn);
      s.appendChild(row);
    }

    // 会话恢复
    {
      const s = section("会话恢复", "重启后恢复 tab 与历史输出，但不自动拉起进程");
      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "历史";
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "清空已保存的会话历史";
      btn.addEventListener("click", () => {
        void (async () => {
          const ok = await confirm("清空后，下次启动不会再恢复这些 tab。确定？", {
            title: "清空会话历史",
            kind: "warning",
          });
          if (!ok) return;
          try {
            await invoke("clear_session_logs");
            toast("已清空会话历史");
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });
      row.append(lab, btn);
      s.appendChild(row);
    }

    // Android
    {
      const s = section("Android", "SDK、emulator.exe、AVD 目录");
      field(s, "SDK 目录", draft.android.sdkPath, (v) => {
        draft.android.sdkPath = v;
      });
      field(s, "emulator.exe", draft.android.emulatorPath, (v) => {
        draft.android.emulatorPath = v;
      });
      field(s, "AVD 目录", draft.android.avdPath, (v) => {
        draft.android.avdPath = v;
      });
      field(s, "build-tools", draft.android.buildToolsPath, (v) => {
        draft.android.buildToolsPath = v;
      });
      field(s, "keytool", draft.android.keytoolPath, (v) => {
        draft.android.keytoolPath = v;
      });
      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent =
        "build-tools（aapt2 / apksigner）留空则取 SDK 下最高版本；keytool 留空则自动探测。备案只用到这两个。";
      s.appendChild(note);
    }

    // HarmonyOS
    {
      const s = section("HarmonyOS", "DevEco 模拟器（Emulator.exe）与鸿蒙 Flutter 分支");
      field(s, "Emulator 目录", draft.harmony.emulatorPath, (v) => {
        draft.harmony.emulatorPath = v;
      });
      field(s, "实例目录", draft.harmony.instancePath, (v) => {
        draft.harmony.instancePath = v;
      });
      field(s, "镜像目录", draft.harmony.imageRoot, (v) => {
        draft.harmony.imageRoot = v;
      });
      field(s, "Flutter 分支", draft.harmony.flutterPath, (v) => {
        draft.harmony.flutterPath = v;
      });
      field(s, "SDK 目录", draft.harmony.sdkPath, (v) => {
        draft.harmony.sdkPath = v;
      });

      // 鸿蒙环境变量：只注入有 ohos/ 的工程
      const envTitle = document.createElement("div");
      envTitle.className = "set-sub";
      envTitle.textContent = "环境变量（仅鸿蒙工程生效）";
      s.appendChild(envTitle);

      const envNote = document.createElement("div");
      envNote.className = "set-desc";
      envNote.textContent =
        "如 FLUTTER_STORAGE_BASE_URL / PUB_CACHE / DEVECO_SDK_HOME / FLUTTER_GIT_URL。" +
        "项目里 .fvmrc 的 env 会覆盖这里的同名项；项目右键「环境变量…」可再按项目覆盖。";
      s.appendChild(envNote);

      const envBox = document.createElement("div");
      envBox.className = "env-list";
      s.appendChild(envBox);

      // 本地行数组，改完同步回 draft.harmony.env（空 KEY 不落盘）
      const rows: Array<[string, string]> = Object.entries(draft.harmony.env ?? {});
      const syncEnv = () => {
        const m: Record<string, string> = {};
        for (const [k, v] of rows) if (k.trim() !== "") m[k.trim()] = v;
        draft.harmony.env = m;
      };

      const renderEnv = () => {
        envBox.innerHTML = "";

        rows.forEach(([k, v], idx) => {
          const row = document.createElement("div");
          row.className = "env-row";

          const kEl = document.createElement("input");
          kEl.className = "set-input env-key";
          kEl.value = k;
          kEl.placeholder = "KEY";
          kEl.addEventListener("input", () => {
            rows[idx][0] = kEl.value;
            syncEnv();
          });

          const vEl = document.createElement("input");
          vEl.className = "set-input";
          vEl.value = v;
          vEl.placeholder = "value";
          vEl.addEventListener("input", () => {
            rows[idx][1] = vEl.value;
            syncEnv();
          });

          const del = document.createElement("button");
          del.className = "btn";
          del.textContent = "×";
          del.title = "删除该变量";
          del.addEventListener("click", () => {
            rows.splice(idx, 1);
            syncEnv();
            renderEnv();
          });

          row.append(kEl, vEl, del);
          envBox.appendChild(row);
        });

        if (rows.length === 0) {
          const empty = document.createElement("div");
          empty.className = "set-desc";
          empty.textContent = "（暂无，可点下方添加）";
          envBox.appendChild(empty);
        }

        const add = document.createElement("button");
        add.className = "btn";
        add.textContent = "＋ 添加变量";
        add.addEventListener("click", () => {
          rows.push(["", ""]);
          renderEnv();
        });
        envBox.appendChild(add);
      };
      renderEnv();

      // 终端环境提示属于鸿蒙，放在这里（原来错放在「通用 → 终端」下面）
      const termHint = document.createElement("div");
      termHint.className = "set-desc";
      termHint.textContent =
        "打开的终端会继承项目环境：鸿蒙工程自动注入全局/项目变量并前置 PATH shim，" +
        "可直接敲 flutter --version。";
      s.appendChild(termHint);
    }

    // 默认终端
    {
      const s = section("终端", "项目右键「在终端中打开」使用；留空则自动探测");
      field(
        s,
        "终端程序",
        draft.terminal?.path ?? "",
        (v) => {
          const t = (v ?? "").trim();
          draft.terminal = { path: t === "" ? null : t };
        },
        { browse: "none" }, // 下面有带 exe 过滤的「浏览 exe…」
      );

      const bar = document.createElement("div");
      bar.className = "set-desc";
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.alignItems = "center";

      const detectBtn = document.createElement("button");
      detectBtn.className = "btn";
      detectBtn.textContent = "从系统读取";
      detectBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const list = await invoke<Array<{ name: string; path: string }>>("detect_terminals");
            if (list.length === 0) {
              toast("没有检测到可用终端", "error");
              return;
            }
            draft.terminal = { path: list[0].path };
            const more = list.slice(1).map((x) => x.name).join("、");
            toast(`已选择 ${list[0].name}${more ? `；系统还检测到：${more}` : ""}`);
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      const browseBtn = document.createElement("button");
      browseBtn.className = "btn";
      browseBtn.textContent = "浏览 exe…";
      browseBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择终端可执行文件",
              filters: [{ name: "可执行文件", extensions: ["exe"] }],
              defaultPath: draft.terminal?.path ?? undefined,
            });
            if (!picked) return;
            const p = Array.isArray(picked) ? picked[0] : picked;
            draft.terminal = { path: p };
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(detectBtn, browseBtn);
      s.appendChild(bar);
    }

    // 默认编辑器（终端里的路径可点开）
    {
      const s = section(
        "编辑器",
        "终端里的路径和 package: 链接用 Ctrl+单击打开；留空则自动探测",
      );
      field(
        s,
        "编辑器程序",
        draft.editor?.path ?? "",
        (v) => {
          const t = (v ?? "").trim();
          draft.editor = { path: t === "" ? null : t };
        },
        { browse: "none" }, // 下面有带 exe 过滤的「浏览 exe…」
      );

      const bar = document.createElement("div");
      bar.className = "set-desc";
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.alignItems = "center";

      const browseBtn = document.createElement("button");
      browseBtn.className = "btn";
      browseBtn.textContent = "浏览 exe…";
      browseBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择编辑器程序（Code.exe / zed.exe / sublime_text.exe…）",
              filters: [{ name: "可执行文件", extensions: ["exe"] }],
              defaultPath: draft.editor?.path ?? undefined,
            });
            if (!picked) return;
            const p = Array.isArray(picked) ? picked[0] : picked;
            draft.editor = { path: p };
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(browseBtn);
      s.appendChild(bar);

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "留空则自动探测（VS Code / Zed / Sublime Text / Cursor / Notepad++）。" +
        "请选 GUI 程序，不要选 bin 目录里的 code.cmd、subl 这类启动脚本";
      s.appendChild(hint);

      // 留空时告诉用户实际会用哪一个，免得"未配置"让人以为不能用
      void (async () => {
        try {
          const auto = await invoke<string | null>("detect_editor_path");
          // 跑过「自动检测」后，输入框下面已经有「检测到：…」，这里不再重复
          if (!draft.editor?.path && auto && !detected) {
            hint.textContent = `留空时使用：${auto}`;
          }
        } catch {
          /* 探测失败就保持通用提示 */
        }
      })();
    }

    // Git 桌面客户端（GitHub Desktop 等）
    {
      const s = section(
        "Git",
        "填了程序后，项目右键会出现「在 Git Desktop 中打开」；留空则不显示该项",
      );

      field(
        s,
        "Git Desktop 程序",
        draft.git?.desktopPath ?? "",
        (v) => {
          const t = (v ?? "").trim();
          draft.git = { desktopPath: t === "" ? null : t };
        },
        { browse: "none" }, // 下面有带 exe 过滤的「浏览…」
      );

      const bar = document.createElement("div");
      bar.className = "set-desc";
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.alignItems = "center";

      const browseBtn = document.createElement("button");
      browseBtn.className = "btn";
      browseBtn.textContent = "浏览 GitHubDesktop.exe…";
      browseBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择 Git 桌面客户端（GitHubDesktop.exe / SourceTree.exe…）",
              filters: [{ name: "可执行文件", extensions: ["exe"] }],
              defaultPath: draft.git?.desktopPath ?? undefined,
            });
            if (!picked) return;
            const p = Array.isArray(picked) ? picked[0] : picked;
            draft.git = { desktopPath: p };
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      const fillBtn = document.createElement("button");
      fillBtn.className = "btn";
      fillBtn.textContent = "读取已安装的 GitHub Desktop";
      fillBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const auto = await invoke<string | null>("detect_git_desktop_path");
            if (!auto) {
              toast("没有自动检测到 GitHub Desktop，请手动浏览 exe", "error");
              return;
            }
            draft.git = { desktopPath: auto };
            build();
            toast("已填入探测到的 GitHub Desktop");
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(browseBtn, fillBtn);
      s.appendChild(bar);

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "GitHub Desktop 会自动用 --cli-open 打开项目目录；其它客户端按「程序 + 目录」启动。";
      s.appendChild(hint);
    }

    // Npm
    {
      const s = section(
        "Npm",
        "导入 package.json 时按这里的规则生成命令；分类只是猜测，可在命令里逐条改",
      );

      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "包管理器";
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["auto", "npm", "pnpm", "yarn"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m === "auto" ? "auto（按 lockfile 探测）" : m;
        if ((draft.npm?.manager ?? "auto") === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.npm = { ...(draft.npm ?? { nodePath: null }), manager: sel.value };
      });
      const cell = document.createElement("div");
      cell.className = "set-cell";
      cell.appendChild(sel);
      row.append(lab, cell);
      s.appendChild(row);

      field(s, "node 目录", draft.npm?.nodePath ?? "", (v) => {
        const t = (v ?? "").trim();
        draft.npm = { ...(draft.npm ?? { manager: null }), nodePath: t === "" ? null : t };
      });

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "auto：pnpm-lock.yaml > yarn.lock > package-lock.json > npm。" +
        "dev/start/serve → 长时间运行；build/bundle → 一次性产物；其余 → 普通任务。";
      s.appendChild(hint);
    }

    // Docker
    {
      const s = section("Docker", "docker-compose 导入尚未实现，这里先保留路径与调用风格");

      field(s, "docker 路径", draft.docker?.dockerPath ?? "", (v) => {
        const t = (v ?? "").trim();
        draft.docker = {
          ...(draft.docker ?? { composeStyle: null }),
          dockerPath: t === "" ? null : t,
        };
      });

      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "compose 风格";
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["auto", "v2", "v1"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent =
          m === "auto" ? "auto（优先 v2）" : m === "v2" ? "v2：docker compose" : "v1：docker-compose";
        if ((draft.docker?.composeStyle ?? "auto") === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.docker = { ...(draft.docker ?? { dockerPath: null }), composeStyle: sel.value };
      });
      const cell = document.createElement("div");
      cell.className = "set-cell";
      cell.appendChild(sel);
      row.append(lab, cell);
      s.appendChild(row);

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "导入 compose 后：每个 service 生成「启动 / 日志」，整份文件再加一条「全部停止」。" +
        "命令用确定性 id 去重，服务被删只标失效、不删数据。";
      s.appendChild(hint);
    }

    // 单页滚动：按 SECTION_ORDER 重排（书写顺序不必等于展示顺序）
    const sections = Array.from(body.querySelectorAll<HTMLElement>(".set-section"));
    sections.sort((a, b) => Number(a.dataset.pri) - Number(b.dataset.pri));
    for (const el of sections) body.appendChild(el);
  };

  build();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#set-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const detectBtn = overlay.querySelector("#set-detect") as HTMLButtonElement;
  detectBtn.addEventListener("click", () => {
    // 只做探测：不覆盖用户已经填过的值。
    // 探测结果以「检测到：…」+「填写」的形式挂在对应输入框下面，由用户决定要不要用。
    detectBtn.disabled = true;
    hint.textContent = "检测中…";
    void (async () => {
      try {
        detected = await invoke<Detected>("detect_toolchains");
        build();
        hint.textContent = "";
        toast("检测完成：与当前设置不同的项已在输入框下方标出");
      } catch (e) {
        hint.textContent = String(e);
      } finally {
        detectBtn.disabled = false;
      }
    })();
  });

  (overlay.querySelector("#set-save") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        state = await invoke<State>("save_settings", { settings: draft });
        close();
        render();
        toast("设置已保存");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 启动 ---------------- */


async function boot(): Promise<void> {
  const app = req<HTMLDivElement>("#app");

  app.innerHTML = `
    <div class="app">
      <header class="toolbar">
        <div class="tb-menu">
          <button class="btn menu-btn" id="btn-import-menu">导入 ▾</button>
          <button class="btn menu-btn" id="btn-custom-menu">自定义命令 ▾</button>
          <button class="btn menu-btn" id="btn-tools-menu">工具 ▾</button>
        </div>
        <div class="tb-center"></div>
        <div class="tb-right">
          <button class="btn" id="btn-emulators" title="可启动的模拟器">📱 模拟器</button>
          <button class="btn icon" id="btn-settings" title="设置">⚙</button>
        </div>
      </header>

      <div class="tabstrip" id="tabstrip"></div>

      <div class="main">
        <section class="left">
          <div class="term-controls">
            <span class="flutter-tools" id="flutter-tools">
              <button class="cbtn" id="btn-reload" disabled><i class="hi">⚡</i>热重载</button>
              <button class="cbtn" id="btn-restart" disabled><i class="hi">🔄</i>热重启</button>
              <button class="cbtn" id="btn-devtools" disabled><i class="hi">🌐</i>DevTools</button>
            </span>
            <span class="session-tools" id="session-tools">
              <button class="cbtn danger" id="btn-stop" disabled><i class="hi">⏹</i>停止</button>
              <button class="cbtn" id="btn-rerun" disabled><i class="hi">⟳</i>重跑</button>
              <button class="cbtn" id="btn-find" disabled title="搜索日志（Ctrl+F）"><i class="hi">🔍</i>搜索</button>
              <button class="cbtn" id="btn-clear" disabled title="清空当前会话的日志（含回滚区；不影响进程）"><i class="hi">🧹</i>清空</button>
              <button class="cbtn" id="btn-open-proj" disabled title="用编辑器打开本会话的项目目录"><i class="hi">📂</i>项目</button>
            </span>
            <span class="flex1"></span>
            <span class="artifact-bar" id="artifact-bar"></span>
            <span class="ctx-info" id="ctx-info">等待会话</span>
          </div>
          <div class="term-holder" id="term-holder">
            <div class="term-search" id="term-search" hidden>
              <input
                id="term-search-input"
                type="text"
                placeholder="搜索日志…"
                spellcheck="false"
                autocomplete="off"
              />
              <span class="ts-count" id="term-search-count">0 个</span>
              <button class="ts-btn" id="term-search-prev" title="上一个（Shift+Enter）">⌃</button>
              <button class="ts-btn" id="term-search-next" title="下一个（Enter）">⌄</button>
              <button class="ts-btn" id="term-search-close" title="关闭（Esc）">×</button>
            </div>
            <div class="empty-term" id="term-empty">
              <div class="et-glyph">▮</div>
              <div class="et-title">还没有运行中的会话</div>
              <div class="et-sub">
                在右侧项目树中选择一条命令，点行内 <b>▶</b> 或双击该行即可启动
              </div>
            </div>
          </div>
        </section>

        <div class="splitter" id="splitter"></div>

        <aside class="right">
          <div class="panel-head">
            <span>项目</span>
            <span class="dim" id="proj-count">0 个项目</span>
          </div>
          <div class="tree" id="tree"></div>
        </aside>
      </div>

      <footer class="statusbar">
        <span class="sb-item ok">就绪</span>
        <span class="sb-sep"></span>
        <span class="sb-item" id="sb-state">0 个项目</span>
        <span class="sb-sep"></span>
        <span class="sb-item" id="sb-path"></span>
        <span class="sb-sep"></span>
        <span class="sb-item" id="sb-sessions">会话 0</span>
        <span class="flex1"></span>
        <span class="sb-item">ConPTY</span>
        <span class="sb-sep"></span>
        <span class="sb-item">UTF-8</span>
      </footer>
    </div>
  `;

  render();

  await listen<{ id: string; data: string }>("pty://output", (e) => {
    handleOutput(e.payload.id, e.payload.data);
    autosaveSessions();
  });
  await listen<{ id: string; code: number | null }>("pty://exit", (e) => {
    handleExit(e.payload.id, e.payload.code);
  });

  // 设备菜单：点击外部 / Esc 关闭
  document.addEventListener("mousedown", (e) => {
    if (deviceMenuEl && !deviceMenuEl.contains(e.target as Node)) closeDeviceMenu();
    if (emuMenuEl && !emuMenuEl.contains(e.target as Node)) closeEmuMenu();
    // 链接菜单：点外部才关，点菜单内部不能关（否则点不到菜单项）
    if (linkMenuEl && !linkMenuEl.contains(e.target as Node)) closeLinkMenu();
    if (
      projMenuEl &&
      !projMenuEl.contains(e.target as Node) &&
      !(subMenuEl && subMenuEl.contains(e.target as Node))
    ) {
      closeAllMenus();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeDeviceMenu();
    closeEmuMenu();
    closeLinkMenu();
    closeAllMenus();
  });
  window.addEventListener("blur", () => {
    closeDeviceMenu();
    closeLinkMenu();
    // 焦点在终端上时，Esc 也能收起搜索条
    closeSearch();
  });

  req<HTMLButtonElement>("#btn-import-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    openImportMenu(e.currentTarget as HTMLElement);
  });
  req<HTMLButtonElement>("#btn-custom-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    openCustomCommandMenu();
  });
  req<HTMLButtonElement>("#btn-tools-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    openToolsMenu(e.currentTarget as HTMLElement);
  });
  req<HTMLButtonElement>("#btn-settings").addEventListener("click", () => openSettings());
  req<HTMLButtonElement>("#btn-rerun").addEventListener("click", () => {
    const s = activeSession();
    if (s) void rerunSession(s);
  });
  req<HTMLButtonElement>("#btn-emulators").addEventListener("click", (e) =>
    openEmulatorMenu(e.currentTarget as HTMLElement),
  );
  req<HTMLButtonElement>("#btn-reload").addEventListener("click", () => sendKey("r"));
  req<HTMLButtonElement>("#btn-restart").addEventListener("click", () => sendKey("R"));
  req<HTMLButtonElement>("#btn-stop").addEventListener("click", () => void stopActive());
  req<HTMLButtonElement>("#btn-devtools").addEventListener("click", () => {
    const url = activeSession()?.devToolsUrl;
    if (url) void openUrl(url).catch((e) => toast(String(e), "error"));
  });

  // 日志搜索 / 清空
  req<HTMLButtonElement>("#btn-find").addEventListener("click", () => openSearch());
  req<HTMLButtonElement>("#btn-clear").addEventListener("click", () => void clearActiveLog());
  req<HTMLButtonElement>("#term-search-next").addEventListener("click", () => runSearch(true));
  req<HTMLButtonElement>("#term-search-prev").addEventListener("click", () => runSearch(false));
req<HTMLButtonElement>("#term-search-close").addEventListener("click", () => closeSearch());
  req<HTMLButtonElement>("#btn-open-proj").addEventListener("click", () => void openProjectFolder());

  const searchInput = req<HTMLInputElement>("#term-search-input");
  searchInput.addEventListener("input", () => runSearch(true));
  searchInput.addEventListener("keydown", (e) => {
    // 搜索框里的按键不能漏给终端，也不能触发全局 Esc 逻辑
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch(!e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
    // 别抢其它输入框里的 Ctrl+F
    const ae = document.activeElement as HTMLElement | null;
    const typing = ae?.tagName === "INPUT" || ae?.tagName === "TEXTAREA";
    if (typing && ae?.id !== "term-search-input") return;
    if (!activeSession()?.term) return;
    e.preventDefault();
    openSearch();
  });

  try {
    const [s, loc] = await Promise.all([
      invoke<State>("load_state"),
      invoke<string>("state_location"),
    ]);
    state = s;
    statePath = loc;
    // 恢复上次的项目折叠状态（没记录的默认展开）
    collapsed.clear();
    for (const id of s.ui?.collapsedProjects ?? []) collapsed.add(id);
  } catch (e) {
    toast(`载入状态失败：${String(e)}`, "error");
  }

  render();
  // 文件夹项目不是 Flutter 工程，不做探测（否则会在树里显示「不可用」）
  for (const p of state.projects) {
    if (p.kind !== "folder") void refreshFlutter(p.id);
  }

  // D-10：恢复上次的 tab 壳与历史输出（进程不拉起）
  await restoreSessions();

  // 开发期：FLA_RERUN=1 时自动对第一个恢复会话点一次「重跑」，
  // 用于验证"替换标签"这类交互（无人值守也能截图核对）
  if (await invoke<string | null>("dev_env", { name: "FLA_RERUN" })) {
    const first = sessions[0];
    if (first) {
      activateSession(first.id);
      window.setTimeout(() => void rerunSession(first), 600);
    }
  }

  // §14 体检：**只读缓存，不主动跑**。flutter doctor 要 20+ 秒，
  // 什么时候检查由用户点「体检」决定。
  void loadCachedDoctor().then(async () => {
    if (await invoke<string | null>("dev_env", { name: "FLA_DOCTOR_DETAIL" })) {
      openDoctorReport();
    }
  });

  // 开发期自动启动（FLA_AUTOSTART 环境变量）
  try {
    const auto = await invoke<DevAutostart | null>("dev_autostart");
    if (auto) {
      const proj = state.projects.find((x) => x.id === auto.projectId);
      const cmd = proj?.commands.find((x) => x.id === auto.commandId);
      if (proj && cmd) void runCommand(proj, cmd, auto.deviceId ?? undefined);
      else console.warn("[autostart] 未找到项目或命令", auto);
    }

    // 开发期：用编辑器打开某项目的目录（FLA_OPEN_DIR="<项目id>"），
    // 走的是项目右键「用编辑器打开目录」完全相同的代码路径
    const openDirHook = await invoke<string | null>("dev_env", { name: "FLA_OPEN_DIR" });
    if (openDirHook) {
      const proj = state.projects.find((x) => x.id === openDirHook) ?? state.projects[0];
      if (proj) void editFile(proj.path);
    }

    // 开发期：模拟"折叠若干项目"（FLA_COLLAPSE="<id>,<id>"），
    // 走的是和点击完全相同的代码路径（加进集合 → 重绘 → 落盘）
    const collapseHook = await invoke<string | null>("dev_env", { name: "FLA_COLLAPSE" });
    if (collapseHook) {
      for (const id of collapseHook.split(",")) {
        const t = id.trim();
        if (t) collapsed.add(t);
      }
      renderTree();
      scheduleSaveCollapsed();
    }

    // 开发期：直接打开一处位置（FLA_OPEN_LOCATION="<cwd>|<文本>"），
    // 用于无人值守验证"路径可点"这条链路（走的是和点击完全相同的代码）
    const openHook = await invoke<string | null>("dev_env", { name: "FLA_OPEN_LOCATION" });
    if (openHook) {
      const [cwd, ...rest] = openHook.split("|");
      void openLocation(cwd, rest.join("|"));
    }

    // 开发期：验证"清空 / 搜索"这两条链路（不用手动点）
    //   FLA_TERM_DEBUG=clear  → 清空当前会话并把清空前后缓冲区长度打到 toast
    //   FLA_TERM_FIND=<文本>   → 打开搜索条并搜这段文本
    const termDebug = await invoke<string | null>("dev_env", { name: "FLA_TERM_DEBUG" });
    if (termDebug === "clear") {
      const s = activeSession();
      if (s?.term) {
        const before = s.term.buffer.active.length;
        const beforeBase = s.term.buffer.active.baseY;
        await clearActiveLog();
        const after = s.term.buffer.active.length;
        toast(`buffer 行数 ${before}(baseY ${beforeBase}) → ${after}`, "error");
      }
    }
    const termFind = await invoke<string | null>("dev_env", { name: "FLA_TERM_FIND" });
    if (termFind) {
      openSearch();
      req<HTMLInputElement>("#term-search-input").value = termFind;
      runSearch(true);
    }

    // 开发期：自动弹出设备菜单（FLA_DEVICE_MENU=<项目ID>），便于无人值守截图
    const menuProject = await invoke<string | null>("dev_env", { name: "FLA_DEVICE_MENU" });
    if (menuProject) {
      const proj = state.projects.find((x) => x.id === menuProject) ?? state.projects[0];
      const cmd = proj?.commands[0];
      if (proj && cmd) {
        const ev = new MouseEvent("contextmenu", { clientX: 1180, clientY: 210 });
        // 与真实右键一致：需要设备 → 设备菜单，否则 → 命令菜单
        openCommandMenu(ev, proj, cmd);
      }
    }

    // 开发期：自动打开设置页 / 模拟器菜单
    const settingsHook = await invoke<string | null>("dev_env", { name: "FLA_SETTINGS" });
    if (settingsHook) {
      openSettings();
      // FLA_SETTINGS=detect：自动点一下「自动检测」，便于截图核对检测提示
      if (settingsHook === "detect") {
        window.setTimeout(() => {
          document.querySelector<HTMLButtonElement>("#set-detect")?.click();
        }, 400);
      }
      // FLA_SETTINGS=npm 之类：单页没有分页了，把对应分区滚到视野内，便于截图核对
      if (settingsHook !== "1" && settingsHook !== "detect") {
        const want = settingsHook.toLowerCase();
        window.setTimeout(() => {
          for (const el of Array.from(
            document.querySelectorAll<HTMLElement>("#settings-body .set-section"),
          )) {
            const title = el.querySelector(".set-title")?.textContent?.toLowerCase() ?? "";
            if (title.includes(want)) {
              el.scrollIntoView({ block: "start" });
              break;
            }
          }
        }, 300);
      }
    }
    if (await invoke<string | null>("dev_env", { name: "FLA_IMPORT_MENU" })) {
      window.setTimeout(() => {
        const b = document.querySelector<HTMLButtonElement>("#btn-import-menu");
        if (b) openImportMenu(b);
      }, 600);
    }
    if (await invoke<string | null>("dev_env", { name: "FLA_EMU_MENU" })) {
      const anchor = document.querySelector<HTMLButtonElement>("#btn-emulators");
      if (anchor) openEmulatorMenu(anchor);
    }
    // 开发期：直接打开「进程与端口」面板（用于截图核对）
    if (await invoke<string | null>("dev_env", { name: "FLA_PROCESSES" })) {
      window.setTimeout(() => openProcessPanel(), 600);
    }
    const pkgHook = await invoke<string | null>("dev_env", { name: "FLA_IMPORT_PKG" });
    if (pkgHook) {
      window.setTimeout(() => {
        void (async () => {
          try {
            const res = await invoke<NpmImportResponse>("import_package_path", { path: pkgHook });
            state = res.state;
            render();
            toast(
              `导入「${res.projectName}」：新增 ${res.added.length} 条（${res.added.join(", ")}）`,
            );
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      }, 800);
    }
    if (await invoke<string | null>("dev_env", { name: "FLA_REIMPORT_DOCKER" })) {
      window.setTimeout(() => {
        void (async () => {
          const ids = state.projects
            .filter((p) => p.commands.some((c) => c.source === "docker"))
            .map((p) => p.id);
          for (const id of ids) {
            const proj = state.projects.find((x) => x.id === id);
            if (!proj) continue;
            try {
              const res = await invoke<ComposeImportResponse>("import_compose_path", {
                path: proj.path,
              });
              state = res.state;
            } catch (e) {
              console.warn("[docker 重读失败]", proj.path, String(e));
            }
          }
          render();
          toast(`已重读 ${ids.length} 个 docker 项目`);
        })();
      }, 700);
    }
    const svcHook = await invoke<string | null>("dev_env", { name: "FLA_SERVICE_MENU" });
    if (svcHook) {
      // 树是异步渲染的（要先展开项目），单次 setTimeout 容易扑空 → 轮询 3 秒
      let tries = 0;
      const fire = (): void => {
        const row = Array.from(document.querySelectorAll<HTMLDivElement>(".cmd.svc")).find(
          (r) => r.querySelector(".cname")?.textContent === svcHook,
        );
        if (!row) {
          if (++tries < 12) window.setTimeout(fire, 250);
          return;
        }
        const r = row.getBoundingClientRect();
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: Math.round(r.left + 80),
            clientY: Math.round(r.top + 12),
          }),
        );
      };
      window.setTimeout(fire, 600);
    }
    const composeHook = await invoke<string | null>("dev_env", { name: "FLA_IMPORT_COMPOSE" });
    if (composeHook) {
      window.setTimeout(() => {
        void (async () => {
          try {
            const res = await invoke<ComposeImportResponse>("import_compose_path", {
              path: composeHook,
            });
            state = res.state;
            render();
            toast(`导入「${res.projectName}」：${res.services} 个服务，新增 ${res.added.length} 条`);
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      }, 800);
    }
    if (await invoke<string | null>("dev_env", { name: "FLA_TEMPLATES" })) {
      openTemplateManager();
    }
    const tplImport = await invoke<string | null>("dev_env", { name: "FLA_TPL_IMPORT" });
    if (tplImport) {
      const proj = state.projects.find((x) => x.id === tplImport) ?? state.projects[0];
      if (proj) openTemplateImport(proj);
    }
    const editTpl = await invoke<string | null>("dev_env", { name: "FLA_EDIT_TEMPLATE" });
    if (editTpl) {
      const t = state.commandTemplates.find((x) => x.id === editTpl);
      if (t) void openCommandDialog(null, t);
    }
    devSubmenu = await invoke<string | null>("dev_env", { name: "FLA_SUBMENU" });

    const termHook = await invoke<string | null>("dev_env", { name: "FLA_TERMINAL" });
    if (termHook) {
      const target = state.projects.find((x) => x.id === termHook);
      if (target) void openProjectTerminal(target);
    }

    if (await invoke<string | null>("dev_env", { name: "FLA_EXAMPLES" })) {
      showUsageExamples(() => {});
    }

    const envHook = await invoke<string | null>("dev_env", { name: "FLA_ENV" });
    if (envHook) {
      const target = state.projects.find((x) => x.id === envHook);
      if (target) void openEnvDialog(target);
    }
    const filingHook = await invoke<string | null>("dev_env", { name: "FLA_FILING" });
    if (filingHook) void showFilingInfo(filingHook);

    // 数据库查看器：FLA_DB="<项目id>" 启动即打开，便于截图/无人值守验证
    const dbHook = await invoke<string | null>("dev_env", { name: "FLA_DB" });
    if (dbHook) {
      const target = state.projects.find((x) => x.id === dbHook);
      if (target) void openDbInspector(target);
    }

    const projMenu = await invoke<string | null>("dev_env", { name: "FLA_PROJ_MENU" });
    if (projMenu) {
      const proj = state.projects.find((x) => x.id === projMenu) ?? state.projects[0];
      if (proj) {
        openProjectMenu(new MouseEvent("contextmenu", { clientX: 1500, clientY: 640 }), proj);
        // FLA_REFRESH_PLATFORM=1：菜单打开后自动点一次「重新分析平台信息」，
        // 用于验证刷新时菜单不该消失、平台段应原地更新
        if (await invoke<string | null>("dev_env", { name: "FLA_REFRESH_PLATFORM" })) {
          window.setTimeout(() => {
            const row = Array.from(
              document.querySelectorAll<HTMLDivElement>(".device-menu .dm-item"),
            ).find((el) => el.querySelector(".dm-name")?.textContent === "重新分析平台信息");
            row?.click();
          }, 800);
        }
      }
    }
    const runTpl = await invoke<string | null>("dev_env", { name: "FLA_RUN_TEMPLATE" });
    if (runTpl) {
      const [pid, tid] = runTpl.split("|");
      const proj = state.projects.find((x) => x.id === pid);
      const tpl = state.commandTemplates.find((x) => x.id === tid);
      if (proj && tpl) void runTemplate(proj, tpl);
    }
  } catch (e) {
    // 钩子出错不能静默：否则后续钩子全被跳过，且看不出原因
    toast("开发钩子执行失败：" + String(e), "error");
  }

  // 分割条
  const splitter = req<HTMLDivElement>("#splitter");
  const right = req<HTMLElement>(".right");
  let dragging = false;
  splitter.addEventListener("mousedown", () => {
    dragging = true;
    document.body.classList.add("dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const total = window.innerWidth;
    const w = Math.min(Math.max(total - e.clientX, 260), total * 0.55);
    right.style.flexBasis = `${w}px`;
    activeSession()?.fit?.fit();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.classList.remove("dragging");
  });
  window.addEventListener("resize", () => activeSession()?.fit?.fit());
}

window.addEventListener("DOMContentLoaded", () => void boot());



















































































































