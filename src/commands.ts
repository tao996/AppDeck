/* ============================================================
   AppDeck — Commands（由 main.ts 拆分而来）
   ============================================================ */
import { openCommandDialog } from "./command-dialog";
import { esc, req, setState, state, toast } from "./core";
import { launchingKeys, liveSessionFor, markLaunching, mountSession, replaceSessionInPlace, staleSessionFor } from "./launcher";
import { joinArgs, pickScriptFile, showUsageExamples, splitArgs, templateListRefresh } from "./menus";
import { closeAllMenus, openTemplateManager, renderMenuRows, setProjMenuEl } from "./project-menu";
import { activateSession } from "./terminal";
import { render } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { Cmd, CustomCommand, Proj, ScriptPreview, StartResponse, State, TermSession } from "./core";
import type { MenuRow } from "./project-menu";

export interface ShortcutInfo {
  target: string;
  args: string;
  cwd: string;
  description: string;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export async function runCustomCommand(c: CustomCommand, replaceId?: string): Promise<void> {
  const sameCustom = (s: TermSession): boolean =>
    s.kind === "custom" && s.customCommandId === c.id;

  // 同一个自定义命令已在跑：切回已有标签（「重跑」传了 replaceId，跳过这层）
  if (!replaceId) {
    const live = liveSessionFor(sameCustom);
    if (live) {
      activateSession(live.id);
      toast(`该命令已在运行：${live.title}`);
      return;
    }
  }

  const stale = staleSessionFor(sameCustom);

  const key = `custom|${c.id}`;
  if (markLaunching(key)) return;

  try {
    const res = await invoke<StartResponse>("start_custom_command", {
      commandId: c.id,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(res, "custom", "—", { customCommandId: c.id });
    // 重跑传了 replaceId 就替换它；否则把同名且已停止的旧标签原位替换掉
    const oldId = replaceId ?? stale?.id;
    if (oldId && oldId !== session.id) replaceSessionInPlace(oldId, session.id);
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launchingKeys.delete(key);
  }
}

export async function deleteCustomCommand(c: CustomCommand): Promise<void> {
  const ok = await confirm(`删除自定义命令「${c.name}」？`, {
    title: "删除自定义命令",
    kind: "warning",
  });
  if (!ok) return;
  try {
    setState(await invoke<State>("remove_custom_command", { id: c.id }));
    closeAllMenus();
    toast(`已删除：${c.name}`);
  } catch (e) {
    toast(String(e), "error");
  }
}

/**
 * 「添加命令」入口分流：
 * - Flutter 单应用（kind=single，有 pubspec）→ 命令面板（run / build / custom / shell）
 * - 其它项目（文件夹 / 命令集 / npm / docker / Qt）→ 通用「自定义命令」面板，
 *   保存成该项目的 `kind=custom` 命令（那个面板的 run/build 对它们没有意义）
 */
export function openAddCommand(p: Proj): void {
  if (p.kind === "single") void openCommandDialog(p);
  else void openCustomCommandDialog(undefined, p);
}

/**
 * 「自定义命令」面板：程序 / 快捷方式 + 参数 + 工作目录 + 环境变量。
 *
 * - 从工具栏「自定义命令」打开：保存成全局命令（`state.customCommands`），
 *   运行时新开一个会话直接启动程序。
 * - 从非 Flutter 项目的「添加命令」打开（传 `project`）：同样的表单，
 *   保存成**该项目的命令**（`kind=custom`），输出进项目终端。
 */
export async function openCustomCommandDialog(
  existing?: CustomCommand,
  project?: Proj,
  asTemplate = false,
  existingTemplate?: Cmd,
): Promise<void> {
  const tpl = existingTemplate;
  const editingTemplate = asTemplate && !!tpl;
  const draft = {
    name: existing?.name ?? tpl?.name ?? "",
    program: existing?.program ?? tpl?.program ?? "",
    target: existing?.target ?? "",
    // 模板的 args 是数组，回填成命令行文本
    args: tpl ? joinArgs(tpl.args ?? []) : (existing?.args ?? ""),
    cwd: existing?.cwd ?? tpl?.cwd ?? "",
    envPairs: Object.entries(existing?.env ?? tpl?.env ?? {}) as Array<[string, string]>,
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 700px">
      <div class="modal-head">
        <span>${existing || editingTemplate ? "编辑自定义命令" : "添加自定义命令"}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="set-row">
          <label>名称</label>
          <div class="set-cell">
            <input class="set-input" id="cc-name" maxlength="60" placeholder="如 NPC 服务" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
          </div>
        </div>
        <div class="set-row">
          <label>程序/命令</label>
          <div class="set-cell">
            <input class="set-input" id="cc-program" placeholder="选 .lnk/.exe，或直接粘贴整条命令" spellcheck="false" autocomplete="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
            <button class="btn" id="cc-browse">浏览…</button>
            <button class="btn" id="cc-resolve">解析</button>
          </div>
        </div>
        <div class="set-desc">直接粘贴整条命令会自动拆分到「程序」和「参数」；路径含空格请加引号，如 <code>"C:\Program Files\App\app.exe" --flag</code>。</div>
        <div class="set-desc" id="cc-target"></div>
        <div class="set-row">
          <label>参数</label>
          <div class="set-cell">
            <input class="set-input" id="cc-args" placeholder="原样传给程序；快捷方式会自动填入" spellcheck="false" autocomplete="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
          </div>
        </div>
        <div class="set-row">
          <label>工作目录</label>
          <div class="set-cell">
            <input class="set-input" id="cc-cwd" placeholder="可空；快捷方式会自动填入" spellcheck="false" autocomplete="off" autocapitalize="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" />
            <button class="btn" id="cc-browse-cwd">浏览…</button>
          </div>
        </div>
        <div class="set-desc">
          ${asTemplate
            ? editingTemplate
              ? "编辑全局命令模板：这里只改程序 / 参数 / 目录 / 环境变量；类型、构建模式等未展示的字段保持不变。"
              : "保存为全局命令模板：新建「单应用」项目时自动套用，也可在项目树里按需导入。"
            : project
              ? `保存为项目「${esc(project.name)}」的命令：在下面的工作目录里直接启动程序，输出进入项目终端。`
              : "直接启动目标程序（.lnk 会先解析成 exe），不经过 ShellExecute，因此不会弹出系统控制台，也不会在任务栏多一个窗口。"}
        </div>
        <div class="set-desc" id="cc-hint"></div>
        <div class="set-row" id="cc-venv-row" hidden>
          <label>Python 虚拟环境</label>
          <div class="set-cell">
            <select class="set-input" id="cc-venv"></select>
          </div>
        </div>

        <div class="set-title" style="margin-top:12px">环境变量</div>
        <div class="env-list" id="cc-env"></div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="cc-import-script">从脚本导入…</button>
        <button class="btn" id="cc-examples">使用示例</button>
        <button class="btn" id="cc-cancel">取消</button>
        <button class="btn primary" id="cc-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameEl = overlay.querySelector("#cc-name") as HTMLInputElement;
  const programEl = overlay.querySelector("#cc-program") as HTMLInputElement;
  const argsEl = overlay.querySelector("#cc-args") as HTMLInputElement;
  const cwdEl = overlay.querySelector("#cc-cwd") as HTMLInputElement;
  const targetEl = overlay.querySelector("#cc-target") as HTMLDivElement;
  const hint = overlay.querySelector("#cc-hint") as HTMLDivElement;
  const saveBtn = overlay.querySelector("#cc-save") as HTMLButtonElement;
  const venvRow = overlay.querySelector("#cc-venv-row") as HTMLDivElement;
  const venvSel = overlay.querySelector("#cc-venv") as HTMLSelectElement;
  const envBox = overlay.querySelector("#cc-env") as HTMLDivElement;

  /** 导入 .py 时识别到的虚拟环境（全局命令没有项目上下文，用脚本目录向上找） */
  let pyVenvs: ScriptPreview["venvs"] = [];

  /** 环境变量行：KEY=value 列表，空 KEY 保存时忽略 */
  const renderEnv = (): void => {
    envBox.innerHTML = "";

    draft.envPairs.forEach((pair, idx) => {
      const row = document.createElement("div");
      row.className = "env-row";

      const kEl = document.createElement("input");
      kEl.className = "set-input env-key";
      kEl.value = pair[0];
      kEl.placeholder = "KEY";
      kEl.spellcheck = false;
      kEl.addEventListener("input", () => {
        draft.envPairs[idx][0] = kEl.value;
      });

      const vEl = document.createElement("input");
      vEl.className = "set-input";
      vEl.value = pair[1];
      vEl.placeholder = "value（原样注入，不展开 %VAR%）";
      vEl.spellcheck = false;
      vEl.addEventListener("input", () => {
        draft.envPairs[idx][1] = vEl.value;
      });

      const del = document.createElement("button");
      del.className = "btn";
      del.textContent = "×";
      del.title = "删除该变量";
      del.addEventListener("click", () => {
        draft.envPairs.splice(idx, 1);
        renderEnv();
      });

      row.append(kEl, vEl, del);
      envBox.appendChild(row);
    });

    if (draft.envPairs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "set-desc";
      empty.textContent = "（暂无，可点下方添加；例如 PYTHONUTF8=1）";
      envBox.appendChild(empty);
    }

    const add = document.createElement("button");
    add.className = "btn";
    add.textContent = "＋ 添加变量";
    add.addEventListener("click", () => {
      draft.envPairs.push(["", ""]);
      renderEnv();
    });
    envBox.appendChild(add);
  };
  renderEnv();

  nameEl.value = draft.name;
  programEl.value = draft.program;
  argsEl.value = draft.args;
  cwdEl.value = draft.cwd;
  nameEl.addEventListener("input", () => (draft.name = nameEl.value));
  programEl.addEventListener("input", () => {
    draft.program = programEl.value.trim();
    if (!draft.program.toLowerCase().endsWith(".lnk")) draft.target = "";
    renderTarget();
  });
  argsEl.addEventListener("input", () => (draft.args = argsEl.value));
  cwdEl.addEventListener("input", () => (draft.cwd = cwdEl.value.trim()));

  const renderTarget = (): void => {
    if (draft.target) {
      targetEl.textContent = `目标：${draft.target}`;
      targetEl.title = draft.target;
    } else if (draft.program.toLowerCase().endsWith(".lnk")) {
      targetEl.textContent = "快捷方式尚未解析；保存或运行时会自动解析。";
    } else {
      targetEl.textContent = "";
    }
  };
  renderTarget();

  /** 直接粘贴整条命令（如 flutter build apk --release）时，自动拆到「程序」和「参数」。
   *  含空格的路径需用户自己加引号，splitArgs 按引号分词，拆错了也能在两个输入框里改。 */
  programEl.addEventListener("paste", (e) => {
    const text = (e.clipboardData?.getData("text") ?? "").trim();
    if (!/\s/.test(text)) return; // 单个 token，走默认粘贴
    const parts = splitArgs(text);
    if (parts.length < 2) return;
    e.preventDefault();
    programEl.value = parts[0];
    argsEl.value = parts.slice(1).join(" ");
    draft.program = parts[0];
    draft.args = argsEl.value;
    draft.target = "";
    renderTarget();
    hint.textContent = `已自动拆分：程序 = ${parts[0]}；参数 = ${parts.slice(1).join(" ")}`;
  });

  const resolve = async (): Promise<boolean> => {
    const program = programEl.value.trim();
    if (!program.toLowerCase().endsWith(".lnk")) {
      draft.target = "";
      renderTarget();
      return true;
    }
    hint.textContent = "正在解析快捷方式…";
    try {
      const info = await invoke<ShortcutInfo>("resolve_shortcut", { path: program });
      draft.program = program;
      draft.target = info.target;
      draft.args = info.args;
      draft.cwd = info.cwd;
      argsEl.value = draft.args;
      cwdEl.value = draft.cwd;
      hint.textContent = "";
      renderTarget();
      return true;
    } catch (e) {
      hint.textContent = String(e);
      return false;
    }
  };

  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#cc-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  (overlay.querySelector("#cc-browse") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        const picked = await open({
          multiple: false,
          title: "选择程序或快捷方式",
          filters: [
            { name: "程序与快捷方式", extensions: ["lnk", "exe"] },
            { name: "全部文件", extensions: ["*"] },
          ],
          defaultPath: programEl.value || undefined,
        });
        if (!picked) return;
        const p = Array.isArray(picked) ? picked[0] : picked;
        programEl.value = p;
        draft.program = p;
        if (p.toLowerCase().endsWith(".lnk")) {
          await resolve();
        } else {
          draft.target = p;
          renderTarget();
          if (!cwdEl.value.trim()) {
            const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
            if (i > 0) {
              cwdEl.value = p.slice(0, i);
              draft.cwd = cwdEl.value;
            }
          }
        }
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  (overlay.querySelector("#cc-browse-cwd") as HTMLButtonElement).addEventListener("click", () => {
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
        draft.cwd = picked;
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  (overlay.querySelector("#cc-resolve") as HTMLButtonElement).addEventListener("click", () => {
    void resolve();
  });

  const renderVenvs = (selected: string | null): void => {
    venvSel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不使用（PATH 里的 python）";
    venvSel.appendChild(none);
    for (const v of pyVenvs) {
      const o = document.createElement("option");
      o.value = v.dir;
      o.textContent = `${v.label} — ${v.dir}`;
      venvSel.appendChild(o);
    }
    venvSel.value = selected ?? "";
    venvRow.hidden = pyVenvs.length === 0;
  };

  venvSel.addEventListener("change", () => {
    const v = pyVenvs.find((x) => x.dir === venvSel.value);
    if (v) {
      programEl.value = v.python;
      draft.program = v.python;
      hint.textContent = `使用虚拟环境 ${v.dir} 里的 python.exe（等价于先 activate，再跑脚本）`;
    } else {
      programEl.value = "python";
      draft.program = "python";
      hint.textContent = "使用 PATH 里的 python（依赖要装在这个解释器里）";
    }
    renderTarget();
  });

  // 「从脚本导入…」：全局命令直接 CreateProcess，所以 .ps1 要显式套 PowerShell
  (overlay.querySelector("#cc-import-script") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        const scriptPath = await pickScriptFile();
        if (!scriptPath) return;

        const info = await invoke<ScriptPreview>("preview_script_command", {
          path: scriptPath,
          projectId: null,
          mode: "global",
        });

        if (!nameEl.value.trim()) {
          const taken = new Set((state.customCommands ?? []).map((c) => c.name));
          let name = info.name;
          for (let i = 2; taken.has(name) && i < 100; i++) name = `${info.name} ${i}`;
          nameEl.value = name;
          draft.name = name;
        }

        programEl.value = info.program;
        draft.program = info.program;
        draft.target = "";
        argsEl.value = joinArgs(info.args);
        draft.args = argsEl.value;
        if (info.cwd) {
          cwdEl.value = info.cwd;
          draft.cwd = info.cwd;
        }

        pyVenvs = info.venvs;
        renderVenvs(info.venv);

        hint.textContent = info.note;
        renderTarget();
        toast(
          info.venv
            ? `已导入脚本「${info.name}」，使用虚拟环境 ${info.venv}`
            : `已导入脚本「${info.name}」，工作目录已设为脚本所在目录`,
        );
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  // 「使用示例」：与 flutter 命令面板共用同一份示例清单（menus.showUsageExamples）。
  // 工具栏的全局命令按「程序 + 参数」原样启动，不展开占位符，所以这里额外提示一句，
  // 避免把 %FLUTTER% 示例填进去后运行时才失败。
  (overlay.querySelector("#cc-examples") as HTMLButtonElement).addEventListener("click", () => {
    const isToolbar = !project && !asTemplate;
    showUsageExamples(
      (ex) => {
        draft.program = ex.program;
        draft.args = ex.args;
        draft.cwd = ex.cwd;
        draft.target = "";
        programEl.value = ex.program;
        argsEl.value = ex.args;
        cwdEl.value = ex.cwd;
        renderTarget();

        if (isToolbar && /%[A-Za-z_]+%/.test(`${ex.program} ${ex.args} ${ex.cwd}`)) {
          hint.textContent =
            "工具栏自定义命令不展开 %FLUTTER% / %PROJECT% / %CWD%；要用占位符请存成项目命令或全局模板。";
        } else if (isToolbar && /\.(bat|cmd)$/i.test(ex.program)) {
          hint.textContent = "工具栏不支持直接运行 .bat/.cmd；请改成 .exe 或 .lnk。";
        } else {
          hint.textContent = "";
        }
        toast("已填入表单，记得点「保存」");
      },
      isToolbar
        ? {
            note:
              "注意：工具栏的全局自定义命令按「程序 + 参数」原样启动，不展开 %FLUTTER% / %PROJECT% / %CWD%；"
              + "带占位符的示例适用于项目命令与全局模板。",
          }
        : undefined,
    );
  });

  saveBtn.addEventListener("click", () => {
    void (async () => {
      const name = nameEl.value.trim();
      const program = programEl.value.trim();
      if (!name) {
        hint.textContent = "请填写名称";
        return;
      }
      // 模板允许程序为空（如 build 类模板本来就没有 program），原样保留
      if (!program && !asTemplate) {
        hint.textContent = "请选择程序或快捷方式";
        return;
      }
      const lower = program.toLowerCase();
      // 只有全局自定义命令受这个限制（项目命令、模板由 shell 执行，.bat/.cmd 没问题）
      if (!project && !asTemplate && (lower.endsWith(".bat") || lower.endsWith(".cmd"))) {
        hint.textContent = "暂不支持直接运行 .bat/.cmd，请选择 .lnk 或 .exe";
        return;
      }
      if (lower.endsWith(".lnk") && !draft.target) {
        if (!(await resolve())) return;
      }

      const env: Record<string, string> = {};
      for (const [k, v] of draft.envPairs) {
        const key = k.trim();
        if (key !== "") env[key] = v;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        if (project) {
          // 非 Flutter 项目：同一个面板，存成项目命令（kind=custom），输出进项目终端。
          // .lnk 项目命令不支持直接启动，解析成真实 exe/参数/目录再存。
          const isLnk = program.toLowerCase().endsWith(".lnk");
          const prog = isLnk ? draft.target.trim() : program;
          const command: Cmd = {
            id: "",
            name,
            kind: "custom",
            program: prog,
            cwd: cwdEl.value.trim() || null,
            flutterMode: null,
            args: splitArgs(argsEl.value.trim()),
            env,
            toolArgs: [],
            deviceId: null,
            emulatorId: null,
            buildType: null,
            source: "manual",
            scope: "project",
            stale: false,
            group: null,
            role: null,
          };
          setState(await invoke<State>("upsert_command", {
            projectId: project.id,
            command,
          }));
          close();
          render();
          toast(`命令已添加到「${project.name}」`);
          return;
        }

        if (asTemplate) {
          // 模板库的新建/编辑都复用本面板，落盘为 commandTemplates 里的 Cmd。
          // .lnk 先解析成真实 exe，保证模板在任何机器上都能直接复用。
          const isLnk = program.toLowerCase().endsWith(".lnk");
          const resolvedProgram = program
            ? isLnk
              ? draft.target.trim() || program
              : program
            : (tpl?.program ?? null);
          const common = {
            name,
            program: resolvedProgram,
            cwd: cwdEl.value.trim() || null,
            args: splitArgs(argsEl.value.trim()),
            env,
            source: "template",
            scope: tpl?.scope ?? "global",
          };
          // 编辑时保留 kind / 构建模式 / 分类等本面板未展示的字段
          const template: Cmd = tpl
            ? { ...tpl, ...common }
            : {
                id: "",
                kind: "custom",
                flutterMode: null,
                toolArgs: [],
                deviceId: null,
                emulatorId: null,
                buildType: null,
                stale: false,
                group: null,
                role: null,
                ...common,
              };
          setState(await invoke<State>("upsert_template", { template }));
          close();
          render();
          templateListRefresh?.();
          toast(editingTemplate ? "模板已更新" : "模板已保存");
          return;
        }

        const command: CustomCommand = {
          id: existing?.id ?? "",
          name,
          program,
          target: draft.target.trim() || null,
          args: argsEl.value.trim(),
          cwd: cwdEl.value.trim() || null,
          env,
        };
        setState(await invoke<State>("upsert_custom_command", { command }));
        close();
        toast(existing ? "自定义命令已更新" : "自定义命令已添加");
      } catch (e) {
        hint.textContent = String(e);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "保存";
      }
    })();
  });

  nameEl.focus();
}

export function openCustomCommandMenu(): void {
  closeAllMenus();

  const menu = document.createElement("div");
  menu.className = "device-menu custom-cmd-menu";
  const btn = req<HTMLButtonElement>("#btn-custom-menu");
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 360))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 320)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>自定义命令</span>
      <span class="dm-tag">${state.customCommands?.length ?? 0}</span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  setProjMenuEl(menu);

  const rows: MenuRow[] = [];
  const commands = state.customCommands ?? [];
  for (const c of commands) {
    rows.push({
      kind: "item",
      name: c.name,
      detail: `${basename(c.target || c.program)}${c.cwd ? ` · ${c.cwd}` : ""}`,
      children: [
        {
          kind: "item",
          name: "运行",
          detail: "在 AppDeck 内嵌终端运行",
          onClick: () => void runCustomCommand(c),
        },
        {
          kind: "item",
          name: "编辑…",
          detail: "名称 / 程序 / 参数 / 工作目录",
          onClick: () => void openCustomCommandDialog(c),
        },
        { kind: "sep" },
        {
          kind: "item",
          name: "删除…",
          detail: "从工具栏移除（不影响磁盘文件）",
          onClick: () => void deleteCustomCommand(c),
        },
      ],
    });
  }

  if (!commands.length) {
    const empty = document.createElement("div");
    empty.className = "dm-empty";
    empty.textContent = "还没有自定义命令";
    (menu.querySelector(".dm-body") as HTMLDivElement).appendChild(empty);
  }

  rows.push(
    { kind: "sep" },
    {
      kind: "item",
      name: "＋ 添加命令…",
      detail: "快捷方式 / exe，可填参数与工作目录",
      onClick: () => void openCustomCommandDialog(),
    },
    {
      kind: "item",
      name: "命令模板管理…",
      detail: `管理全局命令模板（当前 ${state.commandTemplates.length} 条）`,
      onClick: () => openTemplateManager(),
    },
  );

  renderMenuRows(menu.querySelector(".dm-body") as HTMLDivElement, rows);
}

/* ---------------- PTY 事件 ---------------- */

/** 打开「进程与端口」面板（工具栏按钮 / 开发期 FLA_PROCESSES 共用） */
