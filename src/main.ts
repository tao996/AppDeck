import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";

/* ============================================================
   Flutter Launcher — M1：项目管理 + 项目树 + 持久化
   真实数据来源：Rust 后端 state.json
   尚未接入：PTY 会话（M2）、设备（M3）
   ============================================================ */

type FlutterSource = "fvm" | "custom" | "path" | "none";

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

let state: State = { schemaVersion: 2, settings: {}, projects: [] };
const flutterInfo = new Map<string, FlutterInfo>();
const collapsed = new Set<string>();
let selectedCommand: string | null = null;
let statePath = "";

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

/* ---------------- 渲染：标签栏 ---------------- */

function renderTabs(): void {
  const strip = req<HTMLDivElement>("#tabstrip");
  strip.innerHTML = `
    <div class="tab-hint">暂无会话　·　M2 接入 ConPTY 后在此显示终端标签</div>
    <button class="tab-add" id="tab-add" title="新建会话">+</button>
  `;
  req<HTMLButtonElement>("#tab-add").addEventListener("click", () =>
    toast("M2：会话将由「执行命令」创建"),
  );
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
          <span class="cadd" title="选择设备并运行">▷</span>
        `;
        row.title = [
          c.cwd ? `目录: ${c.cwd}` : "目录: 工作区根",
          c.args.length ? `参数: ${c.args.join(" ")}` : "",
          c.flutterMode ? `模式: ${c.flutterMode}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        row.addEventListener("click", () => {
          selectedCommand = c.id;
          renderTree();
          toast("M2：将在此命令上创建 ConPTY 会话");
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          toast("M3：设备菜单将接入 flutter daemon");
        });
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
}

function render(): void {
  renderTabs();
  renderTree();
  renderStatus();
}

/* ---------------- 动作 ---------------- */

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
    toast(silent ? `已自动导入 ${res.imported} 条命令` : base + warn, res.warnings.length ? "error" : "info");
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

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  const app = req<HTMLDivElement>("#app");

  app.innerHTML = `
    <div class="app">
      <header class="toolbar">
        <div class="brand">
          <span class="logo">◆</span>
          <span class="title">Flutter Launcher</span>
          <span class="badge-m0">M1 · 项目管理</span>
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
            <button class="cbtn" disabled><i class="hi">⚡</i>热重载</button>
            <button class="cbtn" disabled><i class="hi">🔄</i>热重启</button>
            <button class="cbtn danger" disabled><i class="hi">⏹</i>停止</button>
            <button class="cbtn" disabled><i class="hi">🌐</i>DevTools</button>
            <span class="flex1"></span>
            <span class="ctx-info">等待会话</span>
          </div>
          <div class="term-holder" id="term-holder">
            <div class="empty-term">
              <div class="et-glyph">▮</div>
              <div class="et-title">还没有运行中的会话</div>
              <div class="et-sub">
                在右侧项目树中选择一条命令，选择设备后即可在此打开终端<br/>
                <span class="dim">ConPTY 终端将在 M2 接入</span>
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
        <span class="flex1"></span>
        <span class="sb-item">UTF-8</span>
        <span class="sb-sep"></span>
        <span class="sb-item">ConPTY 未连接（M2）</span>
      </footer>
    </div>
  `;

  render();

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

  // 加载真实状态
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

  const meta = req<HTMLSpanElement>("#tb-meta");
  meta.textContent = `schema v${state.schemaVersion}`;

  // 并发探测各项目的 Flutter 版本
  for (const p of state.projects) void refreshFlutter(p.id);

  // 分割条拖拽
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
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.classList.remove("dragging");
  });
}

window.addEventListener("DOMContentLoaded", () => void boot());
