import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
}

interface Proj {
  id: string;
  name: string;
  path: string;
  kind: string;
  commands: Cmd[];
}

interface State {
  schemaVersion: number;
  settings: unknown;
  projects: Proj[];
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
  status: SessionStatus;
  exitCode?: number | null;
  devToolsUrl?: string;
  /** 用于跨数据块匹配锚点的滚动窗口 */
  scan: string;
  term?: Terminal;
  fit?: FitAddon;
  pane?: HTMLDivElement;
}

let state: State = { schemaVersion: 2, settings: {}, projects: [] };
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

  // 键盘 → PTY
  term.onData((data) => {
    void invoke("write_session", { id: s.id, data }).catch(() => {});
  });
  term.onResize(({ rows, cols }) => {
    void invoke("resize_session", { id: s.id, rows, cols }).catch(() => {});
  });

  s.term = term;
  s.fit = fit;
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
  const info = req<HTMLSpanElement>("#ctx-info");
  info.textContent = s ? `${s.title}  ·  ${s.device}  ·  ${STATUS_TEXT[s.status]}` : "等待会话";
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
    el.className = "tab" + (s.id === activeSessionId ? " active" : "");
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

    const session: TermSession = {
      id: res.id,
      title: res.title,
      device: res.device,
      mode: c.flutterMode ?? "debug",
      kind: c.kind,
      status: "starting",
      scan: "",
    };
    sessions.push(session);
    activateSession(session.id);
    requestAnimationFrame(() => {
      session.fit?.fit();
      session.term?.focus();
      const rows = session.term?.rows ?? 30;
      const cols = session.term?.cols ?? 100;
      void invoke("resize_session", { id: session.id, rows, cols }).catch(() => {});
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
  })();
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
          <span class="badge-m0">M3 · 设备</span>
        </div>
        <div class="tb-center">
          <button class="btn primary" id="btn-add">＋ 添加 Flutter 项目</button>
          <button class="btn" id="btn-import">📂 导入 launch.json</button>
        </div>
        <div class="tb-right">
          <span class="tb-meta" id="tb-meta">—</span>
          <button class="btn icon" id="btn-settings" title="设置">⚙</button>
        </div>
      </header>

      <div class="tabstrip" id="tabstrip"></div>

      <div class="main">
        <section class="left">
          <div class="term-controls">
            <button class="cbtn" id="btn-reload" disabled><i class="hi">⚡</i>热重载</button>
            <button class="cbtn" id="btn-restart" disabled><i class="hi">🔄</i>热重启</button>
            <button class="cbtn danger" id="btn-stop" disabled><i class="hi">⏹</i>停止</button>
            <button class="cbtn" id="btn-devtools" disabled><i class="hi">🌐</i>DevTools</button>
            <span class="flex1"></span>
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
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDeviceMenu();
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
  req<HTMLButtonElement>("#btn-settings").addEventListener("click", () =>
    toast("M1：Flutter 工具链设置将支持 auto / custom / fvm"),
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
