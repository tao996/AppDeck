/* ============================================================
   AppDeck — Project Menu（由 main.ts 拆分而来）
   ============================================================ */
import { openAddCommand, openCustomCommandDialog } from "./commands";
import { CATEGORY_LABEL, CATEGORY_ORDER, editFile, esc, flutterInfo, openInFileExplorer, setState, state, templateCategory, toast } from "./core";
import { openDbInspector } from "./database";
import { launchingKeys, liveSessionFor, markLaunching, mountSession, replaceSessionInPlace, runCommand, runTemplate, staleSessionFor } from "./launcher";
import { joinArgs, setTemplateListRefresh } from "./menus";
import { openEnvDialog, openProjectTerminal } from "./panels";
import { importLaunch, openFlutterRename, removeProject, renameProject, rereadCompose, rereadPackage, rereadQt } from "./projects";
import { activateSession } from "./terminal";
import { projectLabel, render } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { Cmd, PlatformAction, PlatformMatrix, Proj, ProjectFiles, StartResponse, State, TermSession } from "./core";

export type MenuRow =
  | { kind: "group"; text: string }
  | { kind: "sep" }
  | {
      kind: "item";
      name: string;
      detail?: string;
      disabled?: boolean;
      onClick?: () => void;
      children?: MenuRow[];
      /** 点击后不关菜单（用于"原地刷新某一段"这类动作） */
      keepOpen?: boolean;
    };

/** 二级子菜单（本项目最多两层：右键菜单 → 平台 → 动作） */
export let subMenuEl: HTMLDivElement | null = null;

export function closeSubMenu(): void {
  subMenuEl?.remove();
  subMenuEl = null;
}

export let toolsMenuEl: HTMLDivElement | null = null;

export function closeAllMenus(): void {
  closeSubMenu();
  projMenuEl?.remove();
  projMenuEl = null;
  toolsMenuEl = null;
}

export function renderMenuRows(parent: HTMLDivElement, rows: MenuRow[]): void {
  for (const r of rows) {
    if (r.kind === "group") {
      const g = document.createElement("div");
      g.className = "dm-group";
      g.textContent = r.text;
      parent.appendChild(g);
      continue;
    }

    if (r.kind === "sep") {
      const s = document.createElement("div");
      s.className = "dm-sep";
      parent.appendChild(s);
      continue;
    }

    const el = document.createElement("div");
    el.className =
      "dm-item" + (r.disabled ? " disabled" : "") + (r.children ? " has-sub" : "");
    el.innerHTML = `
      <span class="dm-name">${esc(r.name)}</span>
      ${r.detail ? `<span class="dm-sub">${esc(r.detail)}</span>` : ""}
      ${r.children ? '<span class="dm-caret">▸</span>' : ""}
    `;

    // 鼠标移到任意一行：先关掉"不属于这一行"的二级菜单。
    // 否则从「平台」滑到 iOS 这类无子项的行，旧的平台子菜单会一直挂着。
    // 不能无脑 closeSubMenu()——本行若就在子菜单里，会把鼠标所在的菜单删掉。
    el.addEventListener("mouseenter", () => {
      if (subMenuEl && !subMenuEl.contains(el)) closeSubMenu();
    });

    if (r.disabled) {
      el.title = r.detail ?? "";
    } else if (r.children) {
      el.addEventListener("mouseenter", () => {
        closeSubMenu();
        openSubMenu(el, r.children!);
      });
      // 除了悬停，点击也能展开二级菜单（触摸/点击操作更直观）
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSubMenu();
        openSubMenu(el, r.children!);
      });
    } else {
      el.addEventListener("click", () => {
        // keepOpen：原地刷新某一段（如「平台」），菜单保持打开
        if (!r.keepOpen) closeAllMenus();
        r.onClick?.();
      });
    }

    parent.appendChild(el);
  }
}

export function openSubMenu(anchor: HTMLElement, rows: MenuRow[]): void {
  const sub = document.createElement("div");
  sub.className = "device-menu sub";
  sub.innerHTML = `<div class="dm-body"></div>`;
  document.body.appendChild(sub);
  renderMenuRows(sub.querySelector(".dm-body") as HTMLDivElement, rows);

  const r = anchor.getBoundingClientRect();
  const w = sub.offsetWidth || 240;
  const h = sub.offsetHeight || 200;

  // 右侧放不下就翻到左边
  let left = r.right + 2;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 2);

  let top = r.top;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);

  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
  subMenuEl = sub;

  sub.addEventListener("mouseleave", () => {
    window.setTimeout(() => {
      if (subMenuEl === sub && !sub.matches(":hover")) closeSubMenu();
    }, 180);
  });
}

/* ---------------- 项目右键：平台 / 全局命令 / 项目命令 ---------------- */

export let projMenuEl: HTMLDivElement | null = null;
/** 开发期：自动展开指定平台子菜单，便于无人值守截图 */
export let devSubmenu: string | null = null;

export function openProjectMenu(ev: MouseEvent, p: Proj): void {
  // 文件夹项目没有可解析的配置文件：直接出精简菜单，省一次后端往返
  if (p.kind === "folder") {
    renderFolderMenu(ev, p);
    return;
  }

  // 先看目录里有没有 package.json / compose 文件，再决定菜单项（几毫秒，用户感知不到）
  void (async () => {
    let files: ProjectFiles = {
      packageJson: null,
      compose: null,
      android: false,
      qt: false,
      cmakePresets: null,
    };
    try {
      files = await invoke<ProjectFiles>("project_files", { path: p.path });
    } catch {
      /* 读不到就当没有：少两项菜单，不影响其它功能 */
    }
    renderProjectMenu(ev, p, files);
  })();
}

/**
 * 文件夹项目的右键：只保留四个通用操作。
 *
 * 它没有平台、没有可重读的生态文件，把 Flutter / Compose / 数据库那套菜单挂上来
 * 只会让人以为这个目录被识别成了什么工程。
 */
export function renderFolderMenu(ev: MouseEvent, p: Proj): void {
  closeAllMenus();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 320)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 240)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>${esc(projectLabel(p))}</span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const gitReady = (state.settings?.git?.desktopPath ?? "").trim() !== "";

  const rows: MenuRow[] = [
    {
      kind: "item",
      name: "在终端中打开",
      detail: "注入项目环境后开一个交互终端",
      onClick: () => void openProjectTerminal(p),
    },
    {
      kind: "item",
      name: "用编辑器打开目录",
      detail: "用默认编辑器打开该文件夹",
      onClick: () => void editFile(p.path),
    },
    {
      kind: "item",
      name: "在文件管理器中打开",
      detail: "用资源管理器打开该文件夹",
      onClick: () => void openInFileExplorer(p.path),
    },
    gitReady
      ? {
          kind: "item",
          name: "在 Git Desktop 中打开",
          detail: "GitHub Desktop 等客户端，直接打开该目录",
          onClick: () => {
            void invoke("open_in_git_desktop", { path: p.path }).catch((e) =>
              toast(String(e), "error"),
            );
          },
        }
      : {
          kind: "item",
          name: "在 Git Desktop 中打开",
          detail: "未配置：设置 → Git",
          disabled: true,
        },
    { kind: "sep" },
    {
      kind: "item",
      name: "添加命令",
      detail: "程序 / 参数 / 工作目录 / 环境变量",
      onClick: () => openAddCommand(p),
    },
    { kind: "sep" },
    {
      kind: "item",
      name: "重命名项目…",
      detail: "只改显示名，不动磁盘目录",
      onClick: () => void renameProject(p),
    },
    {
      kind: "item",
      name: "移除项目…",
      detail: "仅从项目列表移除，不影响磁盘文件",
      onClick: () => void removeProject(p),
    },
  ];

  const box = document.createElement("div");
  (menu.querySelector(".dm-body") as HTMLDivElement).appendChild(box);
  renderMenuRows(box, rows);
}

export function renderProjectMenu(ev: MouseEvent, p: Proj, files: ProjectFiles): void {
  closeAllMenus();

  // 命令集（无 pubspec 的 workspace）本身就是命令列表：不显示平台，也不显示全局命令
  const isCommandSet = p.kind !== "single";

  // 生态判定：看它有哪些来源的命令（一个目录可能同时有 npm / docker / qt）
  const dockerCmds = p.commands.filter((c) => c.source === "docker");
  const npmCmds = p.commands.filter((c) => c.source === "npm");
  const qtCmds = p.commands.filter((c) => c.source === "qt");
  const launchCmds = p.commands.filter((c) => c.source === "launch-json");
  const ecoTag = dockerCmds.length
    ? "Docker"
    : npmCmds.length
      ? "Npm"
      : qtCmds.length
        ? "Qt"
        : "命令集";

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 360)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 420)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>${esc(projectLabel(p))}${isCommandSet ? ` <span class="dm-tag">${ecoTag}</span>` : ""}</span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  projMenuEl = menu;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  // 0) Compose 项目级动作（全部启动 / 全部日志 / 全部停止）
  if (dockerCmds.length) {
    const pick = (role: string): Cmd | undefined =>
      dockerCmds.find((c) => c.role === role && !c.group);

    const upAll = pick("up-all");
    const logsAll = pick("logs-all");
    const down = pick("down");

    const rows: MenuRow[] = [{ kind: "group", text: "Compose" }];
    if (upAll) {
      rows.push({
        kind: "item",
        name: "全部启动",
        detail: "up -d，后台运行所有服务",
        onClick: () => void runCommand(p, upAll),
      });
    }
    if (logsAll) {
      rows.push({
        kind: "item",
        name: "全部日志",
        detail: "logs -f，持续输出",
        onClick: () => void runCommand(p, logsAll),
      });
    }
    if (down) {
      rows.push({
        kind: "item",
        name: "全部停止",
        detail: "down：删除容器与网络（卷保留）",
        onClick: () => void runCommand(p, down),
      });
    }

    const box = document.createElement("div");
    body.appendChild(box);
    renderMenuRows(box, rows);
  }

  // 1) 平台（仅 Flutter 项目）
  let platformBox: HTMLDivElement | null = null;
  if (!isCommandSet) {
    platformBox = document.createElement("div");
    platformBox.innerHTML = `<div class="dm-group">平台 · 正在分析…</div>`;
    body.appendChild(platformBox);
    void loadPlatformRows(p, platformBox, menu);
  }

  // 2) 全局命令
  if (!isCommandSet) {
    const globals = state.commandTemplates.filter((t) => t.scope === "global");
    const rows: MenuRow[] = [{ kind: "group", text: `全局命令 (${globals.length})` }];

    if (globals.length === 0) {
      rows.push({
        kind: "item",
        name: "（暂无全局模板）",
        detail: "设置 → 命令模板 → 作用域选「全局」",
        disabled: true,
      });
    }
    for (const t of globals) {
      rows.push({
        kind: "item",
        name: t.name,
        detail: [t.kind, t.buildType, t.args.join(" ")].filter(Boolean).join(" · "),
        onClick: () => void runTemplate(p, t),
      });
    }

    const box = document.createElement("div");
    body.appendChild(box);
    renderMenuRows(box, rows);
  }

  // 3) 项目级操作
  const tail: MenuRow[] = [{ kind: "sep" }];

  if (!isCommandSet) {
    tail.push({
      kind: "item",
      name: "重新分析平台信息",
      detail: "刷新宿主可构建的平台与该平台设备",
      // 不关菜单：只把「平台」那一段原地刷新（关掉再开等于闪一下，还会丢滚动位置）
      keepOpen: true,
      onClick: () => {
        if (platformBox) {
          platformBox.innerHTML = `<div class="dm-group">平台 · 正在重新分析…</div>`;
        }
        void (async () => {
          try {
            await invoke("platform_matrix", { projectId: p.id, force: true });
            if (platformBox) await loadPlatformRows(p, platformBox, menu);
            toast("平台信息已刷新");
          } catch (e) {
            toast(String(e), "error");
            if (platformBox) await loadPlatformRows(p, platformBox, menu);
          }
        })();
      },
    });
  }

  tail.push({
    kind: "item",
    name: "在终端中打开",
    detail: "注入项目环境后开一个交互终端",
    onClick: () => void openProjectTerminal(p),
  });

  tail.push({
    kind: "item",
    name: "用编辑器打开目录",
    detail: "用默认编辑器打开项目文件夹（整个目录当工作区）",
    onClick: () => void editFile(p.path),
  });

  tail.push({
    kind: "item",
    name: "在文件管理器中打开",
    detail: "用资源管理器打开项目文件夹",
    onClick: () => void openInFileExplorer(p.path),
  });

  // 只有真正的 Android 工程才有「数据库」可看（工作区/命令集没有 applicationId）
  if (files.android) {
    tail.push({
      kind: "item",
      name: "数据库…",
      detail: "只读查看设备上应用的 SQLite（支持 SQL 查询）",
      onClick: () => void openDbInspector(p),
    });
  }

  // 只有设置里填了程序才显示：没配置的人不需要看到一个点了必然报错的菜单项
  if ((state.settings?.git?.desktopPath ?? "").trim()) {
    tail.push({
      kind: "item",
      name: "在 Git Desktop 中打开",
      detail: "GitHub Desktop 等客户端，直接打开项目目录",
      onClick: () => {
        void invoke("open_in_git_desktop", { path: p.path }).catch((e) =>
          toast(String(e), "error"),
        );
      },
    });
  }

  if (!isCommandSet) {
    tail.push({
      kind: "item",
      name: "环境变量…",
      detail: "鸿蒙工程的全局 / 项目级变量与 PATH shim",
      onClick: () => void openEnvDialog(p),
    });
  }

  // 按项目"有什么文件"决定重读哪一份（以前一律显示 launch.json，对 docker/npm 项目是错的）
  if (files.compose) {
    const name = files.compose.split(/[\\/]/).pop() ?? "docker-compose.yaml";
    tail.push({
      kind: "item",
      name: `编辑 ${name}`,
      detail: "用默认编辑器打开",
      onClick: () => void editFile(files.compose!),
    });
  }
  if (files.packageJson) {
    tail.push({
      kind: "item",
      name: "编辑 package.json",
      detail: "用默认编辑器打开",
      onClick: () => void editFile(files.packageJson!),
    });
  }
  if (files.cmakePresets) {
    tail.push({
      kind: "item",
      name: "编辑 CMakePresets.json",
      detail: "用默认编辑器打开",
      onClick: () => void editFile(files.cmakePresets!),
    });
  }

  if (dockerCmds.length) {
    tail.push({
      kind: "item",
      name: "重新读取 docker-compose.yaml",
      detail: "按 compose 文件刷新服务列表",
      onClick: () => void rereadCompose(p),
    });
  }
  if (npmCmds.length) {
    tail.push({
      kind: "item",
      name: "重新读取 package.json",
      detail: "按 scripts 刷新命令",
      onClick: () => void rereadPackage(p),
    });
  }
  if (launchCmds.length) {
    tail.push({
      kind: "item",
      name: "重新读取 launch.json",
      detail: "按 .vscode/launch.json 刷新命令",
      onClick: () => void importLaunch(p.id),
    });
  }
  if (qtCmds.length || files.qt) {
    tail.push({
      kind: "item",
      name: "重新读取 Qt / CMake",
      detail: "按 CMakePresets.json 刷新配置 / 构建命令",
      onClick: () => void rereadQt(p),
    });
  }

  tail.push(
    {
      kind: "item",
      name: "从模板导入…",
      detail: "把模板加入本项目",
      onClick: () => openTemplateImport(p),
    },
    {
      kind: "item",
      name: "添加命令…",
      detail:
        p.kind === "single"
          ? "新建 run / build / custom 命令"
          : "程序 / 参数 / 工作目录 / 环境变量",
      onClick: () => openAddCommand(p),
    },
  );

  // 仅 Flutter 工程显示；文件夹项目没有 pubspec/平台目录
  if (p.kind !== "folder" && flutterInfo.get(p.id)?.ok) {
    tail.push({
      kind: "item",
      name: "Flutter 重命名…",
      detail: "包名 / 应用名称（rename CLI）",
      onClick: () => void openFlutterRename(p),
    });
  }

  tail.push(
    { kind: "sep" },
    {
      kind: "item",
      name: "重命名项目…",
      detail: "只改显示名，不动磁盘目录",
      onClick: () => void renameProject(p),
    },
    {
      kind: "item",
      name: "移除项目…",
      detail: "仅从项目列表移除，不影响磁盘文件",
      onClick: () => void removeProject(p),
    },
  );

  const box = document.createElement("div");
  body.appendChild(box);
  renderMenuRows(box, tail);
}

/** 平台行渲染。结果由后端缓存，只有「重新分析」才会真正重算。 */
export async function loadPlatformRows(
  p: Proj,
  box: HTMLDivElement,
  menu: HTMLDivElement,
): Promise<void> {
  try {
    const m = await invoke<PlatformMatrix>("platform_matrix", { projectId: p.id });
    if (projMenuEl !== menu) return;
    box.innerHTML = "";

    const rows: MenuRow[] = [{ kind: "group", text: "平台" }];
    for (const pf of m.platforms) {
      if (!pf.enabled) {
        rows.push({
          kind: "item",
          name: pf.label,
          detail: pf.reason ?? "当前不可用",
          disabled: true,
        });
        continue;
      }
      const usable = pf.actions.filter((a) => a.enabled).length;
      const total = pf.actions.length;
      rows.push({
        kind: "item",
        name: pf.label,
        detail: [
          usable === total ? `${total} 个动作` : `${usable}/${total} 可用`,
          pf.device ?? "无设备",
        ].join(" · "),
        children: [
          // 展开后第一行直接告诉你"跑在哪台设备上"，省得再回上一级看
          { kind: "group" as const, text: `设备 · ${pf.device ?? "无"}` },
          ...pf.actions.map((a) => ({
            kind: "item" as const,
            name: a.command,
            detail: a.enabled ? a.label : `${a.label} · ${a.reason ?? "不可用"}`,
            disabled: !a.enabled,
            onClick: () => void runPlatformAction(p, pf.id, a),
          })),
        ],
      });
    }
    renderMenuRows(box, rows);

    // 开发期：自动展开某个平台，便于截图
    if (devSubmenu) {
      const el = Array.from(box.querySelectorAll<HTMLDivElement>(".dm-item.has-sub")).find(
        (x) => x.querySelector(".dm-name")?.textContent === devSubmenu,
      );
      if (el) el.dispatchEvent(new MouseEvent("mouseenter"));

      // 开发期：再"悬停"到另一行，验证旧子菜单是否被关掉
      const hover = await invoke<string | null>("dev_env", { name: "FLA_HOVER" });
      if (hover) {
        const row = Array.from(
          box.parentElement!.querySelectorAll<HTMLDivElement>(".dm-item"),
        ).find((x) => x.querySelector(".dm-name")?.textContent === hover);
        if (row) row.dispatchEvent(new MouseEvent("mouseenter"));
      }
    }
  } catch (e) {
    if (projMenuEl !== menu) return;
    box.innerHTML = "";
    renderMenuRows(box, [{ kind: "group", text: "平台" }]);
    const err = document.createElement("div");
    err.className = "dm-error";
    err.textContent = String(e);
    box.appendChild(err);
  }
}

export async function runPlatformAction(
  p: Proj,
  platform: string,
  a: PlatformAction,
  /** 「重跑」时传旧会话 id：新会话挂上后原位替换旧的（不是追加到末尾） */
  replaceId?: string,
): Promise<void> {
  const sameAction = (s: TermSession): boolean =>
    s.projectId === p.id &&
    s.platform === platform &&
    s.action === a.action &&
    (s.target ?? "") === (a.target ?? "");

  // 同一个平台动作已经在跑：切回已有标签，别重复起进程（重跑路径跳过这层）
  if (!replaceId) {
    const live = liveSessionFor(sameAction);
    if (live) {
      activateSession(live.id);
      toast(`该动作已在运行：${live.title}`);
      return;
    }
  }

  const stale = staleSessionFor(sameAction);

  const key = `plat|${p.id}|${platform}|${a.action}|${a.target ?? ""}`;
  if (markLaunching(key)) return;

  try {
    const res = await invoke<StartResponse>("start_platform_action", {
      projectId: p.id,
      platform,
      action: a.action,
      target: a.target ?? null,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(
      res,
      a.action === "build" ? "build" : "run",
      a.action === "profile" ? "profile" : "debug",
      {
        projectId: p.id,
        platform,
        action: a.action,
        target: a.target ?? undefined,
      },
    );
    const oldId = replaceId ?? stale?.id;
    if (oldId && oldId !== session.id) replaceSessionInPlace(oldId, session.id);
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launchingKeys.delete(key);
  }
}

/* ---------------- 命令模板库 ---------------- */

export function openTemplateManager(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 960px">
      <div class="modal-head">
        <span>命令模板库</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="tpl-body"></div>
      <div class="modal-foot">
        <span class="modal-hint">新建「单应用」项目时会自动套用这些模板</span>
        <span class="flex1"></span>
        <button class="btn" id="tpl-new">添加</button>
        <button class="btn primary" id="tpl-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const body = overlay.querySelector("#tpl-body") as HTMLDivElement;
  const close = (): void => {
    setTemplateListRefresh(null);
    overlay.remove();
  };

  const renderList = (): void => {
    body.innerHTML = `
      <table class="tpl-table">
        <thead><tr><th>名称</th><th>命令（程序 + 参数）</th><th>分类</th><th>操作</th></tr></thead>
        <tbody id="tpl-rows"></tbody>
      </table>
    `;
    const rowsEl = body.querySelector("#tpl-rows") as HTMLTableSectionElement;

    if (state.commandTemplates.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="tpl-empty">模板库为空，点「＋ 添加自定义命令」添加。</td>`;
      rowsEl.appendChild(tr);
      return;
    }

    // 按分类分组显示（flutter → npm → docker → 其他），组内按名字排
    const ordered = [...state.commandTemplates].sort((a, b) => {
      const d =
        CATEGORY_ORDER.indexOf(templateCategory(a) as (typeof CATEGORY_ORDER)[number]) -
        CATEGORY_ORDER.indexOf(templateCategory(b) as (typeof CATEGORY_ORDER)[number]);
      return d !== 0 ? d : a.name.localeCompare(b.name, "zh");
    });

    let lastCategory = "";
    for (const t of ordered) {
      const cat = templateCategory(t);
      if (cat !== lastCategory) {
        lastCategory = cat;
        const head = document.createElement("tr");
        head.className = "tpl-group-row";
        head.innerHTML = `<td colspan="4">${esc(CATEGORY_LABEL[cat] ?? cat)}</td>`;
        rowsEl.appendChild(head);
      }

      const row = document.createElement("tr");
      row.className = "tpl-row";

      const nameTd = document.createElement("td");
      nameTd.innerHTML = `<span class="tpl-name">${esc(t.name)}</span>`;

      // 程序 + 参数合成一列，允许换行；用 textContent 避免路径里的特殊字符被当成 HTML
      const cmdTd = document.createElement("td");
      cmdTd.className = "tpl-cmd-cell";
      const prog = (t.program ?? "").trim();
      const argText = joinArgs(t.args ?? []);
      if (prog) {
        const p = document.createElement("code");
        p.className = "tpl-cmd-prog";
        p.textContent = prog;
        cmdTd.appendChild(p);
      }
      if (argText) {
        if (prog) cmdTd.appendChild(document.createTextNode(" "));
        const a = document.createElement("code");
        a.className = "tpl-cmd-args";
        a.textContent = argText;
        cmdTd.appendChild(a);
      }
      if (!prog && !argText) cmdTd.textContent = "—";

      const catTd = document.createElement("td");
      // 分类可直接改（改了就落盘，用于纠正自动推断）
      const catSel = document.createElement("select");
      catSel.className = "set-input tpl-cat";
      catSel.title = "模板分类";
      for (const c of CATEGORY_ORDER) {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = CATEGORY_LABEL[c];
        opt.selected = cat === c;
        catSel.appendChild(opt);
      }
      catSel.addEventListener("change", () => {
        void (async () => {
          try {
            setState(await invoke<State>("upsert_template", {
              template: { ...t, category: catSel.value },
            }));
            renderList();
            render();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });
      catTd.appendChild(catSel);

      const actTd = document.createElement("td");
      actTd.className = "tpl-actions";
      const edit = document.createElement("button");
      edit.className = "btn";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => void openCustomCommandDialog(undefined, undefined, true, t));

      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "删除";
      del.addEventListener("click", () => {
        void (async () => {
          const ok = await confirm(`删除模板「${t.name}」？`, {
            title: "删除模板",
            kind: "warning",
          });
          if (!ok) return;
          try {
            setState(await invoke<State>("remove_template", { id: t.id }));
            renderList();
            render();
            toast("模板已删除");
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });
      actTd.append(edit, del);

      row.append(nameTd, cmdTd, catTd, actTd);
      rowsEl.appendChild(row);
    }
  };

  renderList();
  // 让「新建/编辑模板」保存后能立刻刷新这个列表（否则得关掉重开才看到）
  setTemplateListRefresh(renderList);

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#tpl-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#tpl-new") as HTMLButtonElement).addEventListener("click", () => {
    void openCustomCommandDialog(undefined, undefined, true);
  });
}

export function openTemplateImport(p: Proj): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 680px">
      <div class="modal-head">
        <span>从模板导入 · ${esc(p.name)}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="imp-filter" id="imp-filter"></div>
      <div class="modal-body" id="imp-body"></div>
      <div class="modal-foot">
        <span class="modal-hint" id="imp-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="imp-all">全选</button>
        <button class="btn" id="imp-none">全不选</button>
        <button class="btn" id="imp-cancel">取消</button>
        <button class="btn primary" id="imp-go">导入</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#imp-body") as HTMLDivElement;
  const hint = overlay.querySelector("#imp-hint") as HTMLSpanElement;
  const selected = new Set<string>();
  const close = (): void => overlay.remove();

  const updateHint = (): void => {
    hint.textContent = `已选 ${selected.size} / ${state.commandTemplates.length}`;
  };

  const filterBar = overlay.querySelector("#imp-filter") as HTMLDivElement;
  let filter = "all";

  const renderFilter = (): void => {
    filterBar.innerHTML = "";
    const opts: [string, string][] = [
      ["all", "全部"],
      ...CATEGORY_ORDER.map((c) => [c, CATEGORY_LABEL[c]] as [string, string]),
    ];
    for (const [value, label] of opts) {
      const n =
        value === "all"
          ? state.commandTemplates.length
          : state.commandTemplates.filter((t) => templateCategory(t) === value).length;
      const chip = document.createElement("button");
      chip.className = "chip imp-chip" + (filter === value ? " on" : "");
      chip.textContent = n > 0 ? `${label} ${n}` : label;
      chip.disabled = n === 0;
      chip.addEventListener("click", () => {
        filter = value;
        renderFilter();
        renderList();
      });
      filterBar.appendChild(chip);
    }
  };

  const renderList = (): void => {
    body.innerHTML = "";
    if (state.commandTemplates.length === 0) {
      const e = document.createElement("div");
      e.className = "set-desc";
      e.textContent = "模板库为空，请先到「设置 → 命令模板」里添加。";
      body.appendChild(e);
      updateHint();
      return;
    }

    for (const t of state.commandTemplates) {
      if (filter !== "all" && templateCategory(t) !== filter) continue;

      const row = document.createElement("label");
      row.className = "imp-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(t.id);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(t.id);
        else selected.delete(t.id);
        updateHint();
      });

      const main = document.createElement("div");
      main.className = "imp-main";
      main.innerHTML = `
        <span class="tpl-name">${esc(t.name)}</span>
        <span class="chip ${t.kind === "build" ? "src-custom" : "src-fvm"}">${esc(t.kind)}</span>
        ${t.buildType ? `<span class="fver">${esc(t.buildType)}</span>` : ""}
        ${t.flutterMode ? `<span class="fver">${esc(t.flutterMode)}</span>` : ""}
        <span class="tpl-args">${esc(t.args.join(" "))}</span>
      `;

      row.append(cb, main);
      body.appendChild(row);
    }
    updateHint();
  };

  renderFilter();
  renderList();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#imp-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#imp-all") as HTMLButtonElement).addEventListener("click", () => {
    // 只全选当前筛选下看得见的，避免"看不见的被选中"
    for (const t of state.commandTemplates) {
      if (filter === "all" || templateCategory(t) === filter) selected.add(t.id);
    }
    renderList();
  });
  (overlay.querySelector("#imp-none") as HTMLButtonElement).addEventListener("click", () => {
    selected.clear();
    renderList();
  });

  (overlay.querySelector("#imp-go") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      if (selected.size === 0) {
        hint.textContent = "请至少选择一条模板";
        return;
      }
      try {
        const res = await invoke<{ state: State; added: number }>("import_templates", {
          projectId: p.id,
          templateIds: [...selected],
        });
        setState(res.state);
        close();
        render();
        toast(
          res.added === 0 ? "所选命令已存在，未新增" : `已导入 ${res.added} 条命令`,
        );
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 模拟器菜单（工具栏） ---------------- */

// ---- 跨模块状态写入器（拆分脚本生成） ----
export function setDevSubmenu(v: typeof devSubmenu): void { devSubmenu = v; }
export function setProjMenuEl(v: typeof projMenuEl): void { projMenuEl = v; }
export function setToolsMenuEl(v: typeof toolsMenuEl): void { toolsMenuEl = v; }
