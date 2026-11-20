/* ============================================================
   AppDeck — Launcher（由 main.ts 拆分而来）
   ============================================================ */
import { activeSession, activeSessionId, pendingOutput, sessions, setActiveSessionId, toast } from "./core";
import { schedulePersist } from "./persistence";
import { activateSession, renderTabs, updateControls } from "./terminal";
import { renderStatus, selectCommand } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import type { Cmd, Proj, StartResponse, TermSession } from "./core";

export function isExternalSource(source: string | undefined): boolean {
  return source === "npm" || source === "docker" || source === "qt";
}

/** 命令是否按外部程序执行（与后端 `ops::external_program` 同一套判据）。
 *
 *  source 是首选；`kind=run` 但 program 不是 `.dart` 入口的也按外部程序算：
 *  旧版本「编辑命令」会把 source 覆盖成 manual，不兜底就会退化成
 *  `flutter run -t run.ps1`（Qt 工程报 No pubspec.yaml）。 */
export function isExternalCommand(c: Cmd): boolean {
  if (isExternalSource(c.source ?? undefined)) return true;
  const prog = (c.program ?? "").trim();
  return c.kind === "run" && prog !== "" && !prog.toLowerCase().endsWith(".dart");
}

export function isExternalRunSession(s: TermSession): boolean {
  return s.kind === "run" && (s.external === true || isExternalSource(s.source));
}

export function mountSession(
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
    external?: boolean;
  },
): TermSession {
  const external = origin?.external ?? isExternalSource(origin?.source);
  const externalRun = kind === "run" && external;
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
    external,
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
export function staleSessionFor(match: (s: TermSession) => boolean): TermSession | undefined {
  return sessions.find((s) => s.status === "stopped" && match(s));
}

/** 用新会话替换旧会话，并**保持旧会话在标签栏里的位置**。
 *  重跑 / 同一命令再次运行都走这里：直接关旧开新会把它追加到列表末尾，顺序就乱了。 */
export function replaceSessionInPlace(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const oldIdx = sessions.findIndex((s) => s.id === oldId);
  if (oldIdx < 0) return;
  if (!sessions.some((s) => s.id === newId)) return;

  const [old] = sessions.splice(oldIdx, 1);
  old.term?.dispose();
  old.pane?.remove();
  pendingOutput.delete(old.id);
  if (activeSessionId === old.id) setActiveSessionId(newId);
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
export function liveSessionFor(match: (s: TermSession) => boolean): TermSession | undefined {
  return sessions.find((s) => !s.restored && s.status !== "stopped" && match(s));
}

/** 正在启动的 key：双击 ▶ 时第二次点击往往早于第一次的会话挂载完成，
 *  此时 liveSessionFor 还看不到它，只能靠这个集合挡住。 */
export const launchingKeys = new Set<string>();

/** 返回 true 表示这次点击被吞掉（同一个 key 已经在启动中） */
export function markLaunching(key: string): boolean {
  if (launchingKeys.has(key)) {
    toast("正在启动，请稍候…");
    return true;
  }
  launchingKeys.add(key);
  return false;
}

export async function runCommand(p: Proj, c: Cmd, deviceId?: string): Promise<TermSession | null> {
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
      external: isExternalCommand(c),
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
export function projectShell(p: Proj): TermSession | undefined {
  const shells = sessions.filter(
    (s) => s.kind === "terminal" && s.projectId === p.id,
  );
  return shells.find((s) => s.status !== "stopped") ?? shells[0];
}

/** 同一项目的命令投递串行化：双击时第二次会等第一次把 shell 建好再复用，
 *  否则两个并发请求都看不到 shell，各开一个终端。 */
export const terminalQueue = new Map<string, Promise<unknown>>();

/** 自定义命令的「双击防抖」：鼠标双击会连发两次 click，
 *  第二个 click 不该把同一条命令再敲一遍（重跑传 reuse，不走这层）。 */
export const lastTerminalRun = new Map<string, number>();

export function runInTerminal(p: Proj, c: Cmd, reuse?: TermSession): Promise<TermSession | null> {
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
export async function runInTerminalNow(
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
export async function runTemplate(p: Proj, t: Cmd, deviceId?: string): Promise<void> {
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
      external: isExternalCommand(t),
    });
    if (stale && stale.id !== session.id) replaceSessionInPlace(stale.id, session.id);
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launchingKeys.delete(key);
  }
}

export function sendKey(data: string): void {
  const s = activeSession();
  if (!s) return;
  void invoke("write_session", { id: s.id, data }).catch(() => {});
}

export async function stopActive(): Promise<void> {
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

  // flutter run：q 是 flutter 自己的退出键，先礼后兵。
  // 但「启动中」时 flutter 还没开始读键盘（通常还在跑 gradle），q 会被吞掉或在
  // 命令结束后落到 shell 里，5 秒后强关标签看起来就像"终端崩了"。
  // 启动阶段直接结束进程树：退出事件会把标签标成已停止，历史保留。
  if (s.status === "starting") {
    await invoke("kill_session", { id: s.id }).catch(() => {});
    return;
  }

  sendKey("q");
  window.setTimeout(() => {
    const still = sessions.find((x) => x.id === s.id && x.status !== "stopped");
    // 兜底同样只结束进程、不关标签：谁也不希望点个停止标签就没了
    if (still) void invoke("kill_session", { id: s.id }).catch(() => {});
  }, 5000);
}
