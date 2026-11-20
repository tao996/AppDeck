/* ============================================================
   AppDeck — Schedule（由 main.ts 拆分而来）
   ============================================================ */
import { activeSessionId, esc, req, scheduleLogHitsCapped, scheduleLogJumpNext, scheduleLogMatchIndex, scheduleLogMatches, scheduleLogQuery, schedulePaneBusy, schedulePaneLogText, schedulePaneReady, schedulePaneTasks, schedulePaneTick, schedulePaneTimer, scheduleSelectedId, scheduleTabActive, scheduleTabOpen, sessions, setScheduleLogHitsCapped, setScheduleLogJumpNext, setScheduleLogMatchIndex, setScheduleLogMatches, setScheduleLogQuery, setSchedulePaneBusy, setSchedulePaneLogText, setSchedulePaneReady, setSchedulePaneTasks, setSchedulePaneTimer, setSchedulePaneTick, setScheduleSelectedId, setScheduleTabActive, setScheduleTabOpen, setState, showSchedulePane, state, toast } from "./core";
import { activateSession, renderTabs, updateControls, updateEmptyState } from "./terminal";
import { renderStatus } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ScheduleRunEvent, ScheduledTask, ScheduledTaskView, State } from "./core";

export let scheduleRefresh: (() => void) | null = null;

/**
 * cron 预设统一用 6 段（秒 分 时 日 月 周），方便开发环境做秒级任务。
 * 5 段（分 时 日 月 周）仍兼容，秒按 0 处理。
 */
export const SCHEDULE_CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "每 5 秒", cron: "*/5 * * * * *" },
  { label: "每 10 秒", cron: "*/10 * * * * *" },
  { label: "每 30 秒", cron: "*/30 * * * * *" },
  { label: "每分钟", cron: "0 * * * * *" },
  { label: "每 5 分钟", cron: "0 */5 * * * *" },
  { label: "每小时", cron: "0 0 * * * *" },
  { label: "每天 03:00", cron: "0 0 3 * * *" },
  { label: "每周一 09:00", cron: "0 0 9 * * 1" },
  { label: "每月 1 号", cron: "0 0 0 1 * *" },
];

export function cronLabel(cron: string): string {
  const raw = cron.trim();
  // 老任务可能是 5 段：补一个秒字段再查预设，显示仍然用原始表达式
  const lookup = raw.split(/\s+/).length === 5 ? `0 ${raw}` : raw;
  const hit = SCHEDULE_CRON_PRESETS.find((p) => p.cron === lookup);
  return hit ? `${hit.label}（${raw}）` : raw;
}

/** 本地时间：今天 / 明天 / 月-日 时:分:秒 */
export function scheduleWhen(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const hms = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
    2,
    "0",
  )}:${String(d.getSeconds()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hms}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hms}`;
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")} ${hms}`;
  }
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${hms}`;
}

export function scheduleIn(ms: number): string {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "即将";
  const total = Math.floor(diff / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function scheduleDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分`;
}

export function scheduleStatus(status: string | null): { icon: string; text: string; cls: string } {
  switch (status) {
    case "running":
      return { icon: "🟡", text: "运行中", cls: "run" };
    case "success":
      return { icon: "✅", text: "上次成功", cls: "ok" };
    case "failed":
      return { icon: "❌", text: "上次失败", cls: "bad" };
    case "timeout":
      return { icon: "⏱", text: "上次超时", cls: "bad" };
    case "interrupted":
      return { icon: "⛔", text: "上次被停止", cls: "warn" };
    case "skipped":
      return { icon: "⏭", text: "上次跳过", cls: "warn" };
    default:
      return { icon: "·", text: "还没运行过", cls: "" };
  }
}

export function scheduleStatusText(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "timeout":
      return "超时";
    case "interrupted":
      return "被停止";
    case "skipped":
      return "已跳过";
    default:
      return status;
  }
}

export function scheduleLastText(t: ScheduledTaskView): string {
  if (t.running) return "🟡 运行中…";
  const st = scheduleStatus(t.lastStatus);
  let text = `${st.icon} ${st.text}`;
  if (
    t.lastStatus &&
    t.lastStatus !== "skipped" &&
    t.lastExitCode != null &&
    t.lastExitCode !== 0
  ) {
    text += `（退出码 ${t.lastExitCode}）`;
  }
  if (t.lastStatus && t.lastMs > 0) text += ` · ${scheduleDuration(t.lastMs)}`;
  return text;
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
  refresh: () => void,
): Promise<void> {
  setState(await invoke<State>("set_scheduled_task_enabled", { id, enabled }));
  refresh();
}

export async function notifyScheduleRun(ev: ScheduleRunEvent): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;

    const title =
      ev.status === "success"
        ? "循环任务完成"
        : ev.status === "skipped"
          ? "循环任务跳过"
          : "循环任务失败";
    const bits = [scheduleStatusText(ev.status)];
    if (ev.exitCode != null) bits.push(`退出码 ${ev.exitCode}`);
    if (ev.reason) bits.push(ev.reason);
    sendNotification({ title: `${title} · ${ev.taskName}`, body: bits.join(" · ") });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

/* ---------------- 循环任务：整页面板（tabstrip 里的非终端 tab） ---------------- */

export function openScheduleTab(): void {
  if (!scheduleTabOpen) {
    setScheduleTabOpen(true);
    ensureSchedulePane();
  }
  activateScheduleTab();
}

export function ensureSchedulePane(): void {
  if (schedulePaneReady) return;
  setSchedulePaneReady(true);

  const listEl = req<HTMLDivElement>("#sched-pane-list");
  const newBtn = req<HTMLButtonElement>("#sched-pane-new");
  const findBtn = req<HTMLButtonElement>("#sched-pane-find");
  const clearBtn = req<HTMLButtonElement>("#sched-pane-clear");
  const editBtn = req<HTMLButtonElement>("#sched-pane-edit");
  const revealBtn = req<HTMLButtonElement>("#sched-pane-reveal");
  const searchInput = req<HTMLInputElement>("#sched-log-search-input");

  newBtn.addEventListener("click", () => {
    void openScheduleEditor(null, () => void refreshSchedulePane("both"));
  });

  listEl.addEventListener("click", (e) => {
    const toggle = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-toggle]");
    if (toggle) {
      e.stopPropagation();
      const id = toggle.dataset.toggle ?? "";
      void setScheduleEnabled(id, toggle.checked, () =>
        void refreshSchedulePane("both"),
      ).catch((err) => {
        toggle.checked = !toggle.checked;
        toast(String(err), "error");
      });
      return;
    }

    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-task]");
    const id = row?.dataset.task ?? "";
    if (!id || id === scheduleSelectedId) return;
    setScheduleSelectedId(id);
    setSchedulePaneLogText("");
    setScheduleLogMatchIndex(-1);
    setScheduleLogJumpNext(true);
    renderScheduleList();
    updateSchedulePaneHead();
    // 切换任务立刻拉一次日志，不等下一个 tick
    void refreshSchedulePane("log");
  });

  findBtn.addEventListener("click", () => {
    const bar = document.querySelector<HTMLDivElement>("#sched-log-search");
    if (bar && !bar.hidden) closeScheduleLogSearch();
    else openScheduleLogSearch();
  });
  clearBtn.addEventListener("click", () => void clearScheduleLog());
  searchInput.addEventListener("input", () => updateScheduleLogSearch());
  searchInput.addEventListener("keydown", (e) => {
    // 搜索框里的按键不能漏给全局 Esc / 菜单
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      stepScheduleLogHit(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeScheduleLogSearch();
    }
  });
  req<HTMLButtonElement>("#sched-log-search-prev").addEventListener("click", () =>
    stepScheduleLogHit(-1),
  );
  req<HTMLButtonElement>("#sched-log-search-next").addEventListener("click", () =>
    stepScheduleLogHit(1),
  );
  req<HTMLButtonElement>("#sched-log-search-close").addEventListener("click", () =>
    closeScheduleLogSearch(),
  );

  editBtn.addEventListener("click", () => {
    const task = selectedScheduleTask();
    if (task) void openScheduleEditor(task, () => void refreshSchedulePane("both"));
  });
  revealBtn.addEventListener("click", () => {
    const task = selectedScheduleTask();
    if (!task) return;
    void (async () => {
      try {
        const path = await invoke<string>("scheduled_task_log_path", { taskId: task.id });
        await revealItemInDir(path);
      } catch (e) {
        toast(String(e), "error");
      }
    })();
  });

  scheduleRefresh = () => void refreshSchedulePane("both");
}

export async function refreshSchedulePane(what: "both" | "list" | "log"): Promise<void> {
  if (!scheduleTabOpen || schedulePaneBusy) return;
  setSchedulePaneBusy(true);
  try {
    if (what !== "log") {
      setSchedulePaneTasks(await invoke<ScheduledTaskView[]>("list_scheduled_tasks"));
      // 任务被删 / 首次进入：自动选一个（优先运行中的）
      if (
        !scheduleSelectedId ||
        !schedulePaneTasks.some((t) => t.id === scheduleSelectedId)
      ) {
        const nextId =
          schedulePaneTasks.find((t) => t.running)?.id ??
          schedulePaneTasks[0]?.id ??
          null;
        if (nextId !== scheduleSelectedId) setScheduleLogJumpNext(true);
        setScheduleSelectedId(nextId);
        setSchedulePaneLogText("");
      }
      renderScheduleList();
      updateSchedulePaneHead();
    }
    if (what !== "list") {
      await loadScheduleLog();
    }
  } catch (e) {
    const listEl = document.querySelector<HTMLDivElement>("#sched-pane-list");
    if (listEl) listEl.innerHTML = `<div class="sched-empty">${esc(String(e))}</div>`;
  } finally {
    setSchedulePaneBusy(false);
  }
}

export function selectedScheduleTask(): ScheduledTaskView | undefined {
  return schedulePaneTasks.find((t) => t.id === scheduleSelectedId);
}

export function renderScheduleList(): void {
  const listEl = document.querySelector<HTMLDivElement>("#sched-pane-list");
  if (!listEl) return;

  const countEl = document.querySelector<HTMLSpanElement>("#sched-pane-count");
  if (countEl) {
    countEl.textContent = schedulePaneTasks.length
      ? `${schedulePaneTasks.filter((t) => t.enabled).length} 启用`
      : "";
  }

  if (schedulePaneTasks.length === 0) {
    listEl.innerHTML = `
      <div class="sched-empty">
        还没有循环任务。<br />
        点右上角「＋ 新建」建一条。<br />
        应用退出后任务会停止。
      </div>`;
    return;
  }

  listEl.innerHTML = schedulePaneTasks
    .map((t) => {
      const st = scheduleStatus(t.running ? "running" : t.lastStatus);
      const dot = t.enabled ? "run" : "idle";
      const sub = t.enabled
        ? `${cronLabel(t.cron)} · ${t.nextAt ? scheduleWhen(t.nextAt) : "永不触发"}`
        : "已停用";
      return `
        <div class="sched-pane-item${t.id === scheduleSelectedId ? " on" : ""}" data-task="${esc(
          t.id,
        )}" title="${esc(`${t.command.program} ${t.command.args}`)}">
          <span class="dot ${dot}"></span>
          <div class="sched-pane-item-main">
            <div class="sched-pane-item-name">${esc(t.name)}</div>
            <div class="sched-pane-item-sub">${esc(sub)}</div>
            <div class="sched-pane-item-sub">${st.icon} ${esc(st.text)}</div>
          </div>
          <input type="checkbox" data-toggle="${esc(t.id)}" ${
            t.enabled ? "checked" : ""
          } title="${t.enabled ? "停用（会结束当前运行）" : "启用"}" />
        </div>`;
    })
    .join("");
}

export function updateSchedulePaneHead(): void {
  const task = selectedScheduleTask();
  const title = document.querySelector<HTMLSpanElement>("#sched-pane-title");
  const sub = document.querySelector<HTMLSpanElement>("#sched-pane-sub");
  const find = document.querySelector<HTMLButtonElement>("#sched-pane-find");
  const clear = document.querySelector<HTMLButtonElement>("#sched-pane-clear");
  const edit = document.querySelector<HTMLButtonElement>("#sched-pane-edit");
  const reveal = document.querySelector<HTMLButtonElement>("#sched-pane-reveal");

  if (!task) {
    if (title) title.textContent = "选择一个任务";
    if (sub) sub.textContent = "";
  } else {
    if (title) title.textContent = task.name;
    if (sub) {
      const next = task.enabled
        ? task.nextAt
          ? `下次 ${scheduleWhen(task.nextAt)}（${scheduleIn(task.nextAt)}）`
          : "永不触发"
        : "已停用";
      const last = task.running ? "运行中" : scheduleLastText(task);
      sub.textContent = `${cronLabel(task.cron)} · ${next} · ${last}`;
      sub.title = `${task.command.program} ${task.command.args}`;
    }
  }

  if (find) find.disabled = !task;
  if (clear) clear.disabled = !task;
  if (edit) edit.disabled = !task;
  if (reveal) reveal.disabled = !task;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function openScheduleLogSearch(): void {
  if (!scheduleSelectedId) {
    toast("先在左侧选择一个任务", "error");
    return;
  }
  const bar = document.querySelector<HTMLDivElement>("#sched-log-search");
  const input = document.querySelector<HTMLInputElement>("#sched-log-search-input");
  if (!bar || !input) return;
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) updateScheduleLogSearch();
}

export function closeScheduleLogSearch(): void {
  const bar = document.querySelector<HTMLDivElement>("#sched-log-search");
  const input = document.querySelector<HTMLInputElement>("#sched-log-search-input");
  if (bar) bar.hidden = true;
  if (input) input.value = "";
  setScheduleLogQuery("");
  setScheduleLogMatches([]);
  setScheduleLogMatchIndex(-1);
  setScheduleLogHitsCapped(false);
  setScheduleLogJumpNext(false);
  renderScheduleLogView(false, false);
}

export function updateScheduleLogSearch(): void {
  const input = document.querySelector<HTMLInputElement>("#sched-log-search-input");
  setScheduleLogQuery(input?.value ?? "");
  setScheduleLogMatchIndex(-1);
  recomputeScheduleLogMatches(false);
  renderScheduleLogView(true, false);
}

export function stepScheduleLogHit(delta: number): void {
  if (scheduleLogMatches.length === 0) return;
  setScheduleLogMatchIndex(
    (scheduleLogMatchIndex + delta + scheduleLogMatches.length) %
    scheduleLogMatches.length);
  renderScheduleLogView(true, false);
}

export function recomputeScheduleLogMatches(keepIndex: boolean): void {
  setScheduleLogMatches([]);
  setScheduleLogHitsCapped(false);

  if (!scheduleLogQuery || !schedulePaneLogText) {
    setScheduleLogMatchIndex(-1);
    return;
  }

  const re = new RegExp(escapeRegExp(scheduleLogQuery), "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(schedulePaneLogText)) !== null) {
    scheduleLogMatches.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex += 1;
    if (scheduleLogMatches.length >= 1000) {
      // 只高亮前 1000 个，避免超大日志把 DOM 撑爆
      setScheduleLogHitsCapped(re.exec(schedulePaneLogText) !== null);
      break;
    }
  }

  if (scheduleLogMatches.length === 0) {
    setScheduleLogMatchIndex(-1);
  } else if (keepIndex) {
    setScheduleLogMatchIndex(Math.min(
      Math.max(scheduleLogMatchIndex, 0),
      scheduleLogMatches.length - 1,
    ));
  } else {
    setScheduleLogMatchIndex(0);
  }
}

export function updateScheduleLogSearchCount(): void {
  const el = document.querySelector<HTMLSpanElement>("#sched-log-search-count");
  if (!el) return;
  if (!scheduleLogQuery) {
    el.textContent = "0 个";
    el.classList.remove("none");
    return;
  }
  if (scheduleLogMatches.length === 0) {
    el.textContent = "0 个";
    el.classList.add("none");
    return;
  }
  el.classList.remove("none");
  el.textContent = `${scheduleLogMatchIndex + 1}/${scheduleLogMatches.length}${
    scheduleLogHitsCapped ? "+" : ""
  }`;
}

export function scrollToCurrentScheduleHit(el: HTMLPreElement): void {
  const hit = el.querySelector<HTMLElement>(".sched-hit.current");
  if (!hit) return;
  const hr = hit.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (hr.top < er.top || hr.bottom > er.bottom) {
    el.scrollTop += hr.top - er.top - el.clientHeight / 3;
  }
}

/** 渲染日志：无搜索时纯文本；有搜索时用 <mark> 高亮，并保留滚动位置 */
export function renderScheduleLogView(jump: boolean, follow: boolean): void {
  const el = document.querySelector<HTMLPreElement>("#sched-pane-log");
  if (!el) return;

  const raw = schedulePaneLogText;
  const scrollTop = el.scrollTop;

  if (!scheduleLogQuery) {
    el.textContent = raw || (scheduleSelectedId ? "" : "选择左侧任务查看日志");
    updateScheduleLogSearchCount();
    if (follow) el.scrollTop = el.scrollHeight;
    else el.scrollTop = scrollTop;
    return;
  }

  if (!raw) {
    el.textContent = "";
    updateScheduleLogSearchCount();
    return;
  }

  const qlen = scheduleLogQuery.length;
  const parts: string[] = [];
  let last = 0;
  for (let i = 0; i < scheduleLogMatches.length; i += 1) {
    const idx = scheduleLogMatches[i];
    if (idx < last) continue;
    parts.push(esc(raw.slice(last, idx)));
    const cls = i === scheduleLogMatchIndex ? " current" : "";
    parts.push(
      `<mark class="sched-hit${cls}">${esc(raw.slice(idx, idx + qlen))}</mark>`,
    );
    last = idx + qlen;
  }
  parts.push(esc(raw.slice(last)));
  el.innerHTML = parts.join("");

  updateScheduleLogSearchCount();
  if (jump) scrollToCurrentScheduleHit(el);
  else el.scrollTop = scrollTop;
}

export async function clearScheduleLog(): Promise<void> {
  const task = selectedScheduleTask();
  if (!task) return;
  try {
    await invoke("clear_task_log", { taskId: task.id });
    setSchedulePaneLogText("");
    setScheduleLogMatches([]);
    setScheduleLogMatchIndex(-1);
    setScheduleLogHitsCapped(false);
    setScheduleLogJumpNext(false);
    renderScheduleLogView(false, false);
    toast("日志已清空");
  } catch (e) {
    toast(String(e), "error");
  }
}

export async function loadScheduleLog(): Promise<void> {
  const el = document.querySelector<HTMLPreElement>("#sched-pane-log");
  if (!el) return;

  if (!scheduleSelectedId) {
    if (schedulePaneLogText !== "") {
      setSchedulePaneLogText("");
      renderScheduleLogView(false, false);
    }
    return;
  }

  try {
    const text = await invoke<string>("read_task_log", {
      taskId: scheduleSelectedId,
      tailBytes: 200_000,
    });
    if (text === schedulePaneLogText) return;

    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    setSchedulePaneLogText(text);
    // 搜索中不自动跟到底部，避免打断查看命中；未搜索时保持原来的跟随行为
    if (scheduleLogQuery) {
      recomputeScheduleLogMatches(true);
      const jump = scheduleLogJumpNext;
      setScheduleLogJumpNext(false);
      renderScheduleLogView(jump, false);
    } else {
      setScheduleLogJumpNext(false);
      renderScheduleLogView(false, atBottom);
    }
  } catch (e) {
    setSchedulePaneLogText(String(e));
    setScheduleLogMatches([]);
    setScheduleLogMatchIndex(-1);
    renderScheduleLogView(false, false);
  }
}

export function startSchedulePaneTimer(): void {
  if (schedulePaneTimer !== null) return;
  setSchedulePaneTimer(window.setInterval(() => {
    if (!scheduleTabOpen || !scheduleTabActive) return;
    setSchedulePaneTick(schedulePaneTick + 1);
    // 日志每秒刷新；任务列表（状态 / 下次时间）每 3 秒刷新一次
    void refreshSchedulePane(schedulePaneTick % 3 === 0 ? "both" : "log");
  }, 1000));
}

export function stopSchedulePaneTimer(): void {
  if (schedulePaneTimer !== null) {
    window.clearInterval(schedulePaneTimer);
    setSchedulePaneTimer(null);
  }
}

export function activateScheduleTab(): void {
  if (!scheduleTabOpen) return;
  setScheduleTabActive(true);
  document.querySelector("#btn-schedule")?.classList.add("on");
  for (const s of sessions) s.pane?.classList.remove("active");
  showSchedulePane(true);
  renderTabs();
  renderStatus();
  updateControls();
  updateEmptyState();
  startSchedulePaneTimer();
  void refreshSchedulePane("both");
}

export function closeScheduleTab(): void {
  setScheduleTabOpen(false);
  setScheduleTabActive(false);
  stopSchedulePaneTimer();
  document.querySelector("#btn-schedule")?.classList.remove("on");
  showSchedulePane(false);
  if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) {
    activateSession(activeSessionId);
  } else {
    renderTabs();
    renderStatus();
    updateControls();
    updateEmptyState();
  }
}


export async function openScheduleEditor(
  existing: ScheduledTaskView | null,
  onSaved: () => void,
): Promise<void> {
  const draft = {
    name: existing?.name ?? "",
    program: existing?.command.program ?? "",
    args: existing?.command.args ?? "",
    cwd: existing?.command.cwd ?? "",
    cron: existing?.cron ?? "0 3 * * *",
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal sched-editor-modal">
      <div class="modal-head">
        <span>${existing ? "编辑循环任务" : "新建循环任务"}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="set-row">
          <label>名称</label>
          <div class="set-cell">
            <input class="set-input" id="sched-name" maxlength="80" placeholder="如 每晚打安卓包" autocomplete="off" spellcheck="false" />
          </div>
        </div>
        <div class="set-row">
          <label>从自定义命令</label>
          <div class="set-cell">
            <select class="set-input" id="sched-import"></select>
          </div>
        </div>
        <div class="set-desc">只是把程序 / 参数 / 工作目录带过来，不建立关联；之后改工具栏命令不会影响本任务。</div>
        <div class="set-row">
          <label>程序</label>
          <div class="set-cell">
            <input class="set-input" id="sched-program" placeholder="exe / bat / cmd / ps1 的完整路径，或 PATH 里的命令" spellcheck="false" autocomplete="off" />
            <button class="btn" id="sched-browse">浏览…</button>
          </div>
        </div>
        <div class="set-row">
          <label>参数</label>
          <div class="set-cell">
            <input class="set-input" id="sched-args" placeholder='空格分隔；含空格的参数用双引号，如 --name "My App"' spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <div class="set-row">
          <label>工作目录</label>
          <div class="set-cell">
            <input class="set-input" id="sched-cwd" placeholder="可空；默认用程序所在目录" spellcheck="false" autocomplete="off" />
            <button class="btn" id="sched-browse-cwd">浏览…</button>
          </div>
        </div>
        <div class="set-row">
          <label>计划</label>
          <div class="set-cell">
            <input class="set-input" id="sched-cron" placeholder="6 段：秒 分 时 日 月 周，如 */10 * * * * *；5 段仍兼容" spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <div class="sched-presets" id="sched-presets"></div>
        <div class="sched-preview" id="sched-preview"></div>
        <div class="set-row">
          <label>启用</label>
          <div class="set-cell">
            <label class="sched-check">
              <input type="checkbox" id="sched-enabled" /> 保存后立即参与调度
            </label>
          </div>
        </div>
        <details class="sched-advanced">
          <summary>高级策略</summary>
          <div class="set-row">
            <label>并发</label>
            <div class="set-cell">
              <select class="set-input" id="sched-overlap">
                <option value="skip">跳过（上次没跑完就跳过本次）</option>
                <option value="queue">排队（等上次结束后补跑一次）</option>
                <option value="kill">终止上一次，立即跑新的</option>
              </select>
            </div>
          </div>
          <div class="set-row">
            <label>错过</label>
            <div class="set-cell">
              <select class="set-input" id="sched-catch">
                <option value="skip">跳过（推荐）</option>
                <option value="once">补跑一次</option>
              </select>
            </div>
          </div>
          <div class="set-row">
            <label>超时</label>
            <div class="set-cell">
              <input class="set-input" id="sched-timeout" type="number" min="0" step="1" placeholder="0 = 不限" />
              <span class="sched-suffix">分钟</span>
            </div>
          </div>
          <div class="set-row">
            <label>通知</label>
            <div class="set-cell">
              <select class="set-input" id="sched-notify">
                <option value="onFailure">仅失败 / 超时</option>
                <option value="always">每次运行都通知</option>
                <option value="never">不通知</option>
              </select>
            </div>
          </div>
        </details>
        <div class="set-desc" id="sched-editor-hint">
          cron 支持 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）；6 段最小粒度 1 秒（开发环境用），按本地时间计算。参数不做 shell 解析（不支持管道 / 重定向），复杂逻辑请写 .bat / .ps1。
        </div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="sched-editor-msg"></span>
        <span class="flex1"></span>
        ${existing ? '<button class="btn" id="sched-del">删除</button>' : ""}
        <button class="btn" id="sched-cancel">取消</button>
        <button class="btn primary" id="sched-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameEl = req<HTMLInputElement>("#sched-name", overlay);
  const importEl = req<HTMLSelectElement>("#sched-import", overlay);
  const programEl = req<HTMLInputElement>("#sched-program", overlay);
  const argsEl = req<HTMLInputElement>("#sched-args", overlay);
  const cwdEl = req<HTMLInputElement>("#sched-cwd", overlay);
  const cronEl = req<HTMLInputElement>("#sched-cron", overlay);
  const enabledEl = req<HTMLInputElement>("#sched-enabled", overlay);
  const overlapEl = req<HTMLSelectElement>("#sched-overlap", overlay);
  const catchEl = req<HTMLSelectElement>("#sched-catch", overlay);
  const timeoutEl = req<HTMLInputElement>("#sched-timeout", overlay);
  const notifyEl = req<HTMLSelectElement>("#sched-notify", overlay);
  const previewEl = req<HTMLDivElement>("#sched-preview", overlay);
  const presetsEl = req<HTMLDivElement>("#sched-presets", overlay);
  const msg = req<HTMLSpanElement>("#sched-editor-msg", overlay);
  const saveBtn = req<HTMLButtonElement>("#sched-save", overlay);

  nameEl.value = draft.name;
  programEl.value = draft.program;
  argsEl.value = draft.args;
  cwdEl.value = draft.cwd;
  cronEl.value = draft.cron;
  enabledEl.checked = existing ? existing.enabled : true;
  overlapEl.value = existing?.overlap ?? "skip";
  catchEl.value = existing?.catchUp ?? "skip";
  timeoutEl.value = existing && existing.timeoutSecs > 0 ? String(existing.timeoutSecs / 60) : "";
  notifyEl.value = existing?.notify ?? "onFailure";

  // 从工具栏自定义命令带入字段（只是快照，不建立关联）
  const customs = state.customCommands ?? [];
  importEl.innerHTML =
    `<option value="">${customs.length ? "（可选）从工具栏自定义命令带入…" : "（工具栏里还没有自定义命令）"}</option>` +
    customs.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  importEl.addEventListener("change", () => {
    const hit = customs.find((c) => c.id === importEl.value);
    if (!hit) return;
    programEl.value = hit.target || hit.program;
    argsEl.value = hit.args;
    cwdEl.value = hit.cwd ?? "";
    if (!nameEl.value.trim()) nameEl.value = hit.name;
    importEl.value = "";
    msg.textContent = hit.target
      ? ""
      : hit.program.toLowerCase().endsWith(".lnk")
        ? "这条自定义命令是 .lnk 且尚未解析，请先解析或手填真实程序"
        : "";
  });

  presetsEl.innerHTML = SCHEDULE_CRON_PRESETS.map(
    (p) => `<button class="btn sched-preset" data-cron="${p.cron}">${p.label}</button>`,
  ).join("");
  presetsEl.querySelectorAll<HTMLButtonElement>("[data-cron]").forEach((b) => {
    b.addEventListener("click", () => {
      cronEl.value = b.dataset.cron ?? "";
      schedulePreview();
    });
  });

  let previewTimer: number | null = null;
  const preview = async (): Promise<void> => {
    const cron = cronEl.value.trim();
    if (!cron) {
      previewEl.className = "sched-preview";
      previewEl.textContent = "填写 cron 表达式后显示接下来的运行时间";
      return;
    }
    try {
      const list = await invoke<number[]>("preview_cron", { cron, count: 5 });
      previewEl.className = "sched-preview ok";
      previewEl.textContent = `接下来：${list.map((x) => scheduleWhen(x)).join(" · ")}`;
    } catch (e) {
      previewEl.className = "sched-preview bad";
      previewEl.textContent = String(e);
    }
  };
  const schedulePreview = (): void => {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void preview(), 250);
  };
  cronEl.addEventListener("input", schedulePreview);

  req<HTMLButtonElement>("#sched-browse", overlay).addEventListener("click", () => {
    void (async () => {
      try {
        const picked = await open({
          multiple: false,
          title: "选择程序 / 脚本",
          filters: [
            { name: "程序与脚本", extensions: ["exe", "bat", "cmd", "ps1"] },
            { name: "全部文件", extensions: ["*"] },
          ],
          defaultPath: programEl.value || undefined,
        });
        if (typeof picked !== "string") return;
        programEl.value = picked;
        if (!cwdEl.value.trim()) {
          const i = Math.max(picked.lastIndexOf("\\"), picked.lastIndexOf("/"));
          if (i > 0) cwdEl.value = picked.slice(0, i);
        }
      } catch (e) {
        msg.textContent = String(e);
      }
    })();
  });

  req<HTMLButtonElement>("#sched-browse-cwd", overlay).addEventListener("click", () => {
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
      } catch (e) {
        msg.textContent = String(e);
      }
    })();
  });

  const close = (): void => {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    overlay.remove();
  };

  const save = (): void => {
    void (async () => {
      const name = nameEl.value.trim();
      const program = programEl.value.trim();
      const cron = cronEl.value.trim();
      if (!name) {
        msg.textContent = "请填写名称";
        return;
      }
      if (!program) {
        msg.textContent = "请填写程序";
        return;
      }
      if (program.toLowerCase().endsWith(".lnk")) {
        msg.textContent = "循环任务不支持 .lnk，请填真实程序或 .bat/.cmd/.ps1";
        return;
      }
      if (!cron) {
        msg.textContent = "请填写 cron 表达式";
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        const task: ScheduledTask = {
          id: existing?.id ?? "",
          name,
          enabled: enabledEl.checked,
          cron,
          command: {
            program,
            args: argsEl.value.trim(),
            cwd: cwdEl.value.trim() || null,
          },
          notify: notifyEl.value,
          overlap: overlapEl.value,
          catchUp: catchEl.value,
          timeoutSecs: Math.max(0, Math.round(Number(timeoutEl.value) || 0) * 60),
          createdAt: existing?.createdAt ?? 0,
        };
        setState(await invoke<State>("upsert_scheduled_task", { task }));
        close();
        toast(existing ? "循环任务已更新" : "循环任务已创建");
        onSaved();
      } catch (e) {
        msg.textContent = String(e);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "保存";
      }
    })();
  };

  saveBtn.addEventListener("click", save);
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  req<HTMLButtonElement>("#sched-cancel", overlay).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
  });

  if (existing) {
    req<HTMLButtonElement>("#sched-del", overlay).addEventListener("click", () => {
      void (async () => {
        const ok = await confirm(`删除任务「${existing.name}」？正在运行的话会被停止。`, {
          title: "删除循环任务",
          kind: "warning",
        });
        if (!ok) return;
        try {
          setState(await invoke<State>("remove_scheduled_task", { id: existing.id }));
          close();
          toast("循环任务已删除");
          onSaved();
        } catch (e) {
          msg.textContent = String(e);
        }
      })();
    });
  }

  void preview();
  nameEl.focus();
}

/**
 * 启动时只读体检缓存，**绝不触发** `flutter doctor`（实测 20+ 秒）。
 * 没有缓存就保持"未体检"状态，等用户点工具栏的「体检」。
 */
