/* ============================================================
   AppDeck — Persistence（由 main.ts 拆分而来）
   ============================================================ */
import { runCustomCommand } from "./commands";
import { pendingOutput, sessions, state, toast } from "./core";
import { isExternalCommand, isExternalRunSession, launchingKeys, markLaunching, replaceSessionInPlace, runCommand, runInTerminal, runTemplate } from "./launcher";
import { runPlatformAction } from "./project-menu";
import { activateSession, ensureTerm, renderTabs, updateControls } from "./terminal";
import { renderStatus } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import type { TermSession } from "./core";

export interface SessionLog {
  id: string;
  title: string;
  projectId: string | null;
  commandId: string | null;
  templateId: string | null;
  customCommandId: string | null;
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

export let persistTimer: number | null = null;

/** 合并高频变更，避免每次输出都序列化整个缓冲 */
/** 输出驱动自动落盘：最多 5 秒一次，避免关窗口时丢掉最后一段输出 */
export let lastAutoSave = 0;
export function autosaveSessions(): void {
  const now = Date.now();
  if (now - lastAutoSave < 5000) return;
  lastAutoSave = now;
  void persistSessions();
}

export function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persistSessions();
  }, 700);
}

export async function persistSessions(): Promise<void> {
  const logs: SessionLog[] = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    projectId: s.projectId ?? null,
    commandId: s.commandId ?? null,
    templateId: s.templateId ?? null,
    customCommandId: s.customCommandId ?? null,
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
export const RESTORE_MARKER = "──── 历史输出已恢复";

export function stripRestoreMarker(ansi: string): string {
  if (!ansi.includes(RESTORE_MARKER)) return ansi;
  return ansi
    .split(/\r?\n/)
    .filter((line) => !line.includes(RESTORE_MARKER))
    .join("\r\n");
}

export async function restoreSessions(): Promise<void> {
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
    l.customCommandId
      ? `custom|${l.customCommandId}`
      : l.platform
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
    const referencedTemplate = state.commandTemplates.find((t) => t.id === log.templateId);
    const inferredKind = log.kind || (log.platform ? "run" : (referenced?.kind ?? "run"));

    const s: TermSession = {
      id: log.id,
      title: log.title,
      device: log.device || "—",
      mode: log.mode || "debug",
      kind: inferredKind,
      cwd: log.cwd || "",
      artifacts: log.artifacts ?? [],
      status: "stopped",
      exitCode: log.exitCode ?? null,
      scan: "",
      // 日志里没存 source：按它引用的命令/模板补回来，否则恢复的 npm 会话
      // 会被当成 flutter run（停止时发 q、重跑走错分支）
      source:
        referenced?.source ??
        state.commandTemplates.find((t) => t.id === log.templateId)?.source ??
        undefined,
      external: referenced
        ? isExternalCommand(referenced)
        : referencedTemplate
          ? isExternalCommand(referencedTemplate)
          : undefined,
      projectId: log.projectId ?? undefined,
      commandId: log.commandId ?? undefined,
      templateId: log.templateId ?? undefined,
      customCommandId: log.customCommandId ?? undefined,
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
        // 历史输出已经写进缓冲区；再补一整屏空行，把历史顶到回滚区。
        // 新 shell 的 ConPTY 是从自己的第 0 行开始画提示符的，直接接在历史后面时，
        // 提示符/命令会覆盖到历史顶部，和日志混在一起（实测）。
        if (s.term) {
          await new Promise<void>((resolve) => {
            // 恢复时终端还没 fit，rows 可能只是默认的 24；至少补 60 行，
            // 保证把历史顶出当前可见区域，给新 shell 留一整屏空白。
            s.term!.write("\r\n".repeat(Math.max(s.term!.rows * 2, 60)), resolve);
          });
          await new Promise<void>((resolve) => {
            // 清掉可见区（历史已经在上方回滚区），并把光标归位到左上角。
            // 新 shell 的 ConPTY 也从它自己的第 0 行开始画提示符，坐标对齐后，
            // 后续 ↑/↓ 重绘不会再跑到顶部和旧日志叠在一起。
            s.term!.write("\x1b[2J\x1b[H", resolve);
          });
        }

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

export async function rerunSession(s: TermSession): Promise<void> {
  // 连点「重跑」时第二次点击会看到同一个旧会话，不能让它再起一个进程
  const key = `rerun|${s.id}`;
  if (markLaunching(key)) return;
  try {
    await rerunSessionNow(s);
  } finally {
    launchingKeys.delete(key);
  }
}

export async function rerunSessionNow(s: TermSession): Promise<void> {
  // 工具栏自定义命令：先结束旧进程，再启动一条新标签，成功后才移除旧标签
  if (s.kind === "custom") {
    const cmd = state.customCommands?.find((c) => c.id === s.customCommandId);
    if (!cmd) {
      toast("原自定义命令已删除", "error");
      return;
    }
    if (s.status !== "stopped") {
      await invoke("kill_session", { id: s.id }).catch(() => {});
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    await runCustomCommand(cmd, s.id);
    return;
  }

  const project = state.projects.find((p) => p.id === s.projectId);
  if (!project) {
    toast("原项目已不存在，无法重跑", "error");
    return;
  }

  // 项目终端：先 Ctrl+C 中断当前命令，等回到提示符，再把同一条命令带 Enter 写进去。
  // 这样 go run 之类的长命令不需要用户再手动敲一次、按一次回车。
  if (s.kind === "terminal") {
    if (s.restored) {
      toast("终端还在恢复，请稍等", "error");
      return;
    }
    const cmd = s.commandId
      ? project.commands.find((c) => c.id === s.commandId)
      : undefined;
    if (!cmd || cmd.kind !== "custom") {
      toast("这个终端还没有可重跑的命令", "error");
      return;
    }
    // 已经停止（刚点过停止）就不用再发 Ctrl+C，直接在同一个 shell 里重跑
    if (s.status !== "stopped") {
      await invoke("write_session", { id: s.id, data: "\x03" }).catch(() => {});
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    await runInTerminal(project, cmd, s);
    return;
  }

  if (s.commandId) {
    const cmd = project.commands.find((c) => c.id === s.commandId);
    if (cmd) {
      // run 会话的「重跑」= 立刻重跑：外部程序（npm run dev 等）重新起一条会话，
      // flutter run 重新走「shell + 哨兵」的执行链。
      // 以前这里走 prefill_run（只把命令敲到提示符、不回车），用户还得手动按 Enter。
      // 新会话先挂上（失败时旧标签还在），成功后再把旧标签**原位替换**——
      // 直接关旧开新会把标签追加到列表末尾，顺序全乱。
      // 用命令本身的类型判定，而不是会话记录里的 kind——
      // 老会话记录可能没有 kind 字段，会导致 run 走错分支（不替换标签）
      const replace = cmd.kind === "run" && s.kind !== "terminal" ? s.id : null;
      const fresh = await runCommand(project, cmd);
      if (fresh && replace && fresh.id !== replace) {
        // runCommand 通常已经按「同名停止标签」替换过了；这里兜底旧标签还在的情况
        if (sessions.some((x) => x.id === replace)) {
          replaceSessionInPlace(replace, fresh.id);
        }
      }
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

/* ---------------- 终端输出过滤 ---------------- */

/** 只有 flutter run 会话（含平台动作）算「Flutter 终端」；
 *  build / 普通终端 / 自定义命令 / npm / docker / qt 都不算。 */
export function isFlutterSession(s: TermSession | undefined): boolean {
  return !!s && s.kind === "run" && !isExternalRunSession(s);
}

/** 剥离 ANSI 转义序列；只用于匹配，写回终端的始终是原始字节。 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI（SGR / 光标控制）
    .replace(/\u001b[@-_]/g, ""); // 单字符 ESC
}

/** 这一整行是否命中任一启用的规则。大小写敏感。 */
export function lineMatchesFilter(rawLine: string): boolean {
  const rules = state.settings.terminal?.filters ?? [];
  if (rules.length === 0) return false;
  const plain = stripAnsi(rawLine);
  const trimmed = plain.replace(/^\s+/, "");
  for (const r of rules) {
    if (!r.enabled || r.scope !== "flutter") continue;
    const p = r.pattern ?? "";
    if (p === "") continue;
    if (r.mode === "prefix" && trimmed.startsWith(p)) return true;
    if (r.mode === "contain" && plain.includes(p)) return true;
  }
  return false;
}

/** 把 data 按显示层过滤后返回可写出的文本。
 *  - 按 \r\n / \r / \n 切分（\r 是 Flutter 的原地重绘边界），逐段决策；
 *    未结束的尾段暂存在 s.filterCarry 等下一块
 *  - 纯控制序列块（无可见文本、无换行）立即透传，避免光标控制被卡住
 *  - carry 超过 4096 字符强制 flush，防止无换行的长段无限堆积 */
export function applyOutputFilter(s: TermSession, data: string): string {
  const noVisible = stripAnsi(data).replace(/[\r\n]/g, "").length === 0;
  if (!/[\r\n]/.test(data) && noVisible && !(s.filterCarry ?? "")) return data;

  const combined = (s.filterCarry ?? "") + data;
  const parts = combined.split(/(\r\n|\r|\n)/); // 保留分隔符，奇数下标是分隔符
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? "";
    const sep = parts[i + 1];
    if (sep === undefined) {
      s.filterCarry = line;
      break;
    }
    if (!lineMatchesFilter(line)) out += line + sep;
  }
  if ((s.filterCarry ?? "").length > 4096) {
    const carry = s.filterCarry ?? "";
    s.filterCarry = "";
    if (!lineMatchesFilter(carry)) out += carry;
  }
  return out;
}

/** 切换会话的过滤开关；关闭时把暂存的半行原样写回，避免丢字。 */
export function setSessionFilter(s: TermSession, on: boolean): void {
  if (s.filterEnabled === on) return;
  if (!on && s.filterCarry) {
    if (s.term) s.term.write(s.filterCarry);
    else {
      const buf = pendingOutput.get(s.id) ?? [];
      buf.push(s.filterCarry);
      pendingOutput.set(s.id, buf);
    }
    s.filterCarry = "";
  }
  s.filterEnabled = on;
}

/** 顶部菜单：终端过滤器设置面板。 */
