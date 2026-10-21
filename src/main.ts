import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

/* ============================================================
   Flutter Launcher — M2：ConPTY 终端
   ============================================================ */

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
}

interface Detected {
  android: SettingsModel["android"];
  harmony: SettingsModel["harmony"];
  flutter: string | null;
  harmonyVersion: string | null;
  npm: SettingsModel["npm"];
  docker: SettingsModel["docker"];
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
  notes: string[];
}

interface State {
  schemaVersion: number;
  settings: SettingsModel;
  projects: Proj[];
  commandTemplates: Cmd[];
}

function defaultSettings(): SettingsModel {
  return {
    flutterTool: { mode: "auto", customPath: null },
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
  mode: string;
  kind: string;
  cwd: string;
  artifacts: string[];
  status: SessionStatus;
  exitCode?: number | null;
  devToolsUrl?: string;
  /** 用于跨数据块匹配锚点的滚动窗口 */
  scan: string;
  /** 恢复自磁盘（进程未运行，禁止写 PTY） */
  restored?: boolean;
  /** run 会话里 flutter 是否正在运行（决定热重载工具条显不显示） */
  flutterRunning?: boolean;
  projectId?: string;
  commandId?: string;
  templateId?: string;
  /** 派生动作来源（平台菜单）：重跑时按平台重新解析设备 */
  platform?: string;
  action?: string;
  target?: string;
  term?: Terminal;
  fit?: FitAddon;
  serialize?: SerializeAddon;
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
};
const flutterInfo = new Map<string, FlutterInfo>();
const collapsed = new Set<string>();
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

  // 普通终端不需要「停止」「重跑」——它就是个 shell，关标签即可
  req<HTMLSpanElement>("#session-tools").hidden = s?.kind === "terminal";

  req<HTMLButtonElement>("#btn-reload").disabled = !running;
  req<HTMLButtonElement>("#btn-restart").disabled = !running;
  req<HTMLButtonElement>("#btn-stop").disabled = !s || s.status === "stopped";
  req<HTMLButtonElement>("#btn-devtools").disabled = !s?.devToolsUrl;
  const rerun = req<HTMLButtonElement>("#btn-rerun");
  // 可重跑的会话：命令 / 模板 / 平台动作。
  // 终端不算——它的"重跑"只是新开一个窗口，容易和"恢复现场"混淆，所以不提供。
  rerun.disabled = !(
    s &&
    (s.restored || s.status === "stopped") &&
    (s.commandId || s.templateId || (s.platform && s.action))
  );
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
        <div class="et-sub">点击上方「添加 Flutter 项目」<br/>选择一个含 <code>pubspec.yaml</code> 的目录<br/>或含 <code>.vscode/launch.json</code> 的工作区</div>
      </div>`;
    return;
  }

  countEl.textContent = `${state.projects.length} 个项目 · ${visibleEntryCount()} 条命令`;
  tree.innerHTML = "";

  for (const p of state.projects) {
    const box = document.createElement("div");
    box.className = "proj";

    const isCollapsed = collapsed.has(p.id);
    const info = flutterInfo.get(p.id);
    const failed = info != null && !info.ok;
    const loading = info == null;

    const head = document.createElement("div");
    head.className = "proj-row" + (failed ? " warn" : "");
    head.title = p.path;

    const chipCls = loading ? "src-auto" : `src-${info.source}`;
    const chipTxt = loading ? "检测中…" : SOURCE_TEXT[info.source];
    const verTxt = loading ? "" : info.ok ? info.version ?? "" : "不可用";

    // 徽章按"里面装了什么"来叫，而不是内部 kind：
    // 只有 npm 命令的项目叫「Npm」，比笼统的「工作区」准确
    const hasNpm = p.commands.some((c) => c.source === "npm");
    const hasDocker = p.commands.some((c) => c.source === "docker");
    const only = (src: string): boolean =>
      p.commands.length > 0 && p.commands.every((c) => c.source === src);
    const kindLabel =
      p.kind === "single"
        ? "应用"
        : only("docker")
          ? "Docker"
          : only("npm")
            ? "Npm"
            : "工作区";
    const kindIcon = p.kind === "single" ? "📁" : hasDocker ? "🐳" : hasNpm ? "📦" : "🗂";

    head.innerHTML = `
      <span class="chev">${isCollapsed ? "▸" : "▾"}</span>
      <span class="pico">${kindIcon}</span>
      <span class="pname">${esc(projectLabel(p))}</span>
      <span class="pmeta">
        <span class="chip kind-${p.kind}">${kindLabel}</span>
        <span class="chip ${chipCls}">${esc(chipTxt)}</span>
        ${info?.fvmVersion ? `<span class="chip chip-fvm" title="FVM 工程（.fvmrc 声明 ${esc(info.fvmVersion)}）">FVM</span>` : ""}
        ${verTxt ? `<span class="fver">${esc(verTxt)}</span>` : ""}
        <button class="proj-x" title="移除项目">×</button>
      </span>
    `;

    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".proj-x")) return;
      if (collapsed.has(p.id)) collapsed.delete(p.id);
      else collapsed.add(p.id);
      renderTree();
    });

    // 右键：全局命令可直接执行，无需先加入项目
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProjectMenu(e, p);
    });

    head.querySelector(".proj-x")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeProject(p);
    });

    box.appendChild(head);

    if (!isCollapsed) {
      const list = document.createElement("div");
      list.className = "cmds";

      // Flutter 项目空命令是正常状态（能力在右键「平台 → 动作」），不提示；
      // 命令集为空说明没导进来，才需要一句引导
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

        row.addEventListener("dblclick", () => {
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
          c.source === "npm" ? "⬢" : c.source === "docker" ? "🐳" : c.kind === "build" ? "📦" : "🚀";
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
        row.addEventListener("dblclick", () => void runCommand(p, c));
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

function mountSession(
  res: StartResponse,
  kind: string,
  mode: string,
  origin?: {
    projectId?: string;
    commandId?: string;
    templateId?: string;
    platform?: string;
    action?: string;
    target?: string;
  },
): void {
  const session: TermSession = {
    id: res.id,
    title: res.title,
    device: res.device,
    mode,
    kind,
    cwd: res.cwd,
    artifacts: [],
    // 只有 `flutter run` 有明确的"就绪"标志（输出 Flutter run key commands.）。
    // 其他类型（build / custom / terminal）没有这个标志，若从 starting 起步
    // 就会永远黄点闪烁——终端尤其明显（shell 根本不退出）。
    status: kind === "run" ? "starting" : "running",
    scan: "",
    projectId: origin?.projectId,
    commandId: origin?.commandId,
    templateId: origin?.templateId,
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
}

async function runCommand(p: Proj, c: Cmd, deviceId?: string): Promise<void> {
  selectCommand(c.id);

  // 普通命令（docker up/stop、npm test…）跑完就退出，没必要占一个标签：
  // 投递到项目的常驻终端里，跑完 shell 还在，可以接着敲
  if (c.kind === "custom") {
    await runInTerminal(p, c);
    return;
  }

  try {
    const res = await invoke<StartResponse>("start_session", {
      projectId: p.id,
      commandId: c.id,
      deviceId: deviceId ?? null,
      rows: 30,
      cols: 100,
    });
    mountSession(res, c.kind, c.flutterMode ?? "debug", {
      projectId: p.id,
      commandId: c.id,
    });
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目当前活着的终端（kind=terminal 且未结束） */
function projectShell(p: Proj): TermSession | undefined {
  return sessions.find(
    (s) => s.kind === "terminal" && s.projectId === p.id && s.status !== "stopped",
  );
}

/** 把一条命令打进项目的常驻终端：有就复用，没有就新开一个 shell */
async function runInTerminal(p: Proj, c: Cmd): Promise<void> {
  const existing = projectShell(p);
  try {
    const res = await invoke<StartResponse>("run_in_terminal", {
      projectId: p.id,
      commandId: c.id,
      reuseSessionId: existing?.id ?? null,
      rows: 30,
      cols: 100,
    });

    if (res.reused && existing) {
      activateSession(existing.id);
      return;
    }

    mountSession(res, "terminal", "debug", { projectId: p.id });
  } catch (e) {
    toast(String(e), "error");
  }
}

/// 全局模板：不写入项目命令列表，直接起一个会话
async function runTemplate(p: Proj, t: Cmd, deviceId?: string): Promise<void> {
  try {
    const res = await invoke<StartResponse>("start_template_session", {
      projectId: p.id,
      templateId: t.id,
      deviceId: deviceId ?? null,
      rows: 30,
      cols: 100,
    });
    mountSession(res, t.kind, t.flutterMode ?? "debug", {
      projectId: p.id,
      templateId: t.id,
    });
  } catch (e) {
    toast(String(e), "error");
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

  // 终端是 shell，没有 flutter run 的 `q` 退出键。发 q 只会往命令行里打一个字母，
  // 5 秒后再被强制关闭——看起来就像"输了 q 然后崩了"。直接结束进程即可。
  if (s.kind === "terminal") {
    await closeSession(s.id);
    return;
  }

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

/* ---------------- PTY 事件 ---------------- */

/** 在项目目录开一个交互终端（继承项目环境）。 */
async function openProjectTerminal(p: Proj): Promise<void> {
  try {
    const res = await invoke<StartResponse>("open_terminal", {
      projectId: p.id,
      rows: 30,
      cols: 100,
    });
    mountSession(res, "terminal", "terminal", { projectId: p.id });
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
  const btn = req<HTMLButtonElement>("#btn-doctor");
  const rep = doctorReport;

  if (doctorBusy) {
    btn.className = "btn doc-btn checking";
    btn.textContent = "⏳ 体检";
    btn.title = "正在运行 flutter doctor…";
    return;
  }

  // 没跑过：不自动触发（flutter doctor 要 20+ 秒），等用户点
  if (!rep) {
    btn.className = "btn doc-btn";
    btn.textContent = "体检";
    btn.title = "点击运行 flutter doctor（约 20 秒，结果会缓存）";
    return;
  }

  if (rep.error) {
    btn.className = "btn doc-btn error";
    btn.textContent = "✗ 体检";
    btn.title = `体检未能完成：${rep.error}\n点击查看详情`;
    return;
  }

  const bad = doctorIssues();
  if (bad.length === 0) {
    btn.className = "btn doc-btn ok";
    btn.textContent = "✓ 体检";
    btn.title = `${rep.checks.length} 项检查全部正常\n点击查看详情`;
  } else {
    btn.className = "btn doc-btn warn";
    btn.textContent = `! 体检 ${bad.length}`;
    btn.title = `${bad.map((c) => c.name).join("、")}\n点击查看详情`;
  }
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
    l.platform
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
    const inferredKind = log.platform ? "run" : (referenced?.kind ?? "run");

    const s: TermSession = {
      id: log.id,
      title: log.title,
      device: log.device || "—",
      mode: log.mode || "debug",
      kind: log.kind || inferredKind,
      cwd: log.cwd || "",
      artifacts: log.artifacts ?? [],
      status: "stopped",
      exitCode: log.exitCode ?? null,
      scan: "",
      projectId: log.projectId ?? undefined,
      commandId: log.commandId ?? undefined,
      templateId: log.templateId ?? undefined,
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
  const project = state.projects.find((p) => p.id === s.projectId);
  if (!project) {
    toast("原项目已不存在，无法重跑", "error");
    return;
  }

  if (s.commandId) {
    const cmd = project.commands.find((c) => c.id === s.commandId);
    if (cmd) {
      // run 会话：新开一个终端并预填命令（按 Enter 才执行），
      // 然后用它**替换**掉旧标签——flutter run 的会话没有"恢复现场"这回事，
      // 留一堆死标签只会让人分不清哪个是活的。
      // 用命令本身的类型判定，而不是会话记录里的 kind——
      // 老会话记录可能没有 kind 字段，会导致 run 走错分支（不替换标签）
      if (cmd.kind === "run") {
        const oldId = s.id;
        try {
          const res = await invoke<StartResponse>("prefill_run", {
            projectId: project.id,
            commandId: cmd.id,
            rows: 30,
            cols: 100,
          });
          // 先挂新的（保证失败时旧标签还在），再关旧的
          mountSession(res, "run", "debug", {
            projectId: project.id,
            commandId: cmd.id,
          });
          await closeSession(oldId);
        } catch (e) {
          toast(String(e), "error");
        }
        return;
      }
      await runCommand(project, cmd);
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

  const draft = {
    name: existing?.name ?? "",
    kind: existing?.kind ?? "run",
    program: existing?.program ?? "",
    cwd: existing?.cwd ?? "",
    mode: existing?.flutterMode ?? "debug",
    target: existing?.buildType ?? "apk",
    flavor,
    args: restArgs.join(" "),
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
      for (const k of ["run", "build", "custom"]) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent =
          k === "run"
            ? "run（flutter 调试运行）"
            : k === "build"
              ? "build（flutter 发布构建）"
              : "custom（自定义命令）";
        if (draft.kind === k) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = Boolean(existing);
      sel.addEventListener("change", () => {
        draft.kind = sel.value;
        void build();
      });
      cell.appendChild(sel);
    }

    if (draft.kind === "custom") {
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
    } else if (draft.kind === "run") {
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

    {
      const [, cell] = row("额外参数");
      input(
        cell,
        draft.args,
        draft.kind === "custom" ? "原样传给程序" : "--dart-define=ENV=prod",
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

    if (draft.kind === "build") {
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

      const args = splitArgs(draft.args);
      if (draft.kind === "build" && draft.flavor.trim()) {
        args.unshift("--flavor", draft.flavor.trim());
      }

      const cmd: Cmd = {
        id: existing?.id ?? "",
        name: draft.name.trim(),
        kind: draft.kind,
        program:
          draft.kind === "custom" || draft.kind === "run"
            ? draft.program.trim() || null
            : null,
        cwd:
          draft.kind === "custom" || draft.kind === "run"
            ? draft.cwd.trim() || null
            : null,
        flutterMode: draft.kind === "run" ? draft.mode : null,
        args,
        env: Object.fromEntries(
          draft.envPairs
            .filter(([k]) => k.trim() !== "")
            .map(([k, v]) => [k.trim(), v]),
        ),
        toolArgs: existing?.toolArgs ?? [],
        deviceId: existing?.deviceId ?? null,
        emulatorId: existing?.emulatorId ?? null,
        buildType: draft.kind === "build" ? draft.target : null,
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
    };

/** 二级子菜单（本项目最多两层：右键菜单 → 平台 → 动作） */
let subMenuEl: HTMLDivElement | null = null;

function closeSubMenu(): void {
  subMenuEl?.remove();
  subMenuEl = null;
}

function closeAllMenus(): void {
  closeSubMenu();
  projMenuEl?.remove();
  projMenuEl = null;
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
    } else {
      el.addEventListener("click", () => {
        closeAllMenus();
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
  closeAllMenus();

  // 命令集（无 pubspec 的 workspace）本身就是命令列表：不显示平台，也不显示全局命令
  const isCommandSet = p.kind !== "single";

  // 生态判定：看它有哪些来源的命令（一个目录可能同时有 npm 和 docker）
  const dockerCmds = p.commands.filter((c) => c.source === "docker");
  const npmCmds = p.commands.filter((c) => c.source === "npm");
  const launchCmds = p.commands.filter((c) => c.source === "launch-json");
  const ecoTag = dockerCmds.length ? "Docker" : npmCmds.length ? "Npm" : "命令集";

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
  if (!isCommandSet) {
    const platformBox = document.createElement("div");
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
      onClick: () => {
        void (async () => {
          try {
            await invoke("platform_matrix", { projectId: p.id, force: true });
            toast("平台信息已刷新");
            openProjectMenu(ev, p);
          } catch (e) {
            toast(String(e), "error");
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

  if (!isCommandSet) {
    tail.push({
      kind: "item",
      name: "环境变量…",
      detail: "鸿蒙工程的全局 / 项目级变量与 PATH shim",
      onClick: () => void openEnvDialog(p),
    });
  }

  // 按项目"有什么文件"决定重读哪一份（以前一律显示 launch.json，对 docker/npm 项目是错的）
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
        detail: usable === total ? `${total} 个动作` : `${usable}/${total} 可用`,
        children: pf.actions.map((a) => ({
          kind: "item" as const,
          name: a.command,
          detail: a.enabled ? a.label : `${a.label} · ${a.reason ?? "不可用"}`,
          disabled: !a.enabled,
          onClick: () => void runPlatformAction(p, pf.id, a),
        })),
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
  /** 「重跑」时传旧会话 id：新会话挂上后再关旧的（替换而不是追加） */
  replaceId?: string,
): Promise<void> {
  try {
    const res = await invoke<StartResponse>("start_platform_action", {
      projectId: p.id,
      platform,
      action: a.action,
      target: a.target ?? null,
      rows: 30,
      cols: 100,
    });
    mountSession(
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
    if (replaceId) await closeSession(replaceId);
  } catch (e) {
    toast(String(e), "error");
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

/** 真正去查一次。force=false 时后端会用磁盘缓存，跨重启也秒回。 */
async function loadEmulators(force: boolean): Promise<void> {
  const menu = emuMenuEl;
  if (!menu) return;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;
  const refresh = menu.querySelector<HTMLButtonElement>(".dm-refresh");
  body.innerHTML = `<div class="dm-loading">正在检查电脑上的模拟器…</div>`;
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

/** 工具栏的「导入」下拉：项目 / launch.json 可用，package.json 与 docker-compose 先占位 */
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
      <span>可启动的模拟器</span>
      <button class="dm-refresh" title="重新检查电脑上的模拟器（结果会缓存）">⟳</button>
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

  // 有内存缓存直接渲染；否则读磁盘缓存（后端），不再重新分析
  if (emulatorCache) renderEmulatorBody(emulatorCache, null);
  else void loadEmulators(false);
}


/* ---------------- 设置页 ---------------- */

function openSettings(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="modal-head">
        <span>设置</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="set-tabs" id="settings-tabs"></div>
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
  const tabsEl = overlay.querySelector("#settings-tabs") as HTMLDivElement;

  // 分页：currentTab 记录当前选中的页签
  const SETTINGS_TABS: Array<[string, string]> = [
    ["general", "通用"],
    ["flutter", "Flutter"],
    ["android", "Android"],
    ["harmony", "鸿蒙"],
    ["npm", "Npm"],
    ["docker", "Docker"],
  ];
  let currentTab = "general";

  const applyTab = (): void => {
    for (const el of Array.from(body.querySelectorAll<HTMLElement>(".set-section"))) {
      el.hidden = el.dataset.tab !== currentTab;
    }
    for (const b of Array.from(tabsEl.querySelectorAll<HTMLButtonElement>(".set-tab"))) {
      b.classList.toggle("active", b.dataset.tab === currentTab);
    }
  };

  const renderSettingsTabs = (): void => {
    tabsEl.innerHTML = "";
    for (const [id, label] of SETTINGS_TABS) {
      const b = document.createElement("button");
      b.className = "set-tab";
      b.dataset.tab = id;
      b.textContent = label;
      b.addEventListener("click", () => {
        currentTab = id;
        applyTab();
      });
      tabsEl.appendChild(b);
    }
    applyTab();
  };

  const hint = overlay.querySelector("#settings-hint") as HTMLSpanElement;
  const draft: SettingsModel = JSON.parse(
    JSON.stringify(state.settings ?? defaultSettings()),
  ) as SettingsModel;

  const close = (): void => overlay.remove();

  // 版本信息：原来在工具栏上，移到设置页底部（固定可见，不用滚到底）
  (
    overlay.querySelector("#settings-version") as HTMLSpanElement
  ).textContent = `Flutter Launcher · state schema v${state.schemaVersion}`;

  const section = (title: string, desc: string): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "set-section";
    // 分区归属按标题判定，比在 build() 里逐处标记更不容易漏
    const TAB_OF: Record<string, string> = {
      Flutter: "flutter",
      Android: "android",
      HarmonyOS: "harmony",
      Npm: "npm",
      Docker: "docker",
    };
    s.dataset.tab = TAB_OF[title] ?? "general";
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

  const field = (
    parent: HTMLElement,
    label: string,
    value: string | null,
    onChange: (v: string | null) => void,
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

    row.append(lab, input, browse);
    parent.appendChild(row);
  };

  const build = (): void => {
    body.innerHTML = "";

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
      field(s, "终端程序", draft.terminal?.path ?? "", (v) => {
        const t = (v ?? "").trim();
        draft.terminal = { path: t === "" ? null : t };
      });

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
  renderSettingsTabs();
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
  renderSettingsTabs();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(detectBtn, browseBtn);
      s.appendChild(bar);
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
  };

  build();
  renderSettingsTabs();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#set-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#set-detect") as HTMLButtonElement).addEventListener("click", () => {
    hint.textContent = "检测中…";
    void (async () => {
      try {
        const d = await invoke<Detected>("detect_toolchains");
        draft.android = { ...draft.android, ...d.android };
        draft.harmony = { ...draft.harmony, ...d.harmony };
        // 只在检测到值时覆盖，避免把用户手填的清空
        if (d.npm?.nodePath) draft.npm = { ...draft.npm, nodePath: d.npm.nodePath };
        if (d.docker?.dockerPath)
          draft.docker = { ...draft.docker, dockerPath: d.docker.dockerPath };
        if (d.docker?.composeStyle)
          draft.docker = { ...draft.docker, composeStyle: d.docker.composeStyle };
        if (d.flutter) {
          draft.flutterTool.mode = "custom";
          draft.flutterTool.customPath = d.flutter;
        }
        build();
  renderSettingsTabs();
        const parts = [...d.notes];
        if (d.harmonyVersion) parts.unshift(d.harmonyVersion);
        const msg = parts.length ? parts.join("；") : "已填入检测结果，确认后保存";
        hint.textContent = msg;
        hint.title = msg;
      } catch (e) {
        hint.textContent = String(e);
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
        <div class="brand">
          <span class="logo">◆</span>
        </div>
        <div class="tb-menu">
          <button class="btn menu-btn" id="btn-import-menu">导入 ▾</button>
        </div>
        <div class="tb-center"></div>
        <div class="tb-right">
          <button class="btn" id="btn-filing" title="安卓备案信息：选择 APK 查看包名 / MD5 / 公钥">📋 备案</button>
          <button class="btn doc-btn checking" id="btn-doctor" title="flutter doctor 体检">⏳ 体检</button>
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
            </span>
            <span class="flex1"></span>
            <span class="artifact-bar" id="artifact-bar"></span>
            <span class="ctx-info" id="ctx-info">等待会话</span>
          </div>
          <div class="term-holder" id="term-holder">
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
    closeAllMenus();
  });
  window.addEventListener("blur", closeDeviceMenu);

  req<HTMLButtonElement>("#btn-import-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    openImportMenu(e.currentTarget as HTMLElement);
  });
  req<HTMLButtonElement>("#btn-settings").addEventListener("click", () => openSettings());
  req<HTMLButtonElement>("#btn-rerun").addEventListener("click", () => {
    const s = activeSession();
    if (s) void rerunSession(s);
  });
  req<HTMLButtonElement>("#btn-filing").addEventListener("click", () => void pickApkAndInspect());

  req<HTMLButtonElement>("#btn-doctor").addEventListener("click", () => {
    if (doctorBusy) {
      toast("体检进行中…");
      return;
    }
    if (doctorReport) openDoctorReport();
    else void refreshDoctor(true);
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

  try {
    const [s, loc] = await Promise.all([
      invoke<State>("load_state"),
      invoke<string>("state_location"),
    ]);
    state = s;
    statePath = loc;
  } catch (e) {
    toast(`载入状态失败：${String(e)}`, "error");
  }

  render();
  for (const p of state.projects) void refreshFlutter(p.id);

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
      // FLA_SETTINGS=npm 之类：打开后自动切到指定分页，便于截图核对
      if (settingsHook !== "1") {
        window.setTimeout(() => {
          document
            .querySelector<HTMLButtonElement>(`.set-tab[data-tab="${settingsHook}"]`)
            ?.click();
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

    const projMenu = await invoke<string | null>("dev_env", { name: "FLA_PROJ_MENU" });
    if (projMenu) {
      const proj = state.projects.find((x) => x.id === projMenu) ?? state.projects[0];
      if (proj) {
        openProjectMenu(new MouseEvent("contextmenu", { clientX: 1500, clientY: 640 }), proj);
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































































































