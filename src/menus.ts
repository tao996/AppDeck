/* ============================================================
   AppDeck — Menus（由 main.ts 拆分而来）
   ============================================================ */
import { openCommandDialog } from "./command-dialog";
import { esc, setState, toast } from "./core";
import { runCommand } from "./launcher";
import { closeAllMenus, renderMenuRows, setProjMenuEl } from "./project-menu";
import { render } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { Cmd, DevicesPayload, Proj, State } from "./core";
import type { MenuRow } from "./project-menu";

/* ---------------- 设备菜单（M3） ---------------- */

export let deviceMenuEl: HTMLDivElement | null = null;

export function closeDeviceMenu(): void {
  deviceMenuEl?.remove();
  deviceMenuEl = null;
}

/** 服务节点右键：停止 / 重启 / 删除容器 / 日志 / 进入 shell */
export function openServiceMenu(
  ev: MouseEvent,
  p: Proj,
  service: string,
  actions: Cmd[],
): void {
  closeAllMenus();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 340)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 360)}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>📦 ${esc(service)} <span class="dm-tag">服务</span></span>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  setProjMenuEl(menu);

  const byRole = (role: string): Cmd | undefined => actions.find((a) => a.role === role);

  const rows: MenuRow[] = [];

  const start = byRole("up");
  if (start) {
    rows.push({
      kind: "item",
      name: "启动",
      detail: "up -d（后台运行）",
      onClick: () => void runCommand(p, start),
    });
  }

  const stop = byRole("stop");
  if (stop) {
    rows.push({
      kind: "item",
      name: "停止",
      detail: "容器保留，可再次启动",
      onClick: () => void runCommand(p, stop),
    });
  }

  const restart = byRole("restart");
  if (restart) {
    rows.push({
      kind: "item",
      name: "重启",
      detail: "不重建容器",
      onClick: () => void runCommand(p, restart),
    });
  }

  const logs = byRole("logs");
  if (logs) {
    rows.push({
      kind: "item",
      name: "日志",
      detail: "logs -f，持续输出",
      onClick: () => void runCommand(p, logs),
    });
  }

  const shell = byRole("shell");
  if (shell) {
    rows.push({
      kind: "item",
      name: "进入 shell",
      detail: "exec sh，退出即结束",
      onClick: () => void runCommand(p, shell),
    });
  }

  const rm = byRole("rm");
  if (rm) {
    rows.push({ kind: "sep" });
    rows.push({
      kind: "item",
      name: "删除容器…",
      detail: "rm -f -s：容器删除，卷保留",
      onClick: () => {
        void (async () => {
          const ok = await confirm(
            `删除服务「${service}」的容器？\n\n` +
              `docker compose rm -f -s ${service}\n\n` +
              `容器会被删除（不可撤销），数据卷默认保留。`,
            { title: "删除容器", kind: "warning" },
          );
          if (ok) void runCommand(p, rm);
        })();
      },
    });
  }

  const box = document.createElement("div");
  menu.querySelector(".dm-body")!.appendChild(box);
  renderMenuRows(box, rows);
}

/**
 * 这条命令是否真的需要挑设备。
 *
 * 只有「跑起来并连设备」的 flutter run 类命令才有意义；
 * npm / docker / build / 模板命令（如 Pub Get）跟设备毫无关系，
 * 给它们弹「自动选择 / windows / chrome / Pixel5」是纯误导。
 */
export function needsDevice(c: Cmd): boolean {
  if (c.kind !== "run") return false;
  const src = (c.source ?? "").toLowerCase();
  if (src === "npm" || src === "docker") return false;
  // launch.json 里的命令都是 flutter run 配置，program 是空的（后端才拼 flutter run）
  if (src === "launch-json") return true;
  const prog = (c.program ?? "").toLowerCase();
  return prog.includes("flutter");
}

/** 命令右键：需要设备 → 设备菜单；否则 → 普通命令菜单 */
export function openCommandMenu(ev: MouseEvent, p: Proj, c: Cmd): void {
  if (needsDevice(c)) {
    openDeviceMenu(ev, p, c);
    return;
  }

  ev.preventDefault();
  closeDeviceMenu();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - 320))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - 220))}px`;
  menu.innerHTML = `
    <div class="dm-head">${esc(c.name)}</div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  deviceMenuEl = menu;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  const addGroup = (title: string): void => {
    const g = document.createElement("div");
    g.className = "dm-group";
    g.textContent = title;
    body.appendChild(g);
  };

  const addItem = (name: string, sub: string, onClick: () => void): void => {
    const item = document.createElement("div");
    item.className = "dm-item";
    item.innerHTML = `<span class="dm-name">${esc(name)}</span>${sub ? `<span class="dm-sub">${esc(sub)}</span>` : ""}`;
    item.addEventListener("click", () => {
      closeDeviceMenu();
      onClick();
    });
    body.appendChild(item);
  };

  // 运行提示按类型说清楚它会落在哪：普通命令进项目终端，run/build 各占一个标签
  const where =
    c.kind === "custom"
      ? "在项目终端里执行（跑完还能接着敲）"
      : c.kind === "build"
        ? "独立标签，结束发通知、识别产物"
        : "独立标签运行";

  addItem("运行", where, () => void runCommand(p, c));

  addGroup("命令");
  addItem("编辑命令…", "名称 / 参数 / 环境变量", () => void openCommandDialog(p, c));
  addItem("删除命令", "从项目里移除（不影响磁盘文件）", () => {
    void (async () => {
      const ok = await confirm(`删除命令「${c.name}」？`, {
        title: "删除命令",
        kind: "warning",
      });
      if (!ok) return;
      try {
        setState(await invoke<State>("remove_command", {
          projectId: p.id,
          commandId: c.id,
        }));
        render();
        toast("命令已删除");
      } catch (e) {
        toast(String(e), "error");
      }
    })();
  });
}

/** 设备/模拟器列表：查一次就缓存，之后靠菜单里的「刷新设备列表」手动更新。
 *  每次打开菜单都去问 flutter daemon 太浪费（首次要拉起 daemon，好几秒）。 */
export let devicePayloadCache: DevicesPayload | null = null;

export function openDeviceMenu(ev: MouseEvent, p: Proj, c: Cmd): void {
  ev.preventDefault();
  closeDeviceMenu();

  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - 320))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - 360))}px`;
  menu.innerHTML = `
    <div class="dm-head">为「${esc(c.name)}」选择设备</div>
    <div class="dm-body"><div class="dm-loading">正在查询设备…</div></div>
  `;
  document.body.appendChild(menu);
  deviceMenuEl = menu;
  const body = menu.querySelector(".dm-body") as HTMLDivElement;

  void (async () => {
    let payload: DevicesPayload | null = devicePayloadCache;
    let error: string | null = null;
    if (!payload) {
      try {
        payload = await invoke<DevicesPayload>("list_devices", { projectId: p.id });
        devicePayloadCache = payload;
      } catch (e) {
        error = String(e);
      }
      if (deviceMenuEl !== menu) return; // 期间已被关闭
    }
    body.innerHTML = "";

    const addGroup = (title: string): void => {
      const g = document.createElement("div");
      g.className = "dm-group";
      g.textContent = title;
      body.appendChild(g);
    };

    const addItem = (name: string, sub: string, onClick: () => void, cls = ""): void => {
      const item = document.createElement("div");
      item.className = `dm-item ${cls}`.trim();
      item.innerHTML = `<span class="dm-name">${esc(name)}</span>${sub ? `<span class="dm-sub">${esc(sub)}</span>` : ""}`;
      item.addEventListener("click", () => {
        closeDeviceMenu();
        onClick();
      });
      body.appendChild(item);
    };

    addItem("自动选择", "不传 -d，由 flutter 自行决定", () => void runCommand(p, c));

    if (error) {
      const e = document.createElement("div");
      e.className = "dm-error";
      e.textContent = error;
      body.appendChild(e);
      return;
    }

    const devices = payload?.devices ?? [];
    const emulators = payload?.emulators ?? [];

    addGroup(`在线设备 (${devices.length})`);
    if (devices.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dm-empty";
      empty.textContent = "暂无在线设备";
      body.appendChild(empty);
    } else {
      for (const d of devices) {
        addItem(d.name, `${d.id} · ${d.platform ?? d.category ?? ""}`, () =>
          void runCommand(p, c, d.id),
        );
      }
    }

    if (emulators.length > 0) {
      addGroup(`可启动模拟器 (${emulators.length})`);
      for (const m of emulators) {
        addItem(
          m.name,
          `${m.id} · ${m.category ?? ""}`,
          () => {
            toast(`正在启动模拟器：${m.name}`);
            void invoke("launch_emulator", { projectId: p.id, emulatorId: m.id }).catch((e2) =>
              toast(String(e2), "error"),
            );
          },
          "emulator",
        );
      }
    }

    addGroup("设备");
    addItem("⟳ 刷新设备列表", "重新查询（首次会拉起 flutter daemon，约几秒）", () => {
      devicePayloadCache = null;
      openDeviceMenu(ev, p, c);
    });

    addGroup("命令");
    addItem("编辑命令…", "名称 / 设备 / 参数 / 构建目标", () => void openCommandDialog(p, c));
  })();
}

/* ---------------- 命令编辑（M5：构建命令） ---------------- */

export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** splitArgs 的反向：含空格的参数加引号，保证对话框里"改一下再保存"不会把路径拆开 */
export function joinArgs(args: string[]): string {
  return args
    .map((a) => (a === "" || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
}

/**
 * 「从脚本导入」的文件选择。
 * 开发期可用 `FLA_IMPORT_SCRIPT=<路径>` 直接指定，方便自动化验证（不弹原生文件框）。
 */
export async function pickScriptFile(): Promise<string | null> {
  try {
    const hook = await invoke<string | null>("dev_env", { name: "FLA_IMPORT_SCRIPT" });
    if (hook && hook.trim()) return hook.trim();
  } catch {
    // 非 Tauri 环境（纯浏览器预览）忽略
  }

  const picked = await open({
    multiple: false,
    title: "选择要导入的脚本（.ps1 / .sh / .py …）",
    filters: [
      {
        name: "脚本",
        extensions: [
          "ps1", "bat", "cmd", "sh", "bash", "zsh",
          "py", "js", "mjs", "cjs", "rb", "pl", "php",
        ],
      },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked[0] : picked;
}

/** 常用配置示例：新用户不知道占位符和脚本怎么写，给一份可照抄的清单 */
export function showUsageExamples(
  apply: (ex: { program: string; args: string; cwd: string; scope: string }) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 760px">
      <div class="modal-head">
        <span>使用示例</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="ex-body"></div>
      <div class="modal-foot">
        <span class="modal-hint">点示例右侧「填入」可直接写进当前表单</span>
        <span class="flex1"></span>
        <button class="btn primary" id="ex-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#ex-body") as HTMLDivElement;
  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#ex-close") as HTMLButtonElement).addEventListener("click", close);

  const note = document.createElement("div");
  note.className = "set-desc";
  note.textContent =
    "占位符：%FLUTTER% = 该项目的 flutter；%PROJECT% = 项目根目录；%CWD% = 实际工作目录。"
    + " program / args / cwd 里都能用。";
  body.appendChild(note);

  const examples: Array<{
    title: string;
    desc: string;
    program: string;
    args: string;
    cwd: string;
    scope: string;
  }> = [
    {
      title: "跑项目里的 PowerShell 脚本",
      desc: "自动用 PowerShell 执行（含 -ExecutionPolicy Bypass），以项目根为工作目录",
      program: String.raw`D:\demo\code\flutter\library\projects\jbook\build_abb.ps1`,
      args: "",
      cwd: "",
      scope: "项目",
    },
    {
      title: "脚本 + 传项目目录",
      desc: "把项目根作为命名参数传进去（位置参数可能被脚本当成别的选项）",
      program: String.raw`D:\path\to\i18n_update.ps1`,
      args: "-ScanDir %PROJECT%",
      cwd: "",
      scope: "全局",
    },
    {
      title: "只靠工作目录找项目",
      desc: "脚本自己从 cwd 向上找 pubspec.yaml —— 全局模板最常用，任何项目都能跑",
      program: String.raw`D:\path\to\tool.ps1`,
      args: "",
      cwd: "",
      scope: "全局",
    },
    {
      title: "用项目自己的 flutter",
      desc: "鸿蒙工程会自动指向鸿蒙分支；配合 args 可执行任意 flutter 子命令",
      program: "%FLUTTER%",
      args: "pub get",
      cwd: "",
      scope: "全局",
    },
    {
      title: "在子目录执行",
      desc: "cwd 相对项目根，也可用 %PROJECT% 显式拼接",
      program: "%FLUTTER%",
      args: "pub get",
      cwd: "%PROJECT%\\packages\\tao996",
      scope: "项目",
    },
    {
      title: "运行批处理",
      desc: ".bat / .cmd 会自动经 cmd.exe 包装，无需自己拼 cmd /c",
      program: String.raw`D:\path\to\build.bat`,
      args: "--release",
      cwd: "",
      scope: "项目",
    },
  ];

  for (const ex of examples) {
    const card = document.createElement("div");
    card.className = "ex-card";

    const head = document.createElement("div");
    head.className = "ex-head";

    const title = document.createElement("span");
    title.className = "ex-title";
    title.textContent = ex.title;

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = ex.scope;

    const fill = document.createElement("button");
    fill.className = "btn";
    fill.textContent = "填入";
    fill.addEventListener("click", () => {
      apply({ program: ex.program, args: ex.args, cwd: ex.cwd, scope: ex.scope });
      close();
      toast("已填入表单（记得点保存）");
    });

    head.append(title, chip, fill);
    card.appendChild(head);

    const desc = document.createElement("div");
    desc.className = "set-desc";
    desc.textContent = ex.desc;
    card.appendChild(desc);

    for (const [k, v] of [
      ["程序", ex.program],
      ["参数", ex.args || "（空）"],
      ["cwd", ex.cwd || "（空 = 项目根）"],
    ] as Array<[string, string]>) {
      const line = document.createElement("div");
      line.className = "ex-line";
      const key = document.createElement("span");
      key.className = "ex-key";
      key.textContent = k;
      const val = document.createElement("code");
      val.textContent = v;
      line.append(key, val);
      card.appendChild(line);
    }

    body.appendChild(card);
  }

  document.body.appendChild(overlay);
}

/** 模板库窗口开着时，保存模板后要立刻刷新列表（否则得关掉重开才看到） */
export let templateListRefresh: (() => void) | null = null;

/* ---------------- 命令类型：flutter / 自定义 / 三种 Shell ---------------- */

export type ShellType = "powershell" | "cmd" | "bash";
export type CmdType = "run" | "build" | "custom" | ShellType;

/**
 * Shell 类型只是「预设程序 + 参数包装」的 UI 糖：
 * 落盘仍是 kind=custom，后端无需区分；编辑时再按 program/args 反推回类型。
 */
export const SHELL_SPECS: Record<
  ShellType,
  {
    exe: string;
    label: string;
    placeholder: string;
    wrap: (script: string) => string[];
    note: string;
  }
> = {
  powershell: {
    exe: "powershell.exe",
    label: "PowerShell",
    placeholder: "Get-Process | Sort-Object WS -Descending | Select-Object -First 10",
    wrap: (script) => [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    note: "以 powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 执行。",
  },
  cmd: {
    exe: "cmd.exe",
    label: "CMD",
    placeholder: "dir /b",
    wrap: (script) => ["/C", script],
    note: "以 cmd.exe /C 执行，支持 && / || 等 CMD 语法。",
  },
  bash: {
    exe: "bash.exe",
    label: "Bash",
    placeholder: "ls -la",
    wrap: (script) => ["-lc", script],
    note: "以 bash.exe -lc 执行（PATH 中需要有 Git Bash / WSL 的 bash）。",
  },
};

export const isShellType = (t: string): t is ShellType =>
  t === "powershell" || t === "cmd" || t === "bash";

/** 选中 Shell 类型时自动填的名字：切类型时如果还是自动名字就跟着换 */
export const SHELL_AUTO_NAMES = new Set(
  Object.values(SHELL_SPECS).map((spec) => `${spec.label} 命令`),
);

/** 从已保存的命令反推 Shell 类型；不是我们生成的包装就返回 null */
export function shellTypeOf(c: Cmd | undefined): ShellType | null {
  if (!c || c.kind !== "custom") return null;

  const base = (c.program ?? "").trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const args = c.args ?? [];
  const flag = (name: string): boolean => args.some((a) => a.toLowerCase() === name);

  if (
    ["powershell.exe", "powershell"].includes(base) &&
    flag("-command")
  ) {
    return "powershell";
  }
  if (["cmd.exe", "cmd"].includes(base) && args[0]?.toLowerCase() === "/c") {
    return "cmd";
  }
  if (["bash.exe", "bash"].includes(base) && args[0] === "-lc") {
    return "bash";
  }
  return null;
}

/** 从包装参数里取回用户写的命令文本 */
export function shellScriptOf(c: Cmd, type: ShellType): string {
  const args = c.args ?? [];
  if (type === "powershell") {
    const i = args.findIndex((a) => a.toLowerCase() === "-command");
    return i >= 0 ? args.slice(i + 1).join(" ") : "";
  }
  return args.slice(1).join(" ");
}

// ---- 跨模块状态写入器（拆分脚本生成） ----
export function setTemplateListRefresh(v: typeof templateListRefresh): void { templateListRefresh = v; }
