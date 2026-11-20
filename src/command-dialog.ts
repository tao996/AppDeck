/* ============================================================
   AppDeck — Command Dialog（由 main.ts 拆分而来）
   ============================================================ */
import { setState, state, toast } from "./core";
import { isExternalCommand } from "./launcher";
import { SHELL_AUTO_NAMES, SHELL_SPECS, isShellType, joinArgs, pickScriptFile, shellScriptOf, shellTypeOf, showUsageExamples, splitArgs, templateListRefresh } from "./menus";
import { render } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { BuildTarget, Cmd, Proj, ScriptPreview, State } from "./core";
import type { CmdType } from "./menus";

export async function openCommandDialog(p: Proj | null, existing?: Cmd): Promise<void> {
  const isTemplate = p === null;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 640px">
      <div class="modal-head">
        <span>${existing ? (isTemplate ? "编辑模板" : "编辑命令") : isTemplate ? "新建模板" : "添加命令"}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="cmd-body"></div>
      <div class="modal-foot">
        <span class="modal-hint" id="cmd-hint"></span>
        <span class="flex1"></span>
        ${existing ? "" : '<button class="btn" id="cmd-import-script">从脚本导入…</button>'}
        <button class="btn" id="cmd-examples">使用示例</button>
        ${existing ? '<button class="btn" id="cmd-del">删除</button>' : ""}
        <button class="btn" id="cmd-cancel">取消</button>
        <button class="btn primary" id="cmd-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#cmd-body") as HTMLDivElement;
  const hint = overlay.querySelector("#cmd-hint") as HTMLSpanElement;
  const close = (): void => overlay.remove();

  // 从已有 args 里拆出 flavor
  let flavor = "";
  let restArgs = [...(existing?.args ?? [])];
  const fi = restArgs.findIndex((a) => a === "--flavor");
  if (fi >= 0) {
    flavor = restArgs[fi + 1] ?? "";
    restArgs = restArgs.filter((_, i) => i !== fi && i !== fi + 1);
  }

  const inferredShell = shellTypeOf(existing);
  // npm / Docker / Qt 的命令按「程序 + 参数」直接执行（见 isExternalCommand），
  // 类型上是自定义命令；它们的 kind=run 只是会话生命周期，不是 flutter run。
  const isExternal = existing ? isExternalCommand(existing) : false;
  let initialType: CmdType;
  if (inferredShell) {
    initialType = inferredShell;
  } else if (!existing) {
    initialType = p?.kind === "folder" ? "custom" : "run";
  } else if (isExternal) {
    // 编辑外部命令时显示 custom：不能再把它当 flutter 调试运行展示
    initialType = "custom";
  } else {
    initialType =
      existing.kind === "run" || existing.kind === "build" ? existing.kind : "custom";
  }

  const draft = {
    name: existing?.name ?? "",
    type: initialType,
    program: existing?.program ?? "",
    cwd: existing?.cwd ?? "",
    mode: existing?.flutterMode ?? "debug",
    target: existing?.buildType ?? "apk",
    flavor,
    args: restArgs.join(" "),
    script: inferredShell && existing ? shellScriptOf(existing, inferredShell) : "",
    envPairs: Object.entries(existing?.env ?? {}) as Array<[string, string]>,
    scope: existing?.scope === "global" ? "global" : "project",
    /** 「从脚本导入」时后端给的说明（用了哪个解释器 / 虚拟环境） */
    scriptNote: "",
    /** 导入的脚本路径（只用于展示与 venv 下拉） */
    pyScript: "",
    /** 当前选中的 venv 根目录（仅 .py） */
    pyVenv: null as string | null,
    /** 可选的 venv 列表（仅 .py） */
    pyVenvs: [] as ScriptPreview["venvs"],
  };

  let targets: BuildTarget[] | null = null;

  /** 导入脚本时的命令名：与已有命令/模板重名就加序号 */
  const uniqueCommandName = (base: string): string => {
    const taken = new Set<string>(
      isTemplate
        ? state.commandTemplates.map((t) => t.name)
        : (p?.commands ?? []).map((c) => c.name),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const cand = `${base} ${i}`;
      if (!taken.has(cand)) return cand;
    }
    return base;
  };

  const row = (label: string): [HTMLDivElement, HTMLElement] => {
    const r = document.createElement("div");
    r.className = "set-row";
    const l = document.createElement("label");
    l.textContent = label;
    const cell = document.createElement("div");
    cell.className = "set-cell";
    r.append(l, cell);
    body.appendChild(r);
    return [r, cell];
  };

  const input = (parent: HTMLElement, value: string, placeholder: string, onInput: (v: string) => void): void => {
    const el = document.createElement("input");
    el.className = "set-input";
    el.value = value;
    el.placeholder = placeholder;
    el.addEventListener("input", () => onInput(el.value));
    parent.appendChild(el);
  };

  const build = async (): Promise<void> => {
    body.innerHTML = "";

    {
      const [, cell] = row("名称");
      input(cell, draft.name, "如 GooglePlayReleaseProd", (v) => {
        draft.name = v;
      });
    }

    {
      const [, cell] = row("类型");
      const sel = document.createElement("select");
      sel.className = "set-input";
      const types: Array<[CmdType, string]> = [
        ["run", "run（flutter 调试运行）"],
        ["build", "build（flutter 发布构建）"],
        ["custom", "custom（自定义命令）"],
        ["powershell", "powershell（执行 PowerShell 命令）"],
        ["cmd", "cmd（执行 CMD 命令）"],
        ["bash", "bash（执行 Bash 命令）"],
      ];
      for (const [k, label] of types) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = label;
        if (draft.type === k) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = Boolean(existing);
      sel.addEventListener("change", () => {
        const autoNamed = SHELL_AUTO_NAMES.has(draft.name.trim());
        draft.type = sel.value as CmdType;
        // 新建 Shell 命令时给一个能直接保存的名称；用户已经填了就不动
        if (!draft.name.trim() || autoNamed) {
          draft.name = isShellType(draft.type)
            ? `${SHELL_SPECS[draft.type].label} 命令`
            : "";
        }
        void build();
      });
      cell.appendChild(sel);
      if (isExternal) {
        const note = document.createElement("div");
        note.className = "set-note";
        note.textContent =
          "外部程序（npm / Docker / Qt）：按「程序 + 参数」直接执行，不是 flutter run。";
        cell.appendChild(note);
      }
    }

    if (draft.type === "custom") {
      const [, c1] = row("程序");
      input(c1, draft.program, "%FLUTTER% 或 C:\\path\\to\\tool.exe", (v) => {
        draft.program = v;
      });
      // 选脚本/可执行文件，省得手打长路径
      const pick = document.createElement("button");
      pick.className = "btn";
      pick.textContent = "浏览…";
      pick.title = "选择脚本或可执行文件";
      pick.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择要执行的程序",
              filters: [
                { name: "脚本与程序", extensions: ["ps1", "bat", "cmd", "exe"] },
                { name: "全部文件", extensions: ["*"] },
              ],
              defaultPath: draft.program || undefined,
            });
            if (!picked) return;
            draft.program = Array.isArray(picked) ? picked[0] : picked;
            void build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });
      c1.appendChild(pick);

      const [, c2] = row("cwd");
      input(c2, draft.cwd, "可空（相对项目根，支持 %PROJECT%）", (v) => {
        draft.cwd = v;
      });

      // .py：导入时识别到的虚拟环境可以在这里切换（不用手改 python.exe 路径）
      if (draft.pyScript && draft.pyVenvs.length > 0) {
        const [, cv] = row("Python 虚拟环境");
        const sel = document.createElement("select");
        sel.className = "set-input";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "不使用（PATH 里的 python）";
        sel.appendChild(none);
        for (const v of draft.pyVenvs) {
          const o = document.createElement("option");
          o.value = v.dir;
          o.textContent = `${v.label} — ${v.dir}`;
          sel.appendChild(o);
        }
        sel.value = draft.pyVenv ?? "";
        sel.addEventListener("change", () => {
          const v = draft.pyVenvs.find((x) => x.dir === sel.value);
          if (v) {
            draft.pyVenv = v.dir;
            draft.program = v.python;
            draft.scriptNote = `使用虚拟环境 ${v.dir} 里的 python.exe（等价于先 activate，再跑脚本）`;
          } else {
            draft.pyVenv = null;
            draft.program = "python";
            draft.scriptNote =
              "使用 PATH 里的 python（依赖要装在这个解释器里）；有 venv 时建议选上面的虚拟环境";
          }
          void build();
        });
        cv.appendChild(sel);
      }

      if (draft.scriptNote) {
        const imported = document.createElement("div");
        imported.className = "set-note";
        imported.textContent = draft.scriptNote;
        body.appendChild(imported);
      }

      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent =
        "%FLUTTER% → 该项目的 flutter；%PROJECT% → 项目根；%CWD% → 实际工作目录。" +
        ".ps1 自动用 PowerShell（含 -ExecutionPolicy Bypass）执行；.bat / .cmd 自动用 cmd 包装。";
      body.appendChild(note);
    } else if (isShellType(draft.type)) {
      const spec = SHELL_SPECS[draft.type];

      const [, c1] = row("命令");
      const ta = document.createElement("textarea");
      ta.className = "set-input cmd-script";
      ta.rows = 3;
      ta.value = draft.script;
      ta.placeholder = spec.placeholder;
      ta.spellcheck = false;
      ta.addEventListener("input", () => {
        draft.script = ta.value;
      });
      c1.appendChild(ta);

      const [, c2] = row("cwd");
      input(c2, draft.cwd, "可空（相对项目根，支持 %PROJECT%）", (v) => {
        draft.cwd = v;
      });

      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent = `${spec.note} 命令在项目终端中执行，输出进入当前标签。`;
      body.appendChild(note);
    } else if (draft.type === "run") {
      const [, c1] = row("program");
      input(c1, draft.program, "lib/main.dart（可空）", (v) => {
        draft.program = v;
      });
      const [, c2] = row("cwd");
      input(c2, draft.cwd, "projects/xxx（可空）", (v) => {
        draft.cwd = v;
      });
      const [, c3] = row("模式");
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["debug", "profile", "release"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        if (draft.mode === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.mode = sel.value;
      });
      c3.appendChild(sel);
    } else {
      if (targets === null) {
        hint.textContent = "正在探测构建目标…";
        try {
          targets = await invoke<BuildTarget[]>("build_targets", {
            projectId: p?.id ?? null,
          });
          hint.textContent = "";
        } catch (e) {
          hint.textContent = String(e);
          targets = [];
        }
      }

      const [, c1] = row("构建目标");
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const t of targets) {
        const o = document.createElement("option");
        o.value = t.name;
        o.textContent = `${t.name} — ${t.description}`;
        if (draft.target === t.name) o.selected = true;
        sel.appendChild(o);
      }
      const cur = targets.find((t) => t.name === draft.target);
      if (!cur && targets.length > 0) draft.target = targets[0].name;
      sel.addEventListener("change", () => {
        draft.target = sel.value;
        void build();
      });
      c1.appendChild(sel);

      const [, c2] = row("flavor");
      input(c2, draft.flavor, "可空（如 prod）", (v) => {
        draft.flavor = v;
      });
      const supported = targets.find((t) => t.name === draft.target)?.supportsFlavor ?? false;
      c2.classList.toggle("disabled", !supported);
      const note = document.createElement("div");
      note.className = "set-note";
      note.textContent = supported ? "该目标支持 --flavor" : "该目标不支持 --flavor（留空）";
      c2.appendChild(note);
    }

    // Shell 类型把「命令」单独收在 textarea 里，不再有额外参数
    if (!isShellType(draft.type)) {
      const [, cell] = row("额外参数");
      input(
        cell,
        draft.args,
        draft.type === "custom" ? "原样传给程序" : "--dart-define=ENV=prod",
        (v) => {
          draft.args = v;
        },
      );
    }

    // 环境变量
    {
      const title = document.createElement("div");
      title.className = "set-title";
      title.style.marginTop = "14px";
      title.textContent = "环境变量";
      body.appendChild(title);

      const list = document.createElement("div");
      list.className = "env-list";

      draft.envPairs.forEach((pair, idx) => {
        const r = document.createElement("div");
        r.className = "env-row";

        const kEl = document.createElement("input");
        kEl.className = "set-input env-key";
        kEl.value = pair[0];
        kEl.placeholder = "KEY";
        kEl.addEventListener("input", () => {
          draft.envPairs[idx][0] = kEl.value;
        });

        const vEl = document.createElement("input");
        vEl.className = "set-input";
        vEl.value = pair[1];
        vEl.placeholder = "value";
        vEl.addEventListener("input", () => {
          draft.envPairs[idx][1] = vEl.value;
        });

        const del = document.createElement("button");
        del.className = "btn";
        del.textContent = "×";
        del.title = "删除该变量";
        del.addEventListener("click", () => {
          draft.envPairs.splice(idx, 1);
          void build();
        });

        r.append(kEl, vEl, del);
        list.appendChild(r);
      });

      const add = document.createElement("button");
      add.className = "btn";
      add.textContent = "＋ 添加变量";
      add.addEventListener("click", () => {
        draft.envPairs.push(["", ""]);
        void build();
      });
      list.appendChild(add);
      body.appendChild(list);
    }

    // 作用域（仅模板有意义）
    if (isTemplate) {
      const [, cell] = row("作用域");
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const sc of ["project", "global"]) {
        const o = document.createElement("option");
        o.value = sc;
        o.textContent =
          sc === "global"
            ? "全局（项目右键直接执行，无需加入项目）"
            : "项目（导入到项目后才能执行）";
        if (draft.scope === sc) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.scope = sel.value;
      });
      cell.appendChild(sel);
    }

    if (draft.type === "build") {
      const tip = document.createElement("div");
      tip.className = "set-desc";
      tip.style.marginTop = "10px";
      tip.textContent = "构建始终以 --release 执行；产物路径会在终端中解析，并在结束后发系统通知。";
      body.appendChild(tip);
    }
  };

  await build();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#cmd-cancel") as HTMLButtonElement).addEventListener("click", close);

  // 「从脚本导入…」：选一个 .ps1 / .sh / .py …，自动填好程序、参数和工作目录
  overlay.querySelector("#cmd-import-script")?.addEventListener("click", () => {
    void (async () => {
      try {
        const scriptPath = await pickScriptFile();
        if (!scriptPath) return;

        const info = await invoke<ScriptPreview>("preview_script_command", {
          path: scriptPath,
          projectId: p?.id ?? null,
          mode: "project",
        });

        draft.type = "custom";
        draft.name = uniqueCommandName(info.name);
        draft.program = info.program;
        draft.args = joinArgs(info.args);
        draft.cwd = info.cwd ?? "";
        draft.scriptNote = info.note;
        draft.pyScript = scriptPath;
        draft.pyVenv = info.venv;
        draft.pyVenvs = info.venvs;
        hint.textContent = "";

        await build();
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

  (overlay.querySelector("#cmd-examples") as HTMLButtonElement).addEventListener("click", () =>
    showUsageExamples((ex) => {
      // 示例都是 custom 的写法；新建时切过去，编辑已有命令时不偷偷改类型
      if (!existing) draft.type = "custom";
      draft.program = ex.program;
      draft.args = ex.args;
      draft.cwd = ex.cwd;
      draft.scope = ex.scope === "全局" ? "global" : "project";
      void build();
      toast("已填入表单，记得点「保存」");
    }),
  );
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector("#cmd-del")?.addEventListener("click", () => {
    void (async () => {
      if (!existing) return;
      const ok = await confirm(
        `删除${isTemplate ? "模板" : "命令"}「${existing.name}」？`,
        { title: isTemplate ? "删除模板" : "删除命令", kind: "warning" },
      );
      if (!ok) return;
      try {
        setState(isTemplate
          ? await invoke<State>("remove_template", { id: existing.id })
          : await invoke<State>("remove_command", {
              projectId: p!.id,
              commandId: existing.id,
            }));
        close();
        render();
        toast(isTemplate ? "模板已删除" : "命令已删除");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });

  (overlay.querySelector("#cmd-save") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      if (!draft.name.trim()) {
        hint.textContent = "请填写名称";
        return;
      }

      const shellSpec = isShellType(draft.type) ? SHELL_SPECS[draft.type] : null;
      if (shellSpec && !draft.script.trim()) {
        hint.textContent = "请填写要执行的命令";
        return;
      }

      // 编辑外部命令（npm / Docker / Qt）时保留原 kind：下拉框显示的是 custom，
      // 但执行方式由 source（及 program 是否为 .dart 入口）决定，改名字不该把它变成 flutter run。
      const externalExisting = isExternal && !shellSpec;
      const args = shellSpec ? shellSpec.wrap(draft.script.trim()) : splitArgs(draft.args);
      if (draft.type === "build" && draft.flavor.trim()) {
        args.unshift("--flavor", draft.flavor.trim());
      }

      const cmd: Cmd = {
        id: existing?.id ?? "",
        name: draft.name.trim(),
        // Shell 类型落盘仍是 custom，避免后端为每种 shell 再加一套分支
        kind: shellSpec ? "custom" : externalExisting ? (existing?.kind ?? draft.type) : draft.type,
        program: shellSpec
          ? shellSpec.exe
          : draft.type === "custom" || draft.type === "run"
            ? draft.program.trim() || null
            : null,
        cwd:
          shellSpec || draft.type === "custom" || draft.type === "run"
            ? draft.cwd.trim() || null
            : null,
        flutterMode: draft.type === "run" ? draft.mode : null,
        args,
        env: Object.fromEntries(
          draft.envPairs
            .filter(([k]) => k.trim() !== "")
            .map(([k, v]) => [k.trim(), v]),
        ),
        toolArgs: existing?.toolArgs ?? [],
        deviceId: existing?.deviceId ?? null,
        emulatorId: existing?.emulatorId ?? null,
        buildType: draft.type === "build" ? draft.target : null,
        source: isTemplate ? "template" : (existing?.source ?? "manual"),
        scope: isTemplate ? draft.scope : "project",
        // 编辑已有命令时保留来源归属：npm / docker / qt 的执行方式与节点折叠都读 source，
        // 写成 manual 会让「运行」掉进 flutter run 分支
        stale: existing?.stale ?? false,
        group: existing?.group ?? null,
        role: existing?.role ?? null,
      };

      try {
        setState(isTemplate
          ? await invoke<State>("upsert_template", { template: cmd })
          : await invoke<State>("upsert_command", { projectId: p!.id, command: cmd }));
        close();
        render();
        // 模板库窗口还开着时要立刻刷新，否则要关掉重开才看得到新模板
        if (isTemplate) templateListRefresh?.();
        toast(existing ? "已更新" : isTemplate ? "模板已保存" : "命令已添加");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 通用菜单（支持二级） ---------------- */
