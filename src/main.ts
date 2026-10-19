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

type FlutterSource = "fvm" | "custom" | "path" | "none";
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
}

interface Proj {
  id: string;
  name: string;
  path: string;
  kind: string;
  commands: Cmd[];
}

interface SettingsModel {
  flutterTool: { mode: string; customPath: string | null };
  android: { sdkPath: string | null; emulatorPath: string | null; avdPath: string | null };
  harmony: {
    emulatorPath: string | null;
    instancePath: string | null;
    imageRoot: string | null;
    flutterPath: string | null;
    sdkPath: string | null;
  };
}

interface Detected {
  android: SettingsModel["android"];
  harmony: SettingsModel["harmony"];
  flutter: string | null;
  harmonyVersion: string | null;
  notes: string[];
}

interface EmulatorEntry {
  id: string;
  name: string;
  detail: string;
  kind: string;
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
    android: { sdkPath: null, emulatorPath: null, avdPath: null },
    harmony: {
      emulatorPath: null,
      instancePath: null,
      imageRoot: null,
      flutterPath: null,
      sdkPath: null,
    },
  };
}

interface FlutterInfo {
  ok: boolean;
  version: string | null;
  channel: string | null;
  dart: string | null;
  executable: string | null;
  source: FlutterSource;
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
  projectId?: string;
  commandId?: string;
  templateId?: string;
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
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );
}

function toast(msg: string, kind: "info" | "error" = "info"): void {
  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " error" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  window.setTimeout(() => {
    t.classList.remove("show");
    window.setTimeout(() => t.remove(), 220);
  }, kind === "error" ? 3600 : 2400);
}

const SOURCE_TEXT: Record<FlutterSource, string> = {
  fvm: "FVM",
  custom: "自定义",
  path: "PATH",
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
      toast("该会话已结束，点「⟳ 重跑」重新运行");
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
  const isRun = s?.status === "running" && s.mode === "debug";
  req<HTMLButtonElement>("#btn-reload").disabled = !isRun;
  req<HTMLButtonElement>("#btn-restart").disabled = !isRun;
  req<HTMLButtonElement>("#btn-stop").disabled = !s || s.status === "stopped";
  req<HTMLButtonElement>("#btn-devtools").disabled = !s?.devToolsUrl;
  req<HTMLButtonElement>("#btn-rerun").disabled = !(
    s &&
    (s.restored || s.status === "stopped") &&
    (s.commandId || s.templateId)
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
    el.innerHTML = `
      <span class="dot ${s.status === "running" ? "run" : s.status === "starting" ? "start" : "stop"}"></span>
      <span class="tab-title">${esc(s.title)}</span>
      <span class="tab-dev">${esc(s.device)}</span>
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

  const totalCmds = state.projects.reduce((n, p) => n + p.commands.length, 0);
  countEl.textContent = `${state.projects.length} 个项目 · ${totalCmds} 条命令`;
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

    head.innerHTML = `
      <span class="chev">${isCollapsed ? "▸" : "▾"}</span>
      <span class="pico">${p.kind === "workspace" ? "🗂" : "📁"}</span>
      <span class="pname">${esc(p.name)}</span>
      <span class="pmeta">
        <span class="chip kind-${p.kind}">${p.kind === "workspace" ? "工作区" : "应用"}</span>
        <span class="chip ${chipCls}">${esc(chipTxt)}</span>
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

      if (p.commands.length === 0) {
        const hint = document.createElement("div");
        hint.className = "cmd hint";
        hint.textContent =
          p.kind === "workspace"
            ? "尚未导入命令 —— 点击上方「导入 launch.json」"
            : "暂无命令 —— M6 支持手动添加";
        list.appendChild(hint);
      }

      for (const c of p.commands) {
        const row = document.createElement("div");
        row.className = "cmd" + (selectedCommand === c.id ? " selected" : "");
        const mode = c.flutterMode ?? "debug";
        row.innerHTML = `
          <span class="cico">${c.kind === "build" ? "📦" : "🚀"}</span>
          <span class="cname">${esc(c.name)}</span>
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
        row.addEventListener("contextmenu", (e) => openDeviceMenu(e, p, c));
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

/* ---------------- 渲染：状态栏 ---------------- */

function renderStatus(): void {
  const cmds = state.projects.reduce((n, p) => n + p.commands.length, 0);
  const el = req<HTMLSpanElement>("#sb-state");
  el.textContent = `${state.projects.length} 个项目 · ${cmds} 条命令`;
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
  origin?: { projectId?: string; commandId?: string; templateId?: string },
): void {
  const session: TermSession = {
    id: res.id,
    title: res.title,
    device: res.device,
    mode,
    kind,
    cwd: res.cwd,
    artifacts: [],
    status: "starting",
    scan: "",
    projectId: origin?.projectId,
    commandId: origin?.commandId,
    templateId: origin?.templateId,
  };
  sessions.push(session);
  activateSession(session.id);
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

function targetProjectId(): string | null {
  return state.projects.length === 1 ? state.projects[0].id : null;
}

/* ---------------- PTY 事件 ---------------- */

/* ---------------- 体检横幅（§14 / §6.6） ---------------- */

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
let doctorTimer: number | null = null;

const DOCTOR_ICON: Record<string, string> = {
  ok: "√",
  warn: "!",
  error: "✗",
};

function doctorIssues(): DoctorCheck[] {
  return (doctorReport?.checks ?? []).filter((c) => c.status !== "ok");
}

async function refreshDoctor(force = false): Promise<void> {
  const bar = req<HTMLDivElement>("#health-bar");
  bar.hidden = false;
  bar.className = "health-bar checking";
  bar.innerHTML = `<span class="hb-icon">⏳</span><span class="hb-text">正在运行 flutter doctor…</span>`;

  if (doctorTimer !== null) window.clearTimeout(doctorTimer);

  try {
    const rep = await invoke<DoctorReport>("flutter_doctor", {
      projectId: state.projects[0]?.id ?? null,
      force,
    });
    doctorReport = rep;
    renderHealthBar();
  } catch (e) {
    doctorReport = null;
    bar.className = "health-bar error";
    bar.innerHTML = `<span class="hb-icon">✗</span><span class="hb-text">体检未执行：${esc(String(e))}</span>`;
  }
}

function renderHealthBar(): void {
  const bar = req<HTMLDivElement>("#health-bar");
  const rep = doctorReport;

  if (!rep) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  bar.innerHTML = "";

  const icon = document.createElement("span");
  icon.className = "hb-icon";
  const text = document.createElement("span");
  text.className = "hb-text";

  const actions = document.createElement("span");
  actions.className = "hb-actions";

  const btn = (label: string, fn: () => void, cls = ""): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = `hb-btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener("click", fn);
    actions.appendChild(b);
    return b;
  };

  if (rep.error) {
    // §6.6：失败时把原始报错原样呈现，而不是"未知错误"
    bar.className = "health-bar error";
    icon.textContent = "✗";
    text.textContent = `体检未能完成：${rep.error}`;
    btn("详情", () => openDoctorReport());
    btn("重新体检", () => void refreshDoctor(true));
    btn("关闭", () => {
      bar.hidden = true;
    });
  } else {
    const bad = doctorIssues();

    if (bad.length === 0) {
      bar.className = "health-bar ok";
      icon.textContent = "√";
      text.textContent = `体检通过 · ${rep.checks.length} 项检查全部正常`;
      btn("查看", () => openDoctorReport());
      btn("关闭", () => {
        bar.hidden = true;
      });
      // 通过时自动收起，不长期占位
      doctorTimer = window.setTimeout(() => {
        if (doctorReport === rep) bar.hidden = true;
      }, 6000);
    } else {
      bar.className = "health-bar warn";
      icon.textContent = "!";
      text.textContent = `体检发现 ${bad.length} 项问题：${bad.map((c) => c.name).join("、")}`;
      btn("详情", () => openDoctorReport());
      btn("重新体检", () => void refreshDoctor(true));
      btn("关闭", () => {
        bar.hidden = true;
      });
    }
  }

  bar.append(icon, text, actions);
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
    device: s.device,
    mode: s.mode,
    kind: s.kind,
    cwd: s.cwd,
    exitCode: s.exitCode ?? null,
    status: s.restored ? "stopped" : s.status,
    artifacts: s.artifacts,
    ansi: s.serialize?.serialize() ?? "",
    savedAt: Date.now(),
  }));

  try {
    await invoke("save_session_logs", { logs });
  } catch {
    /* 落盘失败不打断使用 */
  }
}

async function restoreSessions(): Promise<void> {
  let logs: SessionLog[] = [];
  try {
    logs = await invoke<SessionLog[]>("load_session_logs");
  } catch {
    return;
  }
  if (logs.length === 0) return;

  for (const log of logs) {
    const s: TermSession = {
      id: log.id,
      title: log.title,
      device: log.device || "—",
      mode: log.mode || "debug",
      kind: log.kind || "run",
      cwd: log.cwd || "",
      artifacts: log.artifacts ?? [],
      status: "stopped",
      exitCode: log.exitCode ?? null,
      scan: "",
      projectId: log.projectId ?? undefined,
      commandId: log.commandId ?? undefined,
      templateId: log.templateId ?? undefined,
      restored: true,
    };
    sessions.push(s);
    ensureTerm(s);
    if (log.ansi) s.term!.write(log.ansi);
    s.term!.write("\r\n\x1b[90m──── 历史输出已恢复（进程未运行，点下方「⟳ 重跑」重新执行）────\x1b[0m\r\n");
  }

  renderTabs();
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
    let payload: DevicesPayload | null = null;
    let error: string | null = null;
    try {
      payload = await invoke<DevicesPayload>("list_devices", { projectId: p.id });
    } catch (e) {
      error = String(e);
    }
    if (deviceMenuEl !== menu) return; // 期间已被关闭
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
      const [, c2] = row("cwd");
      input(c2, draft.cwd, "可空（相对项目根）", (v) => {
        draft.cwd = v;
      });
      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent =
        "%FLUTTER% 会替换为该项目的 flutter 可执行文件；.bat / .cmd 会自动用 cmd 包装。";
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
      };

      try {
        state = isTemplate
          ? await invoke<State>("upsert_template", { template: cmd })
          : await invoke<State>("upsert_command", { projectId: p!.id, command: cmd });
        close();
        render();
        toast(existing ? "已更新" : isTemplate ? "模板已保存" : "命令已添加");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 项目右键：全局命令 ---------------- */

let projMenuEl: HTMLDivElement | null = null;

function closeProjMenu(): void {
  projMenuEl?.remove();
  projMenuEl = null;
}

function openProjectMenu(ev: MouseEvent, p: Proj): void {
  closeProjMenu();

  const globals = state.commandTemplates.filter((t) => t.scope === "global");
  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 340)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 320)}px`;
  menu.innerHTML = `<div class="dm-head">${esc(p.name)}</div><div class="dm-body"></div>`;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  const addGroup = (text: string): void => {
    const g = document.createElement("div");
    g.className = "dm-group";
    g.textContent = text;
    body.appendChild(g);
  };

  const addItem = (name: string, detail: string, onClick: () => void): void => {
    const el = document.createElement("div");
    el.className = "dm-item";
    el.innerHTML = `<span class="dm-name">${esc(name)}</span>${detail ? `<span class="dm-sub">${esc(detail)}</span>` : ""}`;
    el.addEventListener("click", () => {
      closeProjMenu();
      onClick();
    });
    body.appendChild(el);
  };

  addGroup(`全局命令 (${globals.length})`);
  if (globals.length === 0) {
    addItem("（暂无全局模板）", "设置 → 命令模板 → 作用域选「全局」", () => {});
  }
  for (const t of globals) {
    const detail = [t.kind, t.buildType, t.args.join(" ")].filter(Boolean).join(" · ");
    addItem(t.name, detail, () => void runTemplate(p, t));
  }

  addGroup("项目");
  addItem("从模板导入…", "把模板加入本项目", () => openTemplateImport(p));
  addItem("添加命令…", "新建 run / build / custom 命令", () => void openCommandDialog(p));
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
        <button class="btn" id="tpl-reset">恢复默认</button>
        <button class="btn" id="tpl-new">＋ 新建模板</button>
        <button class="btn primary" id="tpl-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const body = overlay.querySelector("#tpl-body") as HTMLDivElement;
  const close = (): void => overlay.remove();

  const renderList = (): void => {
    body.innerHTML = "";
    if (state.commandTemplates.length === 0) {
      const e = document.createElement("div");
      e.className = "set-desc";
      e.textContent = "模板库为空。可「新建模板」，或点「恢复默认」载入内置模板。";
      body.appendChild(e);
      return;
    }

    for (const t of state.commandTemplates) {
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
      del.className = "btn";
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

      row.append(main, edit, del);
      body.appendChild(row);
    }
  };

  renderList();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#tpl-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#tpl-new") as HTMLButtonElement).addEventListener("click", () => {
    void openCommandDialog(null);
  });

  (overlay.querySelector("#tpl-reset") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        state = await invoke<State>("reset_templates");
        renderList();
        render();
        toast("已恢复默认模板");
      } catch (e) {
        toast(String(e), "error");
      }
    })();
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

  renderList();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#imp-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#imp-all") as HTMLButtonElement).addEventListener("click", () => {
    for (const t of state.commandTemplates) selected.add(t.id);
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

/** 真正去查一次（首次打开或点刷新时） */
async function loadEmulators(): Promise<void> {
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
    });
  } catch (e) {
    error = String(e);
  }

  if (emuMenuEl !== menu) return;
  if (refresh) refresh.disabled = false;

  if (data) emulatorCache = data;
  renderEmulatorBody(data ?? { android: [], harmony: [], notes: [] }, error);
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

  menu.querySelector(".dm-refresh")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void loadEmulators();
  });

  // 有缓存就直接渲染，不再查询
  if (emulatorCache) renderEmulatorBody(emulatorCache, null);
  else void loadEmulators();
}


/* ---------------- 设置页 ---------------- */

function openSettings(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <span>设置 · 工具链与模拟器目录</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="settings-body"></div>
      <div class="modal-foot">
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
  const hint = overlay.querySelector("#settings-hint") as HTMLSpanElement;
  const draft: SettingsModel = JSON.parse(
    JSON.stringify(state.settings ?? defaultSettings()),
  ) as SettingsModel;

  const close = (): void => overlay.remove();

  const section = (title: string, desc: string): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "set-section";
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
        close();
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
    }
  };

  build();

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
        if (d.flutter) {
          draft.flutterTool.mode = "custom";
          draft.flutterTool.customPath = d.flutter;
        }
        build();
        const parts = [...d.notes];
        if (d.harmonyVersion) parts.unshift(d.harmonyVersion);
        hint.textContent = parts.length ? parts.join("；") : "已填入检测结果，确认后保存";
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
          <span class="title">Flutter Launcher</span>
          <span class="badge-m0">设置 · 模拟器</span>
        </div>
        <div class="tb-center">
          <button class="btn primary" id="btn-add">＋ 添加 Flutter 项目</button>
          <button class="btn" id="btn-import">📂 导入 launch.json</button>
        </div>
        <div class="tb-right">
          <button class="btn" id="btn-emulators" title="可启动的模拟器">📱 模拟器</button>
          <span class="tb-meta" id="tb-meta">—</span>
          <button class="btn icon" id="btn-settings" title="设置">⚙</button>
        </div>
      </header>

      <div class="health-bar" id="health-bar" hidden></div>

      <div class="tabstrip" id="tabstrip"></div>

      <div class="main">
        <section class="left">
          <div class="term-controls">
            <button class="cbtn" id="btn-reload" disabled><i class="hi">⚡</i>热重载</button>
            <button class="cbtn" id="btn-restart" disabled><i class="hi">🔄</i>热重启</button>
            <button class="cbtn danger" id="btn-stop" disabled><i class="hi">⏹</i>停止</button>
            <button class="cbtn" id="btn-devtools" disabled><i class="hi">🌐</i>DevTools</button>
            <button class="cbtn" id="btn-rerun" disabled><i class="hi">⟳</i>重跑</button>
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
  });
  await listen<{ id: string; code: number | null }>("pty://exit", (e) => {
    handleExit(e.payload.id, e.payload.code);
  });

  // 设备菜单：点击外部 / Esc 关闭
  document.addEventListener("mousedown", (e) => {
    if (deviceMenuEl && !deviceMenuEl.contains(e.target as Node)) closeDeviceMenu();
    if (emuMenuEl && !emuMenuEl.contains(e.target as Node)) closeEmuMenu();
    if (projMenuEl && !projMenuEl.contains(e.target as Node)) closeProjMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeDeviceMenu();
    closeEmuMenu();
    closeProjMenu();
  });
  window.addEventListener("blur", closeDeviceMenu);

  req<HTMLButtonElement>("#btn-add").addEventListener("click", () => void addProject());
  req<HTMLButtonElement>("#btn-import").addEventListener("click", () => {
    const id = targetProjectId();
    if (!id) {
      toast(state.projects.length === 0 ? "请先添加项目" : "请先在项目树中选中一个项目", "error");
      return;
    }
    void importLaunch(id);
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
  req<HTMLSpanElement>("#tb-meta").textContent = `schema v${state.schemaVersion}`;
  for (const p of state.projects) void refreshFlutter(p.id);

  // D-10：恢复上次的 tab 壳与历史输出（进程不拉起）
  await restoreSessions();

  // §14 体检：后台跑，不阻塞界面
  void refreshDoctor().then(async () => {
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
        openDeviceMenu(ev, proj, cmd);
      }
    }

    // 开发期：自动打开设置页 / 模拟器菜单
    if (await invoke<string | null>("dev_env", { name: "FLA_SETTINGS" })) {
      openSettings();
    }
    if (await invoke<string | null>("dev_env", { name: "FLA_EMU_MENU" })) {
      const anchor = document.querySelector<HTMLButtonElement>("#btn-emulators");
      if (anchor) openEmulatorMenu(anchor);
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
  } catch {
    /* 无钩子 */
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
