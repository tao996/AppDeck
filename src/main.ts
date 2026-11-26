/* ============================================================
   AppDeck — 应用入口（由 main.ts 拆分而来）
   ============================================================ */
import { openCommandDialog } from "./command-dialog";
import { openCustomCommandMenu } from "./commands";
import { activeSession, collapsed, editFile, openProjectFolder, req, scheduleSaveCollapsed, sessions, setState, setStatePath, state, toast } from "./core";
import { openDbInspector } from "./database";
import { loadCachedDoctor, openDoctorReport, openToolsMenu } from "./doctor";
import { closeEmuMenu, emuMenuEl, openEmulatorMenu, openImportMenu } from "./emulator";
import { runCommand, runTemplate, sendKey, stopActive } from "./launcher";
import { closeDeviceMenu, deviceMenuEl, openCommandMenu, showUsageExamples } from "./menus";
import { handleExit, handleOutput, openFilterPanel } from "./output";
import { openEnvDialog, openProcessPanel, openProjectTerminal, showFilingInfo } from "./panels";
import { autosaveSessions, rerunSession, restoreSessions, setSessionFilter } from "./persistence";
import { closeAllMenus, openProjectMenu, openTemplateImport, openTemplateManager, projMenuEl, setDevSubmenu, subMenuEl } from "./project-menu";
import { refreshFlutter } from "./projects";
import { notifyScheduleRun, openScheduleTab, scheduleRefresh } from "./schedule";
import { openSettings } from "./settings";
import { activateSession, clearActiveLog, closeLinkMenu, closeSearch, linkMenuEl, openLocation, openSearch, runSearch } from "./terminal";
import { render, renderTree } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { openUrl } from "@tauri-apps/plugin-opener";
import type { DevAutostart, ScheduleRunEvent, State } from "./core";
import type { ComposeImportResponse, NpmImportResponse } from "./projects";
import "@xterm/xterm/css/xterm.css";

export async function boot(): Promise<void> {
  const app = req<HTMLDivElement>("#app");

  app.innerHTML = `
    <div class="app">
      <header class="toolbar">
        <div class="tb-menu">
          <button class="btn menu-btn" id="btn-import-menu">导入 ▾</button>
          <button class="btn menu-btn" id="btn-custom-menu">自定义命令 ▾</button>
          <button class="btn menu-btn" id="btn-tools-menu">工具 ▾</button>
          <button class="btn menu-btn" id="btn-schedule">🔁 循环任务</button>
          <button class="btn menu-btn" id="btn-filter">🚫 终端过滤器</button>
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
              <label class="cbtn filter-toggle" id="filter-toggle-wrap" hidden title="只对新输出生效；仅 Flutter 终端可用">
                <input type="checkbox" id="btn-filter-toggle" />过滤
              </label>
              <button class="cbtn" id="btn-clear" disabled title="清空当前会话的日志（含回滚区；不影响进程）"><i class="hi">🧹</i>清空</button>
              <button class="cbtn" id="btn-open-proj" disabled title="用编辑器打开本会话的项目目录"><i class="hi">📂</i>项目</button>
            </span>
            <span class="flex1"></span>
            <span class="artifact-bar" id="artifact-bar"></span>
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

      <section class="schedule-pane" id="schedule-pane">
        <aside class="sched-pane-side">
          <div class="sched-pane-side-head">
            <span>任务列表</span>
            <span class="dim" id="sched-pane-count"></span>
            <button class="btn" id="sched-pane-new">＋ 新建</button>
          </div>
          <div class="sched-pane-list" id="sched-pane-list"></div>
        </aside>
        <section class="sched-pane-main">
          <div class="sched-pane-head">
            <span class="sched-pane-title" id="sched-pane-title">选择一个任务</span>
            <span class="sched-pane-sub" id="sched-pane-sub"></span>
            <span class="flex1"></span>
            <button class="btn" id="sched-pane-find" disabled title="搜索日志（输入后 Enter 下一个）">🔍 搜索</button>
            <button class="btn" id="sched-pane-edit" disabled>编辑</button>
            <button class="btn" id="sched-pane-clear" disabled>清空日志</button>
            <button class="btn" id="sched-pane-reveal" disabled>打开日志目录</button>
          </div>
          <div class="sched-log-search" id="sched-log-search" hidden>
            <input
              id="sched-log-search-input"
              type="text"
              placeholder="搜索日志…"
              spellcheck="false"
              autocomplete="off"
            />
            <span class="ts-count" id="sched-log-search-count">0 个</span>
            <button class="ts-btn" id="sched-log-search-prev" title="上一个（Shift+Enter）">⌃</button>
            <button class="ts-btn" id="sched-log-search-next" title="下一个（Enter）">⌄</button>
            <button class="ts-btn" id="sched-log-search-close" title="关闭（Esc）">×</button>
          </div>
          <pre class="sched-pane-log" id="sched-pane-log">选择左侧任务查看日志</pre>
        </section>
      </section>

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

  // 循环任务：事件驱动刷新面板；跑完按任务的通知策略弹系统通知
  await listen<ScheduleRunEvent>("schedule://run", (e) => {
    scheduleRefresh?.();
    const p = e.payload;
    // 「开始运行」只用来更新状态，不通知
    if (p.status === "running") return;
    if (p.notify === "never") return;
    if (p.notify === "onFailure" && (p.status === "success" || p.status === "skipped")) {
      return;
    }
    void notifyScheduleRun(p);
  });
  await listen("schedule://changed", () => scheduleRefresh?.());

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
  req<HTMLButtonElement>("#btn-schedule").addEventListener("click", () => openScheduleTab());
  req<HTMLButtonElement>("#btn-filter").addEventListener("click", () => openFilterPanel());
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

  // 日志搜索 / 过滤 / 清空
  req<HTMLButtonElement>("#btn-find").addEventListener("click", () => openSearch());
  req<HTMLInputElement>("#btn-filter-toggle").addEventListener("change", (e) => {
    const s = activeSession();
    if (s) setSessionFilter(s, (e.currentTarget as HTMLInputElement).checked);
  });
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
    setState(s);
    setStatePath(loc);
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
            setState(res.state);
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
              setState(res.state);
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
            setState(res.state);
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
    setDevSubmenu(await invoke<string | null>("dev_env", { name: "FLA_SUBMENU" }));

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



















































































































