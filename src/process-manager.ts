/**
 * 进程与端口管理面板。
 *
 * 定位是开发辅助：默认只显示当前用户会话的进程，端口表始终保留所有者。
 * 数据来自后端 `process_snapshot`（Win32 ToolHelp + IP Helper）。
 */

import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export interface ProcessPrefs {
  /** 程序名包含任一规则就不显示（大小写不敏感） */
  hideRules: string[];
  /** 隐藏规则是否生效（规则可以保留但临时停用） */
  hideRulesEnabled: boolean;
  /** 是否每 2 秒自动刷新 */
  autoRefresh: boolean;
}

export interface ProcessManagerDeps {
  notify: (msg: string, kind?: "info" | "error") => void;
  /** 当前 AppDeck 会话：pid → 标签标题（用于标记“会话”） */
  sessionPids?: () => Map<number, string>;
  initialPrefs: ProcessPrefs;
  savePrefs: (prefs: ProcessPrefs) => Promise<unknown>;
}

interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  exe: string | null;
  user: string | null;
  memoryBytes: number;
  cpuPercent: number;
  startedAtMs: number | null;
  critical: boolean;
  system: boolean;
  /** 其他会话里的第三方服务（默认隐藏，但可以尝试结束） */
  service: boolean;
  isSelf: boolean;
}

interface PortInfo {
  proto: "tcp" | "udp";
  family: "v4" | "v6";
  localAddr: string;
  localPort: number;
  remoteAddr: string | null;
  remotePort: number | null;
  state: string;
  pid: number;
}

interface Snapshot {
  takenAtMs: number;
  elevated: boolean;
  processes: ProcInfo[];
  ports: PortInfo[];
}

interface KillFailure {
  pid: number;
  error: string;
}

interface KillReport {
  killed: number[];
  failed: KillFailure[];
}

type Tab = "processes" | "ports";
type SortKey = "name" | "pid" | "ports" | "memory" | "cpu";

/** 常见开发运行时：用于「开发进程」快速筛选 */
const DEV_NAMES = new Set([
  "flutter",
  "dart",
  "dartaotruntime",
  "gen_snapshot",
  "java",
  "javaw",
  "kotlin",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "pythonw",
  "go",
  "dotnet",
  "adb",
  "gradle",
  "mvn",
  "docker",
  "wsl",
  "wslrelay",
  "vite",
  "webpack",
  "esbuild",
  "tsc",
  "rustc",
  "cargo",
  "deno",
  "bun",
  "electron",
]);

const esc = (s: string): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );

function isDevName(name: string): boolean {
  return DEV_NAMES.has(name.toLowerCase().replace(/\.exe$/, ""));
}

function isListening(port: PortInfo): boolean {
  return port.state === "LISTEN" || port.proto === "udp";
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtWhen(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtUptime(ms: number | null): string {
  if (!ms) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${(sec / 86400).toFixed(1)} 天`;
}

function hostText(addr: string): string {
  if (addr === "0.0.0.0" || addr === "::") return "*";
  return addr.includes(":") ? `[${addr}]` : addr;
}

function endpoint(addr: string, port: number): string {
  return `${hostText(addr)}:${port}`;
}

/** 规则清洗：去空白 / 空行、大小写不敏感去重（保留原始写法给 textarea 回显） */
function normalizeRules(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const rule = raw.trim();
    if (!rule) continue;
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= 200) break;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

export function openProcessManager(deps: ProcessManagerDeps): void {
  let snapshot: Snapshot | null = null;
  let tab: Tab = "processes";
  let query = "";
  let showSystem = false;
  let onlyPort = false;
  let onlyDev = false;
  let onlyListening = true;
  let sortKey: SortKey = "ports";
  let sortDir: 1 | -1 = -1;
  let selectedPid: number | null = null;
  let autoRefresh = deps.initialPrefs.autoRefresh;
  let hideRules = normalizeRules(deps.initialPrefs.hideRules);
  let hideRulesEnabled = deps.initialPrefs.hideRulesEnabled;
  let rulesOpen = false;
  let prefsDirty = false;
  let prefsTimer: number | null = null;
  let loading = false;
  let destroyed = false;
  let error: string | null = null;
  let timer: number | null = null;
  let contextMenu: HTMLDivElement | null = null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal proc-modal">
      <div class="modal-head">
        <span>进程与端口</span>
        <span class="proc-head-right">
          <span class="proc-elev" id="proc-elev"></span>
          <button class="modal-x" title="关闭">×</button>
        </span>
      </div>

      <div class="proc-toolbar">
        <input
          class="set-input proc-search"
          id="proc-search"
          type="text"
          placeholder="搜索 名称 / PID / 端口 / 路径…"
          spellcheck="false"
          autocomplete="off"
        />
        <span class="proc-tabbar">
          <button class="proc-tab active" data-tab="processes">进程</button>
          <button class="proc-tab" data-tab="ports">端口</button>
        </span>
        <label class="proc-check" id="proc-only-port-wrap">
          <input type="checkbox" id="proc-only-port" /> 只看有端口
        </label>
        <label class="proc-check" id="proc-only-listen-wrap" hidden>
          <input type="checkbox" id="proc-only-listen" checked /> 只看监听/绑定
        </label>
        <label class="proc-check">
          <input type="checkbox" id="proc-only-dev" /> 开发进程
        </label>
        <label class="proc-check" id="proc-show-system-wrap">
          <input type="checkbox" id="proc-show-system" /> 显示系统/服务
        </label>
        <span class="flex1"></span>
        <label class="proc-check" title="每 2 秒自动刷新">
          <input type="checkbox" id="proc-autorefresh" /> 自动刷新
        </label>
        <label class="proc-check" title="临时停用隐藏规则；规则本身会保留">
          <input type="checkbox" id="proc-hide-rules-enabled" /> 启用隐藏规则
        </label>
        <button class="btn" id="proc-rules-toggle" title="按程序名隐藏进程（一行一个规则）">隐藏规则</button>
        <button class="btn" id="proc-refresh" title="立即刷新快照">⟳ 刷新</button>
      </div>

      <div class="proc-rules" id="proc-rules" hidden>
        <div class="proc-rules-head">
          <span>隐藏规则</span>
          <span class="proc-rules-hint">一行一个；程序名包含任一规则就不显示（大小写不敏感）</span>
        </div>
        <textarea
          id="proc-rules-input"
          class="proc-rules-input"
          spellcheck="false"
          placeholder="svchost&#10;SearchHost&#10;msedgewebview2"
        ></textarea>
        <div class="proc-rules-foot" id="proc-rules-count"></div>
      </div>

      <div class="proc-summary" id="proc-summary">正在读取进程与端口…</div>

      <div class="proc-main">
        <div class="proc-table-wrap" id="proc-table-wrap"></div>
        <aside class="proc-detail" id="proc-detail">
          <div class="proc-detail-empty">选择一行查看详情</div>
        </aside>
      </div>

      <div class="modal-foot">
        <span class="proc-status" id="proc-status">正在读取…</span>
        <span class="flex1"></span>
        <button class="btn danger" id="proc-kill" disabled>结束进程</button>
        <button class="btn" id="proc-kill-tree" disabled>结束进程树</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const $ = <T extends Element>(sel: string): T => overlay.querySelector(sel) as T;

  const search = $<HTMLInputElement>("#proc-search");
  const summary = $<HTMLDivElement>("#proc-summary");
  const tableWrap = $<HTMLDivElement>("#proc-table-wrap");
  const detail = $<HTMLElement>("#proc-detail");
  const status = $<HTMLSpanElement>("#proc-status");
  const elev = $<HTMLSpanElement>("#proc-elev");
  const autoRefreshEl = $<HTMLInputElement>("#proc-autorefresh");
  const rulesEnabledEl = $<HTMLInputElement>("#proc-hide-rules-enabled");
  const rulesToggle = $<HTMLButtonElement>("#proc-rules-toggle");
  const rulesPanel = $<HTMLDivElement>("#proc-rules");
  const rulesInput = $<HTMLTextAreaElement>("#proc-rules-input");
  const rulesCount = $<HTMLDivElement>("#proc-rules-count");
  const killBtn = $<HTMLButtonElement>("#proc-kill");
  const killTreeBtn = $<HTMLButtonElement>("#proc-kill-tree");

  autoRefreshEl.checked = autoRefresh;
  rulesEnabledEl.checked = hideRulesEnabled;
  rulesInput.value = hideRules.join("\n");

  const matchesHideRule = (name: string): boolean => {
    if (!hideRulesEnabled || !hideRules.length) return false;
    const lower = name.toLowerCase();
    return hideRules.some((rule) => lower.includes(rule.toLowerCase()));
  };

  const syncRulesUi = (): void => {
    rulesPanel.hidden = !rulesOpen;
    rulesToggle.textContent = rulesOpen
      ? "收起规则"
      : hideRules.length
        ? `隐藏规则 (${hideRules.length})`
        : "隐藏规则";
    rulesCount.textContent = hideRules.length
      ? `已设置 ${hideRules.length} 条规则（进程和端口都按程序名匹配）${
          hideRulesEnabled ? "" : "，当前已停用"
        }`
      : "尚未设置规则";
  };
  syncRulesUi();

  const savePrefsNow = async (): Promise<void> => {
    if (!prefsDirty) return;
    prefsDirty = false;
    if (prefsTimer !== null) {
      window.clearTimeout(prefsTimer);
      prefsTimer = null;
    }
    try {
      await deps.savePrefs({ hideRules, hideRulesEnabled, autoRefresh });
    } catch (e) {
      deps.notify(`保存进程面板偏好失败：${String(e)}`, "error");
    }
  };

  const markPrefsDirty = (): void => {
    prefsDirty = true;
    if (prefsTimer !== null) window.clearTimeout(prefsTimer);
    prefsTimer = window.setTimeout(() => {
      prefsTimer = null;
      void savePrefsNow();
    }, 500);
  };

  /** 右键「隐藏此进程」：把程序名追加到隐藏规则，立即生效并落盘 */
  const hideProcess = (p: ProcInfo): void => {
    const wasDisabled = !hideRulesEnabled;
    if (wasDisabled) {
      // 用户明确要隐藏，规则却是停用状态：顺手启用，否则点了没反应
      hideRulesEnabled = true;
      rulesEnabledEl.checked = true;
    }

    const next = normalizeRules([...hideRules, p.name]);
    if (next.length === hideRules.length) {
      deps.notify(`「${p.name}」已在隐藏规则中`);
      syncRulesUi();
      markPrefsDirty();
      render();
      return;
    }
    hideRules = next;
    rulesInput.value = hideRules.join("\n");
    syncRulesUi();
    markPrefsDirty();
    render();
    deps.notify(
      wasDisabled
        ? `已启用隐藏规则并隐藏「${p.name}」，可在「隐藏规则」里撤销`
        : `已隐藏「${p.name}」，可在「隐藏规则」里撤销`,
    );
  };

  const closeContextMenu = (): void => {
    contextMenu?.remove();
    contextMenu = null;
  };

  const close = (): void => {
    if (destroyed) return;
    // 规则是边输边生效的；关闭前把未落盘的偏好补写一次，避免 500ms 内关掉丢失
    void savePrefsNow();
    destroyed = true;
    closeContextMenu();
    if (timer !== null) window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("resize", closeContextMenu);
    overlay.remove();
  };

  overlay.querySelector(".modal-x")?.addEventListener("click", close);

  /** 打开管理面板期间，Esc 关闭；有右键菜单时先关菜单 */
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (contextMenu) {
        closeContextMenu();
        return;
      }
      close();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      search.focus();
      search.select();
    }
  });

  const onVisible = (): void => {
    if (!document.hidden && autoRefresh) void load();
  };
  document.addEventListener("visibilitychange", onVisible);

  /* ---------------- 数据 ---------------- */

  const load = async (): Promise<void> => {
    if (destroyed || loading) return;
    loading = true;
    try {
      snapshot = await invoke<Snapshot>("process_snapshot");
      error = null;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
      if (!destroyed) render();
    }
  };

  const tick = (): void => {
    if (autoRefresh && !document.hidden) void load();
  };
  timer = window.setInterval(tick, 2000);

  /* ---------------- 渲染 ---------------- */

  const render = (): void => {
    if (destroyed) return;

    if (!snapshot) {
      summary.textContent = error ? `读取失败：${error}` : "正在读取进程与端口…";
      status.textContent = error ? "读取失败，稍后自动重试" : "正在读取…";
      return;
    }

    const snap = snapshot;
    elev.textContent = snap.elevated ? "管理员" : "普通权限";
    elev.title = snap.elevated
      ? "当前以管理员身份运行，可结束管理员进程"
      : "普通权限：结束管理员进程会失败，需要以管理员身份运行 AppDeck";

    const procByPid = new Map<number, ProcInfo>();
    for (const p of snap.processes) procByPid.set(p.pid, p);

    const portsByPid = new Map<number, PortInfo[]>();
    for (const port of snap.ports) {
      const arr = portsByPid.get(port.pid);
      if (arr) arr.push(port);
      else portsByPid.set(port.pid, [port]);
    }

    const listenByPid = new Map<number, number[]>();
    for (const p of snap.processes) {
      const ports = portsByPid.get(p.pid) ?? [];
      const nums = Array.from(new Set(ports.filter(isListening).map((x) => x.localPort))).sort(
        (a, b) => a - b,
      );
      listenByPid.set(p.pid, nums);
    }

    const sessionMap = deps.sessionPids?.() ?? new Map<number, string>();
    const q = query.trim().toLowerCase();

    const matchProcess = (p: ProcInfo): boolean => {
      if (matchesHideRule(p.name)) return false;
      if (!showSystem && (p.system || p.service)) return false;
      if (onlyDev && !isDevName(p.name)) return false;
      const ports = listenByPid.get(p.pid) ?? [];
      if (onlyPort && ports.length === 0) return false;
      if (!q) return true;
      const hay = [
        p.name,
        String(p.pid),
        p.exe ?? "",
        p.user ?? "",
        ports.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    };

    const procRows = snap.processes.filter(matchProcess);
    procRows.sort((a, b) => {
      const portsA = (listenByPid.get(a.pid) ?? []).length;
      const portsB = (listenByPid.get(b.pid) ?? []).length;
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "ports":
          cmp = portsA - portsB;
          break;
        case "memory":
          cmp = a.memoryBytes - b.memoryBytes;
          break;
        case "cpu":
          cmp = a.cpuPercent - b.cpuPercent;
          break;
      }
      return (cmp !== 0 ? cmp : a.name.localeCompare(b.name)) * sortDir;
    });

    const matchPort = (port: PortInfo): boolean => {
      if (onlyListening && !isListening(port)) return false;
      const owner = procByPid.get(port.pid);
      if (owner && matchesHideRule(owner.name)) return false;
      if (onlyDev && !(owner && isDevName(owner.name))) return false;
      if (!q) return true;
      const hay = [
        port.proto,
        port.family,
        port.localAddr,
        String(port.localPort),
        port.remoteAddr ?? "",
        String(port.remotePort ?? ""),
        port.state,
        String(port.pid),
        owner?.name ?? "",
        owner?.exe ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    };

    const portRows = snap.ports.filter(matchPort).sort((a, b) => {
      return (
        a.localPort - b.localPort ||
        a.proto.localeCompare(b.proto) ||
        a.pid - b.pid
      );
    });

    // 选中的进程被搜索/筛选隐藏后必须清掉选择：否则详情和「结束进程」
    // 会继续指着一条看不见的进程，用户以为在操作当前筛选结果（踩过）。
    const visiblePids = new Set(
      (tab === "processes" ? procRows : portRows).map((row) => row.pid),
    );
    if (selectedPid != null && !visiblePids.has(selectedPid)) selectedPid = null;

    const hiddenSystem = snap.processes.filter((p) => p.system || p.service).length;
    // 只统计“本来会显示、被规则挡住”的进程，避免和系统进程隐藏数重复计数
    const ruleHidden = snap.processes.filter(
      (p) => matchesHideRule(p.name) && (showSystem || (!p.system && !p.service)),
    ).length;
    const ruleHiddenPorts = snap.ports.filter((port) => {
      const owner = procByPid.get(port.pid);
      return owner ? matchesHideRule(owner.name) : false;
    }).length;
    const listenTotal = snap.ports.filter(isListening).length;
    const rulesOff = hideRules.length > 0 && !hideRulesEnabled;

    if (tab === "processes") {
      summary.textContent =
        `显示 ${procRows.length} / ${snap.processes.length} 个进程` +
        ` · ${listenTotal} 个监听/绑定端口` +
        (!showSystem && hiddenSystem > 0 ? ` · 已隐藏 ${hiddenSystem} 个系统/服务进程` : "") +
        (rulesOff
          ? " · 隐藏规则已停用"
          : ruleHidden > 0
            ? ` · 规则隐藏 ${ruleHidden} 个`
            : "");
    } else {
      summary.textContent =
        `显示 ${portRows.length} / ${snap.ports.length} 条端口记录` +
        ` · ${listenTotal} 个监听/绑定` +
        (onlyListening ? "（已排除已建立连接）" : "") +
        (rulesOff
          ? " · 隐藏规则已停用"
          : ruleHiddenPorts > 0
            ? ` · 规则隐藏 ${ruleHiddenPorts} 条`
            : "");
    }

    const updated = new Date(snap.takenAtMs);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    status.textContent =
      `更新于 ${p2(updated.getHours())}:${p2(updated.getMinutes())}:${p2(updated.getSeconds())}` +
      (autoRefresh ? " · 每 2 秒自动刷新" : " · 自动刷新已关闭") +
      (error ? " · 本次刷新失败" : "");

    // 切 tab 时，各自只显示相关筛选
    $<HTMLLabelElement>("#proc-only-port-wrap").hidden = tab !== "processes";
    $<HTMLLabelElement>("#proc-only-listen-wrap").hidden = tab !== "ports";
    // 端口页始终显示所有者（包括系统进程），这个开关只对进程页有意义
    $<HTMLLabelElement>("#proc-show-system-wrap").hidden = tab !== "processes";

    const scrollTop = tableWrap.scrollTop;
    if (tab === "processes") {
      const th = (key: SortKey, label: string): string => {
        const on = sortKey === key;
        return `<th data-sort="${key}" class="${on ? "on" : ""}">${label}${
          on ? (sortDir > 0 ? " ▲" : " ▼") : ""
        }</th>`;
      };
      const rows = procRows
        .map((p) => {
          const nums = listenByPid.get(p.pid) ?? [];
          const portsText = nums.length
            ? `${nums.slice(0, 6).join(", ")}${nums.length > 6 ? ` +${nums.length - 6}` : ""}`
            : "—";
          const userShort = p.user ? p.user.split("\\").pop() : "";
          return `<tr class="proc-row${p.pid === selectedPid ? " selected" : ""}${
            p.system ? " sys" : p.service ? " svc" : ""
          }" data-pid="${p.pid}">
            <td class="proc-name-cell" title="${esc(p.exe ?? p.name)}">${esc(p.name)}${badges(
              p,
              sessionMap.get(p.pid),
            )}</td>
            <td class="proc-num">${p.pid}</td>
            <td class="proc-ports-cell" title="${esc(nums.join(", "))}">${esc(portsText)}</td>
            <td class="proc-num">${fmtBytes(p.memoryBytes)}</td>
            <td class="proc-num">${p.cpuPercent.toFixed(1)}%</td>
            <td class="proc-user-cell" title="${esc(p.user ?? "")}">${esc(userShort || "—")}</td>
          </tr>`;
        })
        .join("");

      tableWrap.innerHTML = `<table class="proc-table">
        <thead><tr>${th("name", "名称")}${th("pid", "PID")}${th("ports", "端口")}${th(
          "memory",
          "内存",
        )}${th("cpu", "CPU")}<th>用户</th></tr></thead>
        <tbody>${
          rows ||
          `<tr><td colspan="6" class="proc-empty">没有匹配的进程${
            q
              ? `（搜索：${esc(query.trim())}）`
              : hideRules.length
                ? "（隐藏规则生效中）"
                : ""
          }</td></tr>`
        }</tbody>
      </table>`;
    } else {
      const rows = portRows
        .map((port) => {
          const owner = procByPid.get(port.pid);
          const remote = port.remoteAddr
            ? endpoint(port.remoteAddr, port.remotePort ?? 0)
            : "—";
          return `<tr class="proc-row${port.pid === selectedPid ? " selected" : ""}${
            owner?.system ? " sys" : owner?.service ? " svc" : ""
          }" data-pid="${port.pid}">
            <td class="proc-proto-cell">${port.proto.toUpperCase()}<i>${port.family}</i></td>
            <td class="proc-mono">${esc(endpoint(port.localAddr, port.localPort))}</td>
            <td class="proc-mono">${esc(remote)}</td>
            <td><span class="proc-state s-${port.state.toLowerCase()}">${esc(port.state)}</span></td>
            <td class="proc-num">${port.pid}</td>
            <td class="proc-name-cell">${esc(
              owner?.name ?? (port.pid ? `PID ${port.pid}` : "—"),
            )}${
              owner?.system
                ? '<span class="proc-badge system">系统</span>'
                : owner?.service
                  ? '<span class="proc-badge service">服务</span>'
                  : ""
            }</td>
          </tr>`;
        })
        .join("");

      tableWrap.innerHTML = `<table class="proc-table">
        <thead><tr><th>协议</th><th>本地地址</th><th>远端</th><th>状态</th><th>PID</th><th>进程</th></tr></thead>
        <tbody>${
          rows ||
          `<tr><td colspan="6" class="proc-empty">没有匹配的端口${
            q
              ? `（搜索：${esc(query.trim())}）`
              : hideRules.length
                ? "（隐藏规则生效中）"
                : ""
          }</td></tr>`
        }</tbody>
      </table>`;
    }
    tableWrap.scrollTop = scrollTop;

    renderDetail(procByPid, portsByPid, sessionMap);
  };

  const badges = (p: ProcInfo, session: string | undefined): string => {
    const out: string[] = [];
    if (p.isSelf) out.push('<span class="proc-badge self" title="AppDeck 自身，不能结束">本程序</span>');
    if (session) {
      out.push(
        `<span class="proc-badge session" title="由 AppDeck 启动：${esc(session)}">会话</span>`,
      );
    }
    if (p.system) out.push('<span class="proc-badge system" title="Windows 核心 / 关键进程，不可结束">系统</span>');
    else if (p.service)
      out.push('<span class="proc-badge service" title="其他会话的第三方服务；需要管理员权限才能结束">服务</span>');
    if (isDevName(p.name)) out.push('<span class="proc-badge dev" title="常见开发运行时">开发</span>');
    return out.join("");
  };

  const renderDetail = (
    procByPid: Map<number, ProcInfo>,
    portsByPid: Map<number, PortInfo[]>,
    sessionMap: Map<number, string>,
  ): void => {
    const p = selectedPid != null ? procByPid.get(selectedPid) : undefined;
    if (!p) {
      selectedPid = null;
      detail.innerHTML = `<div class="proc-detail-empty">选择一行查看详情<br/><span>系统 / 服务进程默认隐藏，可打开上方「显示系统/服务」</span></div>`;
      killBtn.disabled = true;
      killTreeBtn.disabled = true;
      killBtn.title = killTreeBtn.title = "先选择一行";
      return;
    }

    const ports = (portsByPid.get(p.pid) ?? []).filter(isListening);
    const portNums = Array.from(new Set(ports.map((x) => x.localPort))).sort((a, b) => a - b);
    const uptime = fmtUptime(p.startedAtMs);
    const disabled = p.system || p.isSelf;
    const why = p.isSelf
      ? "不能结束 AppDeck 自身"
      : p.system
        ? "Windows 核心 / 关键进程，已禁用结束"
        : p.service
          ? "第三方服务：可尝试结束；非管理员会提示权限不足"
          : "结束该进程";

    detail.innerHTML = `
      <div class="proc-detail-name">${esc(p.name)}${badges(p, sessionMap.get(p.pid))}</div>
      <div class="proc-detail-sub">PID ${p.pid}${p.ppid ? ` · 父进程 ${p.ppid}` : ""}</div>
      <div class="proc-kv"><span>用户</span><b title="${esc(p.user ?? "")}">${esc(p.user ?? "—")}</b></div>
      <div class="proc-kv"><span>内存</span><b>${fmtBytes(p.memoryBytes)}</b></div>
      <div class="proc-kv"><span>CPU</span><b>${p.cpuPercent.toFixed(1)}%</b></div>
      <div class="proc-kv"><span>启动</span><b>${fmtWhen(p.startedAtMs)}${
        uptime ? `（${uptime}）` : ""
      }</b></div>
      <div class="proc-kv"><span>路径</span><b class="proc-path" title="${esc(
        p.exe ?? "",
      )}">${esc(p.exe ?? "—")}</b></div>
      <div class="proc-detail-label">监听端口</div>
      <div class="proc-port-chips">${
        portNums.length
          ? portNums.map((n) => `<span class="proc-port-chip">${n}</span>`).join("")
          : '<span class="proc-dim">无</span>'
      }</div>
      <div class="proc-actions">
        ${p.exe ? '<button class="btn btn-tiny" data-act="reveal">在资源管理器中显示</button>' : ""}
        ${p.exe ? '<button class="btn btn-tiny" data-act="copy">复制路径</button>' : ""}
      </div>
    `;

    const exe = p.exe;
    detail.querySelector('[data-act="reveal"]')?.addEventListener("click", () => {
      if (!exe) return;
      void revealItemInDir(exe).catch((e) => deps.notify(String(e), "error"));
    });
    detail.querySelector('[data-act="copy"]')?.addEventListener("click", () => {
      if (!exe) return;
      void navigator.clipboard
        .writeText(exe)
        .then(() => deps.notify("路径已复制"))
        .catch((e) => deps.notify(String(e), "error"));
    });

    killBtn.disabled = disabled;
    killTreeBtn.disabled = disabled;
    killBtn.title = killTreeBtn.title = why;
  };

  /* ---------------- 交互 ---------------- */

  search.addEventListener("input", () => {
    query = search.value;
    render();
  });

  for (const btn of Array.from(
    overlay.querySelectorAll<HTMLButtonElement>(".proc-tab"),
  )) {
    btn.addEventListener("click", () => {
      tab = (btn.dataset.tab as Tab) ?? "processes";
      for (const b of Array.from(overlay.querySelectorAll(".proc-tab"))) {
        b.classList.toggle("active", b === btn);
      }
      render();
    });
  }

  const bindCheck = (sel: string, fn: (on: boolean) => void): void => {
    const el = $<HTMLInputElement>(sel);
    el.addEventListener("change", () => {
      fn(el.checked);
      render();
    });
  };
  bindCheck("#proc-only-port", (on) => (onlyPort = on));
  bindCheck("#proc-only-listen", (on) => (onlyListening = on));
  bindCheck("#proc-only-dev", (on) => (onlyDev = on));
  bindCheck("#proc-show-system", (on) => (showSystem = on));

  $<HTMLButtonElement>("#proc-refresh").addEventListener("click", () => void load());

  autoRefreshEl.addEventListener("change", () => {
    autoRefresh = autoRefreshEl.checked;
    markPrefsDirty();
    render();
    if (autoRefresh) void load();
  });

  rulesEnabledEl.addEventListener("change", () => {
    hideRulesEnabled = rulesEnabledEl.checked;
    syncRulesUi();
    markPrefsDirty();
    render();
  });

  rulesToggle.addEventListener("click", () => {
    rulesOpen = !rulesOpen;
    syncRulesUi();
    if (rulesOpen) rulesInput.focus();
  });

  rulesInput.addEventListener("input", () => {
    hideRules = normalizeRules(rulesInput.value.split(/\r?\n/));
    syncRulesUi();
    markPrefsDirty();
    render();
  });

  tableWrap.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const th = target.closest<HTMLElement>("th[data-sort]");
    if (th) {
      const key = th.dataset.sort as SortKey;
      if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortKey = key;
        // 名称/PID 升序更自然；内存/CPU/端口数默认降序
        sortDir = key === "name" || key === "pid" ? 1 : -1;
      }
      render();
      return;
    }

    const row = target.closest<HTMLElement>("tr[data-pid]");
    if (row) {
      const pid = Number(row.dataset.pid);
      if (!Number.isNaN(pid)) {
        selectedPid = pid;
        render();
      }
    }
  });

  const askKill = (p: ProcInfo, defaultTree: boolean): void => {
    if (p.system || p.isSelf) return;

    const layer = document.createElement("div");
    layer.className = "modal-overlay proc-confirm";
    layer.innerHTML = `
      <div class="modal" style="width: 500px">
        <div class="modal-head">
          <span>结束进程</span>
          <button class="modal-x" title="关闭">×</button>
        </div>
        <div class="modal-body">
          <div class="proc-kill-title">${esc(p.name)} <span class="proc-dim">PID ${p.pid}</span></div>
          <div class="set-desc proc-path">${esc(p.exe ?? "路径不可读")}</div>
          <div class="proc-warn">强制结束会立即丢弃该进程未保存的数据。系统关键进程会被自动拒绝。</div>
          <label class="proc-check">
            <input type="checkbox" id="proc-kill-tree" ${defaultTree ? "checked" : ""} />
            同时结束子进程（进程树）
          </label>
          <div class="proc-kill-hint" id="proc-kill-hint"></div>
        </div>
        <div class="modal-foot">
          <span class="flex1"></span>
          <button class="btn" id="proc-kill-cancel">取消</button>
          <button class="btn danger" id="proc-kill-go">结束进程</button>
        </div>
      </div>
    `;
    document.body.appendChild(layer);

    const input = layer.querySelector("#proc-kill-tree") as HTMLInputElement;
    const hint = layer.querySelector("#proc-kill-hint") as HTMLDivElement;
    const go = layer.querySelector("#proc-kill-go") as HTMLButtonElement;

    const closeLayer = (): void => layer.remove();
    layer.querySelector(".modal-x")?.addEventListener("click", closeLayer);
    layer.querySelector("#proc-kill-cancel")?.addEventListener("click", closeLayer);
    layer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeLayer();
      }
    });

    go.addEventListener("click", () => {
      void (async () => {
        go.disabled = true;
        hint.textContent = "正在结束…";
        try {
          const report = await invoke<KillReport>("process_kill", {
            pid: p.pid,
            expectStartMs: p.startedAtMs,
            tree: input.checked,
          });
          closeLayer();
          selectedPid = null;
          if (report.failed.length) {
            deps.notify(
              `已结束 ${report.killed.length} 个；${report.failed.length} 个未结束：${report.failed[0].error}`,
              "info",
            );
          } else {
            deps.notify(`已结束 ${report.killed.length} 个进程（${p.name}）`);
          }
          await load();
        } catch (e) {
          hint.textContent = String(e);
          go.disabled = false;
        }
      })();
    });

    (layer.querySelector("#proc-kill-go") as HTMLButtonElement | null)?.focus();
  };

  killBtn.addEventListener("click", () => {
    const p = selectedPid != null && snapshot ? snapshot.processes.find((x) => x.pid === selectedPid) : undefined;
    if (p) askKill(p, false);
  });
  killTreeBtn.addEventListener("click", () => {
    const p = selectedPid != null && snapshot ? snapshot.processes.find((x) => x.pid === selectedPid) : undefined;
    if (p) askKill(p, true);
  });

  /* ---------------- 右键菜单 ---------------- */

  const showProcessMenu = (ev: MouseEvent, p: ProcInfo): void => {
    closeContextMenu();
    // 右键同时选中该行，菜单和详情指向同一个进程
    selectedPid = p.pid;
    render();

    const killDisabled = p.system || p.isSelf;
    const killNote = p.isSelf
      ? "不能结束 AppDeck 自身"
      : p.system
        ? "系统关键进程，不可结束"
        : "强制结束该进程";

    const menu = document.createElement("div");
    menu.className = "device-menu proc-context";
    menu.style.left = "8px";
    menu.style.top = "8px";
    menu.innerHTML = `
      <div class="dm-head">
        <span class="proc-menu-title">${esc(p.name)}</span>
        <span class="dm-tag">PID ${p.pid}</span>
      </div>
      <div class="dm-body">
        <div class="dm-item" data-act="hide">
          <span class="dm-name">隐藏此进程</span>
          <span class="dm-sub">加入隐藏规则，可在「隐藏规则」里撤销</span>
        </div>
        <div class="dm-sep"></div>
        <div class="dm-item${killDisabled ? " disabled" : ""}" data-act="kill">
          <span class="dm-name">结束进程</span>
          <span class="dm-sub">${esc(killNote)}</span>
        </div>
        <div class="dm-item${killDisabled ? " disabled" : ""}" data-act="kill-tree">
          <span class="dm-name">结束进程树</span>
          <span class="dm-sub">连同子进程一起结束</span>
        </div>
        ${
          p.exe
            ? `<div class="dm-sep"></div>
        <div class="dm-item" data-act="reveal"><span class="dm-name">在资源管理器中显示</span></div>
        <div class="dm-item" data-act="copy"><span class="dm-name">复制路径</span></div>`
            : ""
        }
        <div class="dm-item" data-act="pid"><span class="dm-name">复制 PID</span></div>
      </div>
    `;
    document.body.appendChild(menu);
    contextMenu = menu;

    const left = Math.max(
      8,
      Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8),
    );
    const top = Math.max(
      8,
      Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    menu.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(".dm-item[data-act]");
      if (!item || item.classList.contains("disabled")) return;
      const act = item.dataset.act;
      closeContextMenu();

      if (act === "hide") {
        hideProcess(p);
      } else if (act === "kill") {
        askKill(p, false);
      } else if (act === "kill-tree") {
        askKill(p, true);
      } else if (act === "reveal") {
        if (p.exe) {
          void revealItemInDir(p.exe).catch((err) => deps.notify(String(err), "error"));
        }
      } else if (act === "copy") {
        if (p.exe) {
          void navigator.clipboard
            .writeText(p.exe)
            .then(() => deps.notify("路径已复制"))
            .catch((err) => deps.notify(String(err), "error"));
        }
      } else if (act === "pid") {
        void navigator.clipboard
          .writeText(String(p.pid))
          .then(() => deps.notify("PID 已复制"))
          .catch((err) => deps.notify(String(err), "error"));
      }
    });
  };

  const onDocMouseDown = (e: MouseEvent): void => {
    if (contextMenu && !contextMenu.contains(e.target as Node)) closeContextMenu();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    // 菜单在 body 上，Esc 不一定能冒泡到面板；用捕获阶段先关菜单
    if (e.key === "Escape" && contextMenu) {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    }
  };
  document.addEventListener("mousedown", onDocMouseDown);
  document.addEventListener("keydown", onDocKeyDown, true);
  window.addEventListener("resize", closeContextMenu);
  tableWrap.addEventListener("scroll", closeContextMenu, { passive: true });

  tableWrap.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("tr[data-pid]");
    if (!row) return;
    e.preventDefault();
    const pid = Number(row.dataset.pid);
    const p = snapshot?.processes.find((x) => x.pid === pid);
    if (p) showProcessMenu(e, p);
  });

  // 初始
  search.focus();
  void load();
}
