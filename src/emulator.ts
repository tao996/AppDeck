/* ============================================================
   AppDeck — Emulator（由 main.ts 拆分而来）
   ============================================================ */
import { esc, state, toast } from "./core";
import { addFolder, addProject, importComposePath, importLaunchPath, importPackagePath, importQtPath } from "./projects";
import { invoke } from "@tauri-apps/api/core";
import type { AllEmulators } from "./core";

export let emuMenuEl: HTMLDivElement | null = null;
/** 模拟器列表缓存：模拟器不常变，没点刷新就直接用缓存，避免每次打开都重新查询 */
export let emulatorCache: AllEmulators | null = null;

export function closeEmuMenu(): void {
  emuMenuEl?.remove();
  emuMenuEl = null;
}

export function renderEmulatorBody(data: AllEmulators, error: string | null): void {
  const menu = emuMenuEl;
  if (!menu) return;

  // 标题栏右侧显示"设备更新于"：点了 ⟳ 有没有真的生效，一眼能看出来
  const stamp = menu.querySelector<HTMLSpanElement>(".dm-updated");
  if (stamp) {
    stamp.textContent = data.devicesAt
      ? `设备更新于 ${new Date(data.devicesAt).toLocaleTimeString()}`
      : "";
  }

  const body = menu.querySelector(".dm-body") as HTMLDivElement;
  body.innerHTML = "";

  const group = (t: string): void => {
    const g = document.createElement("div");
    g.className = "dm-group";
    g.textContent = t;
    body.appendChild(g);
  };
  const note = (t: string, cls = "dm-empty"): void => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = t;
    body.appendChild(d);
  };
  const item = (name: string, detail: string, onClick: () => void): void => {
    const el = document.createElement("div");
    el.className = "dm-item emulator";
    el.innerHTML = `<span class="dm-name">${esc(name)}</span>${detail ? `<span class="dm-sub">${esc(detail)}</span>` : ""}`;
    el.addEventListener("click", () => {
      closeEmuMenu();
      onClick();
    });
    body.appendChild(el);
  };

  if (error) {
    note(error, "dm-error");
    return;
  }

  // 已连接的设备放最前面：刚从手机插上就想确认"它认到了没"
  const connected = (data.devices ?? []).filter((d) => d.isConnected !== false);
  group(`已连接设备 (${connected.length})`);
  if (connected.length === 0) {
    note(
      "未检测到已连接设备（手机需开启 USB 调试并授权；插上后可再点 ⟳ 刷新）",
    );
  }
  for (const d of connected) {
    const sub = [d.id, d.sdk ?? d.platformType ?? d.category ?? ""].filter(Boolean).join(" · ");
    item(d.name, sub, () => {
      // 设备已经在跑，点它只是复制 id——真要跑请用命令/平台菜单
      void navigator.clipboard?.writeText(d.id).catch(() => undefined);
      toast(`已复制设备 ID：${d.id}`);
    });
  }

  group(`Android 模拟器 (${data.android.length})`);
  if (data.android.length === 0) note("无可用 AVD");
  for (const a of data.android) {
    item(a.name, a.detail, () => {
      const pid = state.projects[0]?.id;
      if (!pid) {
        toast("启动 Android 模拟器需要先添加一个 Flutter 项目", "error");
        return;
      }
      toast(`正在启动：${a.name}`);
      void invoke("launch_emulator", { projectId: pid, emulatorId: a.id }).catch((e2) =>
        toast(String(e2), "error"),
      );
    });
  }

  group(`HarmonyOS 模拟器 (${data.harmony.length})`);
  if (data.harmony.length === 0) note("未发现鸿蒙模拟器（可在设置里指定 DevEco 目录）");
  for (const h of data.harmony) {
    item(h.name, h.detail, () => {
      toast(`正在启动：${h.name}`);
      void invoke("launch_harmony_emulator", { name: h.id }).catch((e2) =>
        toast(String(e2), "error"),
      );
    });
  }

  if (data.notes.length > 0) {
    group("提示");
    for (const n of data.notes) note(n);
  }
}

/** 真正去查一次。force=false 时后端会用磁盘缓存（模拟器），设备每次都现查。
 *  quiet=true：不清空现有内容，静默刷新（打开菜单时先显示缓存、再补齐设备）。 */
export async function loadEmulators(force: boolean, quiet = false): Promise<void> {
  const menu = emuMenuEl;
  if (!menu) return;

  const body = menu.querySelector(".dm-body") as HTMLDivElement;
  const refresh = menu.querySelector<HTMLButtonElement>(".dm-refresh");
  if (!quiet) body.innerHTML = `<div class="dm-loading">正在检查电脑上的模拟器…</div>`;
  if (refresh) refresh.disabled = true;

  let data: AllEmulators | null = null;
  let error: string | null = null;
  try {
    data = await invoke<AllEmulators>("list_all_emulators", {
      projectId: state.projects[0]?.id ?? null,
      force,
    });
  } catch (e) {
    error = String(e);
  }

  if (emuMenuEl !== menu) return;
  if (refresh) refresh.disabled = false;

  if (data) emulatorCache = data;
  renderEmulatorBody(data ?? { android: [], harmony: [], notes: [] }, error);
}

/* ---------------- 工具栏「导入」菜单 ---------------- */

export let importMenuEl: HTMLDivElement | null = null;

export function closeImportMenu(): void {
  importMenuEl?.remove();
  importMenuEl = null;
}

/** 工具栏的「导入」下拉：项目 / 文件夹 / launch.json / package.json / compose */
export function openImportMenu(anchor: HTMLElement): void {
  if (importMenuEl) {
    closeImportMenu();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "device-menu import-menu";
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(menu);
  importMenuEl = menu;

  type Item = {
    icon: string;
    label: string;
    hint: string;
    disabled?: boolean;
    run?: () => void;
  };

  const items: Item[] = [
    {
      icon: "＋",
      label: "添加 Flutter 项目",
      hint: "选择项目目录",
      run: () => void addProject(),
    },
    {
      icon: "📁",
      label: "添加文件夹 / 目录",
      hint: "导入为空，命令稍后添加",
      run: () => void addFolder(),
    },
    {
      icon: "📂",
      label: "导入 launch.json",
      hint: ".vscode/launch.json",
      run: () => void importLaunchPath(),
    },
    {
      icon: "📦",
      label: "导入 package.json",
      hint: "按 scripts 生成命令",
      run: () => void importPackagePath(),
    },
    {
      icon: "🐳",
      label: "导入 docker-compose.yaml",
      hint: "按 service 生成命令",
      run: () => void importComposePath(),
    },
    {
      icon: "🛠️",
      label: "导入 Qt / CMake 工程",
      hint: "CMakePresets",
      run: () => void importQtPath(),
    },
  ];

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "dm-item import-item" + (it.disabled ? " disabled" : "");

    const icon = document.createElement("span");
    icon.className = "import-icon";
    icon.textContent = it.icon;

    const label = document.createElement("span");
    label.className = "import-label";
    label.textContent = it.label;

    const hint = document.createElement("span");
    hint.className = "import-hint";
    hint.textContent = it.hint;

    row.append(icon, label, hint);

    if (!it.disabled && it.run) {
      row.addEventListener("click", () => {
        closeImportMenu();
        it.run!();
      });
    } else {
      row.title = "暂未实现";
    }

    menu.appendChild(row);
  }

  const dismiss = (e: MouseEvent): void => {
    const t = e.target as Node;
    if (importMenuEl && !importMenuEl.contains(t) && !anchor.contains(t)) {
      closeImportMenu();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  document.addEventListener("mousedown", dismiss);

  // Esc 关闭
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      closeImportMenu();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
}

export function openEmulatorMenu(anchor: HTMLElement): void {
  if (emuMenuEl) {
    closeEmuMenu();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "device-menu";
  menu.style.left = `${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 336))}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.innerHTML = `
    <div class="dm-head">
      <span>设备与模拟器</span>
      <span class="dm-updated"></span>
      <button class="dm-refresh" title="重新检查设备与模拟器（模拟器结果会缓存，设备每次现查）">⟳</button>
    </div>
    <div class="dm-body"></div>
  `;
  document.body.appendChild(menu);
  emuMenuEl = menu;

  // ⟳：强制重新检查电脑上的模拟器
  menu.querySelector(".dm-refresh")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void loadEmulators(true);
  });

  // 有内存缓存就先把模拟器渲染出来（秒开），但设备列表**每次打开都重查**：
  // 手机是随时插上的，用旧缓存会让人以为"插上了也不认"。
  if (emulatorCache) {
    renderEmulatorBody(emulatorCache, null);
    void loadEmulators(false, true);
  } else {
    void loadEmulators(false);
  }
}


/* ---------------- Android 数据库（只读快照） ---------------- */
