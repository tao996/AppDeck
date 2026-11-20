/* ============================================================
   AppDeck — Tree（由 main.ts 拆分而来）
   ============================================================ */
import { openAddCommand } from "./commands";
import { SOURCE_TEXT, collapsed, esc, flutterInfo, req, scheduleSaveCollapsed, selectedCommand, sessions, setSelectedCommand, state, statePath } from "./core";
import { runCommand } from "./launcher";
import { openCommandMenu, openServiceMenu } from "./menus";
import { openProjectMenu, openTemplateImport } from "./project-menu";
import { renderTabs, updateControls, updateEmptyState } from "./terminal";
import type { Cmd, Proj } from "./core";

export function projectLabel(p: Proj): string {
  const same = state.projects.filter((x) => x.name === p.name);
  if (same.length <= 1) return p.name;

  const segs = p.path.split(/[\\/]+/).filter(Boolean);
  for (let k = 1; k < segs.length; k++) {
    const mine = segs[segs.length - 1 - k];
    const clash = same.some((o) => {
      if (o.id === p.id) return false;
      const os = o.path.split(/[\\/]+/).filter(Boolean);
      return os[os.length - 1 - k] === mine;
    });
    if (!clash) return `${p.name} ‹${mine}›`;
  }
  return `${p.name} ‹${p.path}›`;
}

/* ---------------- 渲染：项目树 ---------------- */

export function renderTree(): void {
  const tree = req<HTMLDivElement>("#tree");
  const countEl = req<HTMLSpanElement>("#proj-count");

  if (state.projects.length === 0) {
    countEl.textContent = "0 个项目";
    tree.innerHTML = `
      <div class="empty-tree">
        <div class="et-big">＋</div>
        <div class="et-title">还没有项目</div>
        <div class="et-sub">点击上方「添加 Flutter 项目」选择工程目录<br/>或在「导入 ▾」里「添加文件夹 / 目录」挂一个空目录<br/>再用「添加命令」或「从模板导入」补充</div>
      </div>`;
    return;
  }

  countEl.textContent = `${state.projects.length} 个项目 · ${visibleEntryCount()} 条命令`;
  tree.innerHTML = "";

  for (const p of state.projects) {
    const box = document.createElement("div");
    box.className = "proj";

    const isCollapsed = collapsed.has(p.id);
    // 文件夹项目不参与 Flutter 探测：没有 pubspec，显示「检测中… / 不可用」只会误导
    const isFolder = p.kind === "folder";
    const info = isFolder ? undefined : flutterInfo.get(p.id);
    const failed = info != null && !info.ok;
    const loading = info == null;

    const head = document.createElement("div");
    head.className = "proj-row" + (failed ? " warn" : "");
    head.title = p.path;

    const chipCls = loading ? "src-auto" : `src-${info.source}`;
    const chipTxt = loading ? "检测中…" : SOURCE_TEXT[info.source];

    // 徽章按"里面装了什么"来叫，而不是内部 kind：
    // 只有 npm / docker / qt 命令的项目分别叫「Npm」「Docker」「Qt」
    const hasNpm = p.commands.some((c) => c.source === "npm");
    const hasDocker = p.commands.some((c) => c.source === "docker");
    const hasQt = p.commands.some((c) => c.source === "qt");
    const only = (src: string): boolean =>
      p.commands.length > 0 && p.commands.every((c) => c.source === src);
    const kindLabel = isFolder
      ? "文件夹"
      : p.kind === "single"
        ? "Flutter"
        : only("docker")
          ? "Docker"
          : only("npm")
            ? "Npm"
            : only("qt")
              ? "Qt"
              : "工作区";
    const kindIcon = isFolder
      ? "📂"
      : p.kind === "single"
        ? "📁"
        : hasDocker
          ? "🐳"
          : hasNpm
            ? "📦"
            : hasQt
              ? "🔧"
              : "🗂";

    head.innerHTML = `
      <span class="chev">${isCollapsed ? "▸" : "▾"}</span>
      <span class="pico">${kindIcon}</span>
      <span class="pname">${esc(projectLabel(p))}</span>
      <span class="pmeta">
        <span class="chip kind-${p.kind}">${kindLabel}</span>
        ${
          isFolder
            ? ""
            : `${info?.source === "custom" ? "" : `<span class="chip ${chipCls}">${esc(chipTxt)}</span>`}
        ${info?.fvmVersion ? `<span class="chip chip-fvm" title="FVM 工程（.fvmrc 声明 ${esc(info.fvmVersion)}）">FVM</span>` : ""}`
        }
      </span>
    `;

    head.addEventListener("click", () => {
      if (collapsed.has(p.id)) collapsed.delete(p.id);
      else collapsed.add(p.id);
      renderTree();
      scheduleSaveCollapsed();
    });

    // 右键：全局命令可直接执行，无需先加入项目
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProjectMenu(e, p);
    });

    box.appendChild(head);

    if (!isCollapsed) {
      const list = document.createElement("div");
      list.className = "cmds";

      // Flutter 项目空命令是正常状态（能力在右键「平台 → 动作」），不提示；
      // 文件夹项目也不提示（用户明确要求去掉）；只有命令集为空才给一句引导
      if (p.commands.length === 0 && p.kind === "workspace") {
        const hint = document.createElement("div");
        hint.className = "cmd hint";
        hint.textContent = "尚无命令 —— 点上方「📂 导入 launch.json」选择该目录";
        list.appendChild(hint);
      }

      // docker：命令按 group 折叠成"服务"节点，动作进右键菜单
      const serviceGroups = new Map<string, Cmd[]>();
      for (const c of p.commands) {
        if (!c.group) continue;
        const arr = serviceGroups.get(c.group) ?? [];
        arr.push(c);
        serviceGroups.set(c.group, arr);
      }

      for (const [svc, actions] of serviceGroups) {
        const upCmd = actions.find((a) => a.role === "up");
        const stale = actions.every((a) => a.stale);

        const row = document.createElement("div");
        row.className = "cmd svc" + (stale ? " stale" : "");
        row.innerHTML = `
          <span class="cico">📦</span>
          <span class="cname">${esc(svc)}</span>
          ${stale ? `<span class="chip cmd-stale" title="compose 里已没有这个服务">已失效</span>` : ""}
          <span class="cnote">${actions.length} 个操作</span>
          <button class="run-btn" title="启动该服务（也可双击）">▶</button>
        `;
        row.title = [
          `服务 ${svc}`,
          upCmd ? `双击启动：${upCmd.program ?? ""} ${upCmd.args.join(" ")}` : "",
          "右键查看更多操作",
        ]
          .filter(Boolean)
          .join("\n");

        row.addEventListener("dblclick", (e) => {
          // 双击 ▶ 按钮时 click 已经跑过一次了，别再补一刀
          if ((e.target as HTMLElement).closest(".run-btn")) return;
          if (upCmd) void runCommand(p, upCmd);
        });
        row.querySelector(".run-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          if (upCmd) void runCommand(p, upCmd);
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openServiceMenu(e, p, svc, actions);
        });
        list.appendChild(row);
      }

      for (const c of p.commands) {
        // 归到服务的动作、以及项目级动作（up-all / logs-all / down）都不进列表
        if (c.group || c.role) continue;

        const row = document.createElement("div");
        row.className =
          "cmd" + (selectedCommand === c.id ? " selected" : "") + (c.stale ? " stale" : "");
        const mode = c.flutterMode ?? "debug";
        const icon =
          c.source === "npm"
            ? "⬢"
            : c.source === "docker"
              ? "🐳"
              : c.source === "qt"
                ? "🔧"
                : c.kind === "build"
                  ? "📦"
                  : "🚀";
        row.innerHTML = `
          <span class="cico">${icon}</span>
          <span class="cname">${esc(c.name)}</span>
          ${c.stale ? `<span class="chip cmd-stale" title="package.json 里已没有这个脚本">已失效</span>` : ""}
          ${mode !== "debug" ? `<span class="cmd-mode">${esc(mode)}</span>` : ""}
          <span class="cnote">${esc(c.cwd ?? "")}</span>
          <button class="run-btn" title="运行此命令（也可双击该行）">▶</button>
        `;
        row.title = [
          c.cwd ? `目录: ${c.cwd}` : "目录: 工作区根",
          c.args.length ? `参数: ${c.args.join(" ")}` : "",
          c.flutterMode ? `模式: ${c.flutterMode}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        row.addEventListener("click", () => selectCommand(c.id));
        row.addEventListener("dblclick", (e) => {
          // 双击 ▶ 按钮会先触发两次 click（各运行一次），这里不能再运行
          if ((e.target as HTMLElement).closest(".run-btn")) return;
          void runCommand(p, c);
        });
        row.querySelector(".run-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          void runCommand(p, c);
        });
        row.addEventListener("contextmenu", (e) => openCommandMenu(e, p, c));
        list.appendChild(row);
      }

      const addCmd = document.createElement("div");
      addCmd.className = "cmd add";
      addCmd.innerHTML = `<span class="cico">＋</span><span class="cname">添加命令</span>`;
      addCmd.title =
        p.kind === "single"
          ? "添加运行 / 构建命令"
          : "添加自定义命令（程序 / 参数 / 工作目录 / 环境变量）";
      addCmd.addEventListener("click", () => openAddCommand(p));
      list.appendChild(addCmd);

      const tplImport = document.createElement("div");
      tplImport.className = "cmd add";
      tplImport.innerHTML = `<span class="cico">⤓</span><span class="cname">从模板导入…</span>`;
      tplImport.title = "从全局命令模板中按需导入";
      tplImport.addEventListener("click", () => openTemplateImport(p));
      list.appendChild(tplImport);

      box.appendChild(list);
    }

    tree.appendChild(box);
  }
}

/** 树里真正显示的条目数：docker 命令折叠成服务节点、项目级动作藏在右键里，
 *  所以不能直接数 commands.length（否则状态栏数字和树对不上） */
export function visibleEntryCount(): number {
  let n = 0;
  for (const p of state.projects) {
    const groups = new Set<string>();
    for (const c of p.commands) {
      if (c.group) groups.add(c.group);
      else if (!c.role) n += 1;
    }
    n += groups.size;
  }
  return n;
}

/* ---------------- 渲染：状态栏 ---------------- */

export function renderStatus(): void {
  const el = req<HTMLSpanElement>("#sb-state");
  el.textContent = `${state.projects.length} 个项目 · ${visibleEntryCount()} 条命令`;
  el.title = statePath ? `状态文件：${statePath}` : "";
  const fname = statePath ? (statePath.split(/[\\/]/).pop() ?? "") : "";
  req<HTMLSpanElement>("#sb-path").textContent = fname;
  req<HTMLSpanElement>("#sb-path").title = statePath;

  const sbSess = req<HTMLSpanElement>("#sb-sessions");
  sbSess.textContent = `会话 ${sessions.length}`;
}

export function render(): void {
  renderTabs();
  renderTree();
  renderStatus();
  updateControls();
  updateEmptyState();
}

/* ---------------- 动作 ---------------- */

export function selectCommand(id: string): void {
  if (selectedCommand === id) return;
  setSelectedCommand(id);
  renderTree();
}

/** npm / docker / qt 是「外部程序」：后端直接执行 program+args，没有交互 shell。
 *  kind 同为 run，但它们的停止 / 重跑 / 状态判定和 flutter run 完全不同。 */
