/* ============================================================
   AppDeck — Output（由 main.ts 拆分而来）
   ============================================================ */
import { activeSessionId, defaultSettings, pendingOutput, sessions, setState, state, toast } from "./core";
import { applyOutputFilter, isFlutterSession, schedulePersist } from "./persistence";
import { renderTabs, updateControls } from "./terminal";
import { render, renderStatus } from "./tree";
import { invoke } from "@tauri-apps/api/core";

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { OutputFilter, SettingsModel, State, TermSession } from "./core";

export function openFilterPanel(): void {
  const rules: OutputFilter[] = (state.settings.terminal?.filters ?? []).map((f) => ({ ...f }));

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal filter-modal">
      <div class="modal-head">
        <span>终端过滤器</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="set-desc">
          只对 <b>Flutter 终端</b> 的<b>新输出</b>生效：还需打开终端工具条上的「过滤」开关。
          匹配<b>大小写敏感</b>；contain = 包含，prefix = 行首前缀（自动忽略行首颜色码与空白）。
          不勾「生效」的规则只保留、不生效。
        </div>
        <table class="filter-table">
          <thead><tr><th>规则</th><th>内容</th><th>作用域</th><th>生效</th><th></th></tr></thead>
          <tbody id="filter-rows"></tbody>
        </table>
        <button class="btn" id="filter-add" style="margin-top:8px">＋ 添加规则</button>
      </div>
      <div class="modal-foot">
        <span class="flex1"></span>
        <button class="btn" id="filter-cancel">取消</button>
        <button class="btn primary" id="filter-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const $ = <T extends Element>(sel: string): T => overlay.querySelector(sel) as T;
  const rows = $<HTMLTableSectionElement>("#filter-rows");
  const close = (): void => overlay.remove();

  overlay.querySelector(".modal-x")?.addEventListener("click", close);
  $<HTMLButtonElement>("#filter-cancel").addEventListener("click", close);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  const selectOf = (options: Array<[string, string]>, value: string): HTMLSelectElement => {
    const sel = document.createElement("select");
    sel.className = "set-input";
    for (const [v, label] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = value;
    return sel;
  };

  const renderRows = (): void => {
    rows.innerHTML = "";
    rules.forEach((r, idx) => {
      const tr = document.createElement("tr");

      const modeTd = document.createElement("td");
      const mode = selectOf(
        [
          ["contain", "contain"],
          ["prefix", "prefix"],
        ],
        r.mode === "prefix" ? "prefix" : "contain",
      );
      mode.addEventListener("change", () => (r.mode = mode.value));
      modeTd.appendChild(mode);

      const contentTd = document.createElement("td");
      const input = document.createElement("input");
      input.className = "set-input";
      input.type = "text";
      input.spellcheck = false;
      input.placeholder = "要匹配的文本";
      input.value = r.pattern ?? "";
      input.addEventListener("input", () => (r.pattern = input.value));
      contentTd.appendChild(input);

      const scopeTd = document.createElement("td");
      const scope = selectOf(
        [
          ["none", "none"],
          ["flutter", "flutter"],
        ],
        r.scope === "none" ? "none" : "flutter",
      );
      scope.addEventListener("change", () => (r.scope = scope.value));
      scopeTd.appendChild(scope);

      const enabledTd = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = r.enabled === true;
      cb.addEventListener("change", () => (r.enabled = cb.checked));
      enabledTd.appendChild(cb);

      const delTd = document.createElement("td");
      const del = document.createElement("button");
      del.className = "btn";
      del.textContent = "×";
      del.title = "删除该规则";
      del.addEventListener("click", () => {
        rules.splice(idx, 1);
        renderRows();
      });
      delTd.appendChild(del);

      tr.append(modeTd, contentTd, scopeTd, enabledTd, delTd);
      rows.appendChild(tr);
    });
  };
  renderRows();

  $<HTMLButtonElement>("#filter-add").addEventListener("click", () => {
    rules.push({ mode: "contain", pattern: "", scope: "flutter", enabled: true });
    renderRows();
  });

  $<HTMLButtonElement>("#filter-save").addEventListener("click", () => {
    void (async () => {
      try {
        const settings: SettingsModel = JSON.parse(
          JSON.stringify(state.settings ?? defaultSettings()),
        ) as SettingsModel;
        settings.terminal = {
          path: settings.terminal?.path ?? null,
          // 空内容的规则没有意义，保存时丢弃
          filters: rules.filter((r) => (r.pattern ?? "").trim() !== ""),
        };
        setState(await invoke<State>("save_settings", { settings }));
        close();
        render();
        toast("终端过滤器已保存");
      } catch (e) {
        toast(String(e), "error");
      }
    })();
  });

  $<HTMLInputElement>(".filter-table input[type=text]")?.focus();
}

export function handleOutput(id: string, data: string): void {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;

  // 显示层过滤：只改写入 xterm 的内容；下面的锚点扫描始终用原始 data
  const display = s.filterEnabled && isFlutterSession(s) ? applyOutputFilter(s, data) : data;
  if (display) {
    if (!s.term) {
      const buf = pendingOutput.get(id) ?? [];
      buf.push(display);
      pendingOutput.set(id, buf);
    } else {
      s.term.write(display);
    }
  }

  // 锚点可能被切块，用滚动窗口匹配（始终用原始流）
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
    s.flutterRunning = true;
    renderTabs();
    updateControls();
  }

  // 哨兵：shell 模式下 flutter run 退出时会打印（前后被 ESC[2K\r 抹掉，用户看不见）
  const runEnd = s.scan.match(/__FLA_RUN_END__:(-?\d+)/);
  if (runEnd && s.flutterRunning) {
    s.flutterRunning = false;
    s.status = "stopped";
    s.exitCode = Number(runEnd[1]);
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

  // 批处理提示：不回答的话 cmd.exe 会一直等，会话状态就永远停不下来
  answerBatchPrompt(s, data);
}

/** cmd.exe 在批处理里收到 Ctrl+C 会问「终止批处理操作吗(Y/N)?」并一直等输入。
 *  没人回答时 `cmd /c` 这层包装永远不退出 → pty://exit 不来，
 *  于是终端里程序已经没了、状态还显示「运行中」。
 *  用户按 Ctrl+C 就是要停，这里替他回答 Y（一次提示只答一次）。 */
export const BATCH_JOB_PROMPT = /(?:终止批处理操作吗|Terminate batch job)[^\r\n]*?\(Y\/N\)\?\s*$/i;

export function answerBatchPrompt(s: TermSession, chunk: string): void {
  s.promptTail = ((s.promptTail ?? "") + chunk).slice(-200);
  if (!BATCH_JOB_PROMPT.test(s.promptTail)) return;
  s.promptTail = "";
  void invoke("write_session", { id: s.id, data: "Y\r" }).catch(() => {});
}

export function handleExit(id: string, code: number | null): void {
  const s = sessions.find((x) => x.id === id);
  if (!s || s.status === "stopped") return;

  s.status = "stopped";
  s.exitCode = code;
  // 进程都没了就不可能还在跑 flutter，否则热重载工具条会一直亮着
  s.flutterRunning = false;
  const label = code == null ? "已终止" : `退出码 ${code}`;
  s.term?.write(`\r\n\x1b[90m──── 会话结束（${label}）────\x1b[0m\r\n`);
  renderTabs();
  renderStatus();
  updateControls();

  // D-11：构建结束发系统通知
  if (s.kind === "build") void notifyBuild(s);

  schedulePersist();
}

export async function notifyBuild(s: TermSession): Promise<void> {
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

export async function revealArtifact(s: TermSession, rel: string): Promise<void> {
  const base = s.cwd.replace(/[\\/]+$/, "");
  const abs = /^[a-zA-Z]:[\\/]/.test(rel) ? rel : `${base}\\${rel.replace(/\//g, "\\")}`;
  try {
    await revealItemInDir(abs);
  } catch (e) {
    toast(`打开失败：${String(e)}`, "error");
  }
}
