import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

/* ============================================================
   Flutter Launcher — M0 界面骨架
   仅实现外观与交互外壳，不含真实进程/PTY 逻辑（M2 接入）
   ============================================================ */

type Status = "running" | "starting" | "stopped";
type Source = "auto" | "custom" | "fvm" | "none";

interface Cmd {
  id: string;
  name: string;
  kind: "run" | "build";
  mode?: string;
  note?: string;
}

interface Proj {
  id: string;
  name: string;
  path: string;
  flutter: string;
  source: Source;
  commands: Cmd[];
}

interface Session {
  id: string;
  project: string;
  command: string;
  device: string;
  mode: string;
  status: Status;
  term?: Terminal;
  fit?: FitAddon;
  pane?: HTMLDivElement;
}

/* ---------------- Mock 数据 ---------------- */

const projects: Proj[] = [
  {
    id: "p1",
    name: "MyFlutterApp",
    path: "D:\\projects\\my_flutter_app",
    flutter: "3.47.1",
    source: "fvm",
    commands: [
      { id: "c1", name: "Debug Dev", kind: "run", mode: "debug", note: "lib/main_dev.dart" },
      { id: "c2", name: "Debug Prod", kind: "run", mode: "debug", note: "lib/main_prod.dart" },
      { id: "c3", name: "GooglePlayReleaseProd", kind: "build", note: "appbundle · prod" },
      { id: "c4", name: "XiaoMiReleaseProd", kind: "build", note: "apk · xiaomi" },
    ],
  },
  {
    id: "p2",
    name: "DesignSystem",
    path: "D:\\projects\\design_system",
    flutter: "3.32.5",
    source: "custom",
    commands: [
      { id: "c5", name: "Debug (Chrome)", kind: "run", mode: "debug", note: "lib/main.dart" },
      { id: "c6", name: "Build Windows", kind: "build", note: "windows · release" },
    ],
  },
  {
    id: "p3",
    name: "LegacyTool",
    path: "D:\\projects\\legacy_tool",
    flutter: "未配置",
    source: "none",
    commands: [],
  },
];

const sessions: Session[] = [
  { id: "s1", project: "MyFlutterApp", command: "Debug Dev", device: "Pixel 5", mode: "debug", status: "running" },
  { id: "s2", project: "MyFlutterApp", command: "GooglePlayReleaseProd", device: "—", mode: "release", status: "starting" },
  { id: "s3", project: "DesignSystem", command: "Debug (Chrome)", device: "Chrome", mode: "debug", status: "stopped" },
];

let activeId = "s1";
const collapsed = new Set<string>();

/* ---------------- 小工具 ---------------- */

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

function toast(msg: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  window.setTimeout(() => {
    t.classList.remove("show");
    window.setTimeout(() => t.remove(), 220);
  }, 2200);
}

const STATUS_TEXT: Record<Status, string> = {
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
};

const SOURCE_TEXT: Record<Source, string> = {
  auto: "自动",
  custom: "自定义",
  fvm: "FVM",
  none: "未配置",
};

/* ---------------- ANSI ---------------- */

const C = {
  r: "\x1b[0m",
  b: "\x1b[1m",
  d: "\x1b[90m",
  red: "\x1b[31m",
  grn: "\x1b[32m",
  yel: "\x1b[33m",
  blu: "\x1b[34m",
  mag: "\x1b[35m",
  cyn: "\x1b[36m",
};

function ts(t: string): string {
  return `${C.d}[${t}]${C.r} `;
}

function mockLog(id: string): string {
  if (id === "s1") {
    return [
      ts("10:28:04") + `Launching ${C.b}lib/main_dev.dart${C.r} on ${C.b}Pixel 5${C.r} in debug mode...`,
      ts("10:28:05") + `Running Gradle task 'assembleDebug'...`,
      ts("10:28:29") + `${C.grn}✓${C.r} Built build${"\\"}app${"\\"}outputs${"\\"}flutter-apk${"\\"}app-debug.apk`,
      ts("10:28:31") + `Installing build${"\\"}app${"\\"}outputs${"\\"}flutter-apk${"\\"}app-debug.apk...`,
      ts("10:28:36") + `Syncing files to device Pixel 5...`,
      "",
      `${C.b}Flutter run key commands.${C.r}`,
      `${C.b}r${C.r} Hot reload.`,
      `${C.b}R${C.r} Hot restart.`,
      `${C.b}h${C.r} List all available interactive commands.`,
      `${C.b}d${C.r} Detach (terminate "flutter run" but leave application running).`,
      `${C.b}c${C.r} Clear the screen`,
      `${C.b}q${C.r} Quit (terminate the application on the device).`,
      "",
      `A Dart VM Service on Pixel 5 is available at: ${C.cyn}http://127.0.0.1:54321/AbCdEf=/${C.r}`,
      `The Flutter DevTools debugger and profiler on Pixel 5 is available at:`,
      `    ${C.cyn}http://127.0.0.1:54321?uri=ws://127.0.0.1:54321/AbCdEf=/ws${C.r}`,
      "",
      ts("10:29:12") + `${C.grn}Performed hot reload in 412ms.${C.r}`,
      `${C.blu}I/flutter${C.r} ( 4321): ${C.mag}[App]${C.r} ApiClient: GET https://api.example.com/v1/config → ${C.grn}200${C.r} (143ms)`,
      `${C.blu}I/flutter${C.r} ( 4321): ${C.mag}[App]${C.r} Router: /home → /detail/42`,
      `${C.yel}W/flutter${C.r} ( 4321): Hero tag "card-42" has a non-unique tag: more than one hero`,
      `  with the same tag was found.`,
      `${C.blu}I/flutter${C.r} ( 4321): ${C.mag}[App]${C.r} Render: frame 1420 · 16.7ms (jank 3)`,
      "",
    ].join("\r\n");
  }

  if (id === "s2") {
    return [
      ts("10:31:02") + `${C.yel}该命令已在队列中：项目 MyFlutterApp 存在进行中的构建${C.r}`,
      ts("10:31:02") + `等待构建锁…`,
      ts("10:31:07") + `${C.grn}✓ 已获得构建锁${C.r}`,
      ts("10:31:07") + `Running Gradle task 'bundleRelease'...`,
      "",
    ].join("\r\n");
  }

  return [
    ts("10:22:11") + `Launching ${C.b}lib/main.dart${C.r} on ${C.b}Windows${C.r} in debug mode...`,
    ts("10:22:12") + `Building Windows application...`,
    ts("10:22:48") + `${C.grn}✓${C.r} Built build${"\\"}windows${"\\"}x64${"\\"}runner${"\\"}Debug${"\\"}design_system.exe`,
    ts("10:22:49") + `Syncing files to device Windows...`,
    "",
    `A Dart VM Service on Windows is available at: ${C.cyn}http://127.0.0.1:61882/XyZ123=/${C.r}`,
    "",
    `${C.blu}I/flutter${C.r} ( 9012): DesignSystem booted in 1.4s`,
    `${C.blu}I/flutter${C.r} ( 9012): Loaded 128 tokens, 42 components`,
    "",
    ts("10:34:55") + `${C.red}Application finished.${C.r}`,
    ts("10:34:55") + `${C.d}进程退出码 0${C.r}`,
    "",
  ].join("\r\n");
}

/* ---------------- 终端 ---------------- */

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

function ensureTerm(s: Session, holder: HTMLElement): Terminal {
  if (s.term) return s.term;

  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.dataset.sid = s.id;
  holder.appendChild(pane);

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.35,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 8000,
    theme: termTheme,
    allowProposedApi: true,
    convertEol: false,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  } catch {
    /* 忽略：退化为默认宽度计算 */
  }

  term.open(pane);

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* 忽略：回退到 DOM 渲染器 */
  }

  s.term = term;
  s.fit = fit;
  s.pane = pane;

  term.write(mockLog(s.id));
  return term;
}

function startSpinner(s: Session): void {
  if (s.status !== "starting" || !s.term) return;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  window.setInterval(() => {
    s.term?.write(`\r${C.cyn}${frames[i % frames.length]}${C.r} Downloading dependencies... ${C.d}(M0 演示：无真实进程)${C.r}\x1b[K`);
    i += 1;
  }, 140);
}

/* ---------------- 渲染：标签 ---------------- */

function dotClass(st: Status): string {
  return st === "running" ? "dot run" : st === "starting" ? "dot start" : "dot stop";
}

function renderTabs(): void {
  const strip = req<HTMLDivElement>("#tabstrip");
  strip.innerHTML = "";

  for (const s of sessions) {
    const el = document.createElement("div");
    el.className = "tab" + (s.id === activeId ? " active" : "");
    el.dataset.sid = s.id;
    el.title = `${STATUS_TEXT[s.status]} · ${s.device} · ${s.mode}`;
    el.innerHTML = `
      <span class="${dotClass(s.status)}"></span>
      <span class="tab-title">${esc(s.project)}<span class="sep">:</span>${esc(s.command)}</span>
      <span class="tab-dev">${esc(s.device)}</span>
      <button class="tab-x" title="关闭">×</button>
    `;
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-x")) return;
      activate(s.id);
    });
    el.querySelector(".tab-x")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toast("M0：关闭会话将在 M2 接入真实进程后启用");
    });
    strip.appendChild(el);
  }

  const add = document.createElement("button");
  add.className = "tab-add";
  add.textContent = "+";
  add.title = "新建会话";
  add.addEventListener("click", () => toast("M0：新建会话将在 M2 接入"));
  strip.appendChild(add);
}

/* ---------------- 渲染：项目树 ---------------- */

function renderTree(): void {
  const tree = req<HTMLDivElement>("#tree");
  tree.innerHTML = "";
  let totalCmds = 0;

  for (const p of projects) {
    totalCmds += p.commands.length;
    const box = document.createElement("div");
    box.className = "proj";

    const isCollapsed = collapsed.has(p.id);
    const warn = p.source === "none";

    const head = document.createElement("div");
    head.className = "proj-row" + (warn ? " warn" : "");
    head.innerHTML = `
      <span class="chev">${isCollapsed ? "▸" : "▾"}</span>
      <span class="pico">${warn ? "⚠" : "📁"}</span>
      <span class="pname">${esc(p.name)}</span>
      <span class="pmeta">
        <span class="chip src-${p.source}">${esc(SOURCE_TEXT[p.source])}</span>
        ${warn ? "" : `<span class="fver">${esc(p.flutter)}</span>`}
      </span>
    `;
    head.title = p.path;
    head.addEventListener("click", () => {
      if (collapsed.has(p.id)) collapsed.delete(p.id);
      else collapsed.add(p.id);
      renderTree();
    });
    box.appendChild(head);

    if (!isCollapsed) {
      const list = document.createElement("div");
      list.className = "cmds";

      for (const c of p.commands) {
        const row = document.createElement("div");
        row.className = "cmd";
        const activeHere = sessions.some((s) => s.id === activeId && s.command === c.name && s.project === p.name);
        if (activeHere) row.classList.add("selected");
        row.innerHTML = `
          <span class="cico">${c.kind === "build" ? "📦" : "🚀"}</span>
          <span class="cname">${esc(c.name)}</span>
          <span class="cnote">${esc(c.note ?? "")}</span>
          <span class="cadd" title="选择设备并运行">▷</span>
        `;
        row.title = "右键选择设备（M3 接入设备列表）";
        row.addEventListener("click", () => {
          toast(`M0：将启动「${c.name}」，M2 接入 PTY 后可用`);
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          toast("M0：设备菜单将在 M3 接入 daemon 后启用");
        });
        list.appendChild(row);
      }

      if (warn) {
        const hint = document.createElement("div");
        hint.className = "cmd hint";
        hint.textContent = "Flutter 路径未配置 —— 点击右上角 ⚙ 设置";
        list.appendChild(hint);
      }

      const addCmd = document.createElement("div");
      addCmd.className = "cmd add";
      addCmd.innerHTML = `<span class="cico">＋</span><span class="cname">添加命令</span>`;
      addCmd.addEventListener("click", () => toast("M0：命令编辑将在 M1 接入"));
      list.appendChild(addCmd);

      box.appendChild(list);
    }

    tree.appendChild(box);
  }

  req<HTMLSpanElement>("#proj-count").textContent = `${projects.length} 个项目 · ${totalCmds} 条命令`;
}

/* ---------------- 激活会话 ---------------- */

function activate(id: string): void {
  activeId = id;
  const holder = req<HTMLDivElement>("#term-holder");

  for (const s of sessions) {
    if (!s.pane) continue;
    s.pane.classList.toggle("active", s.id === id);
  }

  const cur = sessions.find((s) => s.id === id);
  if (cur) {
    ensureTerm(cur, holder);
    for (const s of sessions) s.pane?.classList.toggle("active", s.id === id);
    requestAnimationFrame(() => {
      cur.fit?.fit();
      cur.term?.focus();
    });
  }

  // 控制条按钮启用状态
  const isRun = cur?.status === "running" && cur?.mode === "debug";
  req<HTMLButtonElement>("#btn-reload").disabled = !isRun;
  req<HTMLButtonElement>("#btn-restart").disabled = !isRun;
  req<HTMLButtonElement>("#btn-stop").disabled = cur?.status === "stopped";
  req<HTMLButtonElement>("#btn-devtools").disabled = cur?.status === "stopped";

  req<HTMLSpanElement>("#ctx-info").textContent = cur
    ? `${cur.project} : ${cur.command}  ·  ${cur.device}  ·  ${STATUS_TEXT[cur.status]}`
    : "";

  renderTabs();
  renderTree();
}

/* ---------------- 启动 ---------------- */

function boot(): void {
  const app = req<HTMLDivElement>("#app");

  app.innerHTML = `
    <div class="app">
      <header class="toolbar">
        <div class="brand">
          <span class="logo">◆</span>
          <span class="title">Flutter Launcher</span>
          <span class="badge-m0">M0 · 界面预览</span>
        </div>

        <div class="tb-center">
          <button class="btn primary" id="btn-add">＋ 添加 Flutter 项目</button>
          <button class="btn" id="btn-import">📂 导入 launch.json</button>
        </div>

        <div class="tb-right">
          <span class="tb-meta">Flutter 3.47.1 · 3 设备 · 1 模拟器</span>
          <button class="btn icon" id="btn-settings" title="设置">⚙</button>
        </div>
      </header>

      <div class="tabstrip" id="tabstrip"></div>

      <div class="main">
        <section class="left">
          <div class="term-controls">
            <button class="cbtn" id="btn-reload"><i class="hi">⚡</i>热重载</button>
            <button class="cbtn" id="btn-restart"><i class="hi">🔄</i>热重启</button>
            <button class="cbtn danger" id="btn-stop"><i class="hi">⏹</i>停止</button>
            <button class="cbtn" id="btn-devtools"><i class="hi">🌐</i>DevTools</button>
            <span class="flex1"></span>
            <span class="ctx-info" id="ctx-info"></span>
            <button class="cbtn ghost" id="btn-clear" title="清屏">清屏</button>
          </div>
          <div class="term-holder" id="term-holder"></div>
        </section>

        <div class="splitter" id="splitter"></div>

        <aside class="right">
          <div class="panel-head">
            <span>项目</span>
            <span class="dim" id="proj-count"></span>
          </div>
          <div class="tree" id="tree"></div>
        </aside>
      </div>

      <footer class="statusbar">
        <span class="sb-item ok">就绪</span>
        <span class="sb-sep"></span>
        <span class="sb-item">ConPTY 未连接（M2）</span>
        <span class="sb-sep"></span>
        <span class="sb-item">UTF-8</span>
        <span class="flex1"></span>
        <span class="sb-item">DevTools 2.60.0</span>
        <span class="sb-sep"></span>
        <span class="sb-item">AVD Pixel_5 可启动</span>
      </footer>
    </div>
  `;

  renderTabs();
  renderTree();

  const holder = req<HTMLDivElement>("#term-holder");
  for (const s of sessions) ensureTerm(s, holder);
  s2Spinner();
  activate(activeId);

  req<HTMLButtonElement>("#btn-add").addEventListener("click", () => toast("M0：目录选择器将在 M1 接入"));
  req<HTMLButtonElement>("#btn-import").addEventListener("click", () =>
    toast("M0：launch.json 导入将在 M6 接入"),
  );
  req<HTMLButtonElement>("#btn-settings").addEventListener("click", () =>
    toast("M0：设置面板将在 M1 接入"),
  );
  req<HTMLButtonElement>("#btn-reload").addEventListener("click", () => toast("M0：热重载需 ConPTY（M2）"));
  req<HTMLButtonElement>("#btn-restart").addEventListener("click", () => toast("M0：热重启需 ConPTY（M2）"));
  req<HTMLButtonElement>("#btn-stop").addEventListener("click", () => toast("M0：停止需真实进程（M2）"));
  req<HTMLButtonElement>("#btn-devtools").addEventListener("click", () => toast("M0：DevTools 链接将从终端输出解析（M4）"));
  req<HTMLButtonElement>("#btn-clear").addEventListener("click", () => {
    const cur = sessions.find((s) => s.id === activeId);
    cur?.term?.clear();
  });

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
    const cur = sessions.find((s) => s.id === activeId);
    cur?.fit?.fit();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.classList.remove("dragging");
  });

  window.addEventListener("resize", () => {
    const cur = sessions.find((s) => s.id === activeId);
    cur?.fit?.fit();
  });
}

function s2Spinner(): void {
  const s = sessions.find((x) => x.id === "s2");
  if (!s) return;
  // 等终端挂载完成后再启动动画
  window.setTimeout(() => {
    if (s.term) {
      s.term.write("\r\n");
      startSpinner(s);
    }
  }, 300);
}

window.addEventListener("DOMContentLoaded", boot);
