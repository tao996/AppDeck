/* ============================================================
   AppDeck — Terminal（由 main.ts 拆分而来）
   ============================================================ */
import { STATUS_TEXT, activeSession, activeSessionId, esc, pendingOutput, req, scheduleTabActive, scheduleTabOpen, sessions, setActiveSessionId, setScheduleTabActive, showSchedulePane, termTheme, toast } from "./core";
import { copyPlainText } from "./database";
import { isExternalRunSession } from "./launcher";
import { revealArtifact } from "./output";
import { isFlutterSession, persistSessions, schedulePersist } from "./persistence";
import { activateScheduleTab, closeScheduleTab, stopSchedulePaneTimer } from "./schedule";
import { renderStatus } from "./tree";
import { invoke } from "@tauri-apps/api/core";

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { Location, TermSession } from "./core";
import type { ILink, ILinkProvider } from "@xterm/xterm";

export const SEARCH_DECORATIONS = {
  matchBackground: "#4a3d00",
  matchBorder: "#7a6500",
  matchOverviewRuler: "#7a6500",
  activeMatchBackground: "#b8860b",
  activeMatchBorder: "#ffd166",
  activeMatchColorOverviewRuler: "#ffd166",
};

export function renderSearchCount(index: number, count: number): void {
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

export function runSearch(forward: boolean): void {
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

export function openSearch(): void {
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

export function closeSearch(): void {
  const bar = req<HTMLDivElement>("#term-search");
  if (bar.hidden) return;
  bar.hidden = true;
  activeSession()?.search?.clearDecorations();
  renderSearchCount(0, 0);
  activeSession()?.term?.focus();
}

/** 真正清空日志：xterm 整个缓冲区（含回滚区）+ 立即覆盖落盘 */
export async function clearActiveLog(): Promise<void> {
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
export const locateCache = new Map<string, Location | null>();

export async function locateAt(cwd: string, text: string): Promise<Location | null> {
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
export async function openLocation(cwd: string, raw: string): Promise<void> {
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

export async function revealLocation(cwd: string, raw: string): Promise<void> {
  const loc = await locateAt(cwd, raw);
  if (!loc?.path) {
    toast(`无法解析路径：${raw}`, "error");
    return;
  }
  if (loc.exists) {
    try {
      await revealItemInDir(loc.path);
    } catch (e) {
      toast(String(e), "error");
    }
    return;
  }

  // 文件可能只是还没生成：日志里打印的路径、SharedPreferences 还没落盘、
  // 构建产物被清理过……「打开所在目录」要的是目录，别因为文件不在就报错。
  const dir = parentDir(loc.path);
  try {
    await invoke("open_path_default", { path: dir });
  } catch {
    toast(`文件与所在目录都不存在：${loc.path}`, "error");
  }
}

/** 去掉最后一段（文件名），得到所在目录；没有分隔符时原样返回 */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

/** 网址走系统浏览器；其余仍按磁盘位置处理 */
export async function openLinkText(cwd: string, raw: string): Promise<void> {
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
export function mapLine(term: Terminal, y: number): { text: string; xs: number[] } | null {
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
export const URL_PATTERNS: RegExp[] = [
  /\b(?:https?|ftp):\/\/[^\s"'<>|\u3000]+/gi,
  // 没写协议的本地地址：localhost:8080、127.0.0.1:3000
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})(?:\/[^\s"'<>|]*)?/gi,
];

/** 候选：`package:` URI、盘符绝对路径（行尾的 :行:列 由后端拆） */
export const LOCATE_PATTERNS: RegExp[] = [
  /package:[A-Za-z0-9_]+\/[^\s"'<>|]+/g,
  // 前缀捕获而不是 lookbehind：盘符前不能紧邻字母/数字/+-.
  // 否则 `https://host` 里的 `s://` 会被当成 S 盘，解析成 `s:\host` 再提示"文件不存在"
  /(^|[^A-Za-z0-9+.\-])([A-Za-z]:[\\/][^\s"'<>|]+)/g,
];

/** 行尾标点不该算进链接（`path.txt,`、`http://a.cn）。`） */
export function trimLinkTail(raw: string): string {
  return raw.replace(/[,\u3002\uff09)\]]+$/, "");
}

/** 网址再额外去掉句末的英文句点（`访问 https://a.cn.` 里的点不属于域名） */
export function trimUrlTail(raw: string): string {
  return trimLinkTail(raw).replace(/\.+$/, "");
}

/** 是否是网址（含不带协议的 localhost:端口） */
export function isUrlText(raw: string): boolean {
  return (
    /^(?:https?|ftp):\/\//i.test(raw) ||
    /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d/i.test(raw)
  );
}

/** 交给浏览器的地址：没写协议时补 http:// */
export function browserUrl(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

export let linkMenuEl: HTMLDivElement | null = null;

/** 300ms 内同样的位置只打开一次：xterm 的 activate 和自己的 click 监听可能同时触发 */
export let lastOpen = { key: "", at: 0 };
export function openOnce(cwd: string, raw: string): void {
  const key = `${cwd}\u0000${raw}`;
  const now = Date.now();
  if (lastOpen.key === key && now - lastOpen.at < 300) return;
  lastOpen = { key, at: now };
  void openLinkText(cwd, raw);
}

export function closeLinkMenu(): void {
  linkMenuEl?.remove();
  linkMenuEl = null;
}

export function showLinkMenu(ev: MouseEvent, cwd: string, raw: string): void {
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
  item("打开所在目录", "在资源管理器中选中该文件", () => void revealLocation(cwd, raw));
  item("复制路径", "", () => {
    void copyPlainText(raw)
      .then(() => toast("已复制"))
      .catch((e) => toast(String(e), "error"));
  });
}

/** 给终端注册"可点击位置"：网址用浏览器打开，磁盘路径用编辑器/资源管理器；Ctrl+单击，右键出菜单 */
export function attachLinkProvider(term: Terminal, pane: HTMLElement, s: TermSession): void {
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

export function ensureTerm(s: TermSession): void {
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

export function activateSession(id: string): void {
  setScheduleTabActive(false);
  stopSchedulePaneTimer();
  document.querySelector("#btn-schedule")?.classList.remove("on");
  showSchedulePane(false);

  setActiveSessionId(id);
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

export function updateControls(): void {
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
  // 终端过滤开关：只在 Flutter 终端显示；恢复 / 已停止会话没有新输出，禁用
  const flutter = isFlutterSession(s);
  req<HTMLElement>("#filter-toggle-wrap").hidden = !flutter;
  const filterToggle = req<HTMLInputElement>("#btn-filter-toggle");
  filterToggle.checked = flutter && s?.filterEnabled === true;
  filterToggle.disabled = !flutter || Boolean(s?.restored) || s?.status === "stopped";
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

export function updateEmptyState(): void {
  const empty = document.querySelector<HTMLDivElement>("#term-empty");
  if (!empty) return;
  empty.style.display = sessions.length === 0 && !scheduleTabActive ? "flex" : "none";
}

/* ---------------- 渲染：标签 ---------------- */

export function renderTabs(): void {
  const strip = req<HTMLDivElement>("#tabstrip");
  strip.innerHTML = "";

  if (sessions.length === 0 && !scheduleTabOpen) {
    const hint = document.createElement("div");
    hint.className = "tab-hint";
    hint.textContent = "暂无会话　·　在右侧选择命令，点 ▶ 或双击运行";
    strip.appendChild(hint);
  }

  for (const s of sessions) {
    const el = document.createElement("div");
    el.className =
      "tab" +
      (!scheduleTabActive && s.id === activeSessionId ? " active" : "") +
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

  if (scheduleTabOpen) {
    const el = document.createElement("div");
    el.className = "tab schedule-tab" + (scheduleTabActive ? " active" : "");
    el.title = "循环任务 · 任务列表与实时日志";
    el.innerHTML = `
      <span class="tab-title">🔁 循环任务</span>
      <button class="tab-x" title="关闭面板（任务继续在后台运行）">×</button>
    `;
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-x")) return;
      activateScheduleTab();
    });
    el.querySelector(".tab-x")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeScheduleTab();
    });
    strip.appendChild(el);
  }

  if (!scheduleTabActive) {
    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "+";
    add.title = "新建会话";
    add.addEventListener("click", () => toast("在右侧选择命令后点 ▶ 运行"));
    strip.appendChild(add);
  }
}

export async function closeSession(id: string): Promise<void> {
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

  // 循环任务面板激活时，关掉某个终端 tab 不应把视图切回终端
  if (scheduleTabActive) {
    if (activeSessionId === id) {
      setActiveSessionId(sessions.length ? sessions[sessions.length - 1].id : null);
    }
    renderTabs();
    renderStatus();
    updateControls();
    updateEmptyState();
    schedulePersist();
    return;
  }

  if (activeSessionId === id) {
    setActiveSessionId(sessions.length ? sessions[sessions.length - 1].id : null);
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
