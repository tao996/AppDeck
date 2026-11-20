/* ============================================================
   AppDeck — Projects（由 main.ts 拆分而来）
   ============================================================ */
import { esc, flutterInfo, sessions, setState, state, toast } from "./core";
import { schedulePersist } from "./persistence";
import { openSettings } from "./settings";
import { render, renderTree } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { FlutterInfo, ImportResponse, Proj, State } from "./core";

export async function refreshFlutter(id: string): Promise<void> {
  try {
    const info = await invoke<FlutterInfo>("detect_flutter", { projectId: id });
    flutterInfo.set(id, info);
    renderTree();
  } catch {
    /* 忽略单个项目的探测失败 */
  }
}

export async function addProject(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Flutter 项目或工作区目录",
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;

  try {
    setState(await invoke<State>("add_project", { path }));
    render();
    const added = state.projects[state.projects.length - 1];
    toast(`已添加：${added.name}`);

    if (added.kind === "workspace") {
      await importLaunch(added.id, true);
    }
    void refreshFlutter(added.id);
  } catch (e) {
    const msg = String(e);
    // 普通目录不是"错误"：指一下新加的文件夹入口，别让人以为程序坏了
    toast(
      msg.includes("不是 Flutter 项目")
        ? `${msg}；若只想挂任意目录，请用「导入 → 添加文件夹 / 目录」`
        : msg,
      "error",
    );
  }
}

/** 添加一个普通文件夹/目录：不解析任何配置，导入后命令列表为空 */
export async function addFolder(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择要添加的文件夹 / 目录",
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    setState(await invoke<State>("add_folder", { path }));
    render();
    const added = state.projects[state.projects.length - 1];
    // 刻意不探测 flutter、也不自动导入 launch.json：空文件夹就是空文件夹
    toast(`已添加文件夹「${added.name}」，用「添加命令」或「从模板导入」补充`);
  } catch (e) {
    toast(String(e), "error");
  }
}

export async function importLaunch(projectId: string, silent = false): Promise<void> {
  try {
    const res = await invoke<ImportResponse>("import_launch", { projectId });
    setState(res.state);
    render();

    const base = `导入完成：${res.imported}/${res.total} 条`;
    const warn = res.warnings.length ? `，${res.warnings.length} 条告警` : "";
    toast(
      silent ? `已自动导入 ${res.imported} 条命令` : base + warn,
      res.warnings.length ? "error" : "info",
    );
    if (res.warnings.length) console.warn("[launch.json]", res.warnings);
  } catch (e) {
    toast(String(e), "error");
  }
}

export interface ImportPathResponse {
  state: State;
  projectId: string;
  projectName: string;
  kind: string;
  created: boolean;
  total: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

/** 从目录导入 launch.json：有 pubspec 当 Flutter 项目，否则当命令集 */
export async function importLaunchPath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择包含 .vscode/launch.json 的目录",
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<ImportPathResponse>("import_launch_path", { path });
    setState(res.state);
    render();
    void refreshFlutter(res.projectId);

    const what = res.kind === "single" ? "Flutter 项目" : "命令集";
    const how = res.created ? "已导入" : "已更新";
    const warn = res.warnings.length ? `，${res.warnings.length} 条告警` : "";
    toast(`${how}${what}「${res.projectName}」：${res.imported}/${res.total} 条命令${warn}`);

    if (res.warnings.length) console.warn("[launch.json]", res.warnings);
  } catch (e) {
    toast(String(e), "error");
  }
}

export interface NpmImportResponse {
  state: State;
  projectId: string;
  projectName: string;
  manager: string;
  created: boolean;
  added: string[];
  kept: string[];
  stale: string[];
}

/** 导入 package.json：把 scripts 变成命令（dev → 长时间运行，build → 一次性产物） */
export async function importPackagePath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: false,
      multiple: false,
      title: "选择 package.json",
      filters: [{ name: "package.json", extensions: ["json"] }],
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开文件选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<NpmImportResponse>("import_package_path", { path });
    setState(res.state);
    render();
    void refreshFlutter(res.projectId);

    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    const how = res.created ? "已导入" : "已更新";
    const detail = parts.length ? `（${parts.join(" · ")}）` : "";
    toast(`${how}「${res.projectName}」：${res.manager}${detail}`);

    if (res.stale.length) console.warn("[package.json] 脚本已不存在：", res.stale);
  } catch (e) {
    toast(String(e), "error");
  }
}

export interface QtImportResponse {
  state: State;
  projectId: string;
  projectName: string;
  created: boolean;
  configurePresets: string[];
  buildPresets: string[];
  runScript: string | null;
  warnings: string[];
  added: string[];
  kept: string[];
  stale: string[];
}

/** 导入 Qt / CMake 工程：按 CMakePresets 生成「配置 / 构建」，根目录有 run 脚本再加「运行」 */
export async function importQtPath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Qt / CMake 工程目录",
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开目录选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<QtImportResponse>("import_qt_path", { path });
    setState(res.state);
    render();
    void refreshFlutter(res.projectId);

    const how = res.created ? "已导入" : "已更新";
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    const detail = parts.length ? `（${parts.join(" · ")}）` : "";
    toast(`${how}「${res.projectName}」：Qt / CMake${detail}`);

    // 一条命令都没生成（如 qmake 工程）时，提示要显眼；其余警告只写控制台
    if (res.warnings.length) {
      if (res.added.length === 0) toast(res.warnings.join("\n"), "error");
      else console.warn("[Qt]", res.warnings);
    }
    if (res.stale.length) console.warn("[Qt] 已消失的预设：", res.stale);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目右键「重新读取 CMakePresets.json」 */
export async function rereadQt(p: Proj): Promise<void> {
  try {
    const res = await invoke<QtImportResponse>("import_qt_path", { path: p.path });
    setState(res.state);
    render();
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    toast(`「${res.projectName}」Qt / CMake（${parts.join(" · ") || "无变化"}）`);
    if (res.warnings.length) console.warn("[Qt]", res.warnings);
  } catch (e) {
    toast(String(e), "error");
  }
}

export interface ComposeImportResponse {
  state: State;
  projectId: string;
  projectName: string;
  created: boolean;
  services: number;
  added: string[];
  kept: string[];
  stale: string[];
}

/** 导入 docker-compose：每个 service 生成「启动 / 日志」，另加一条「全部停止」 */
export async function importComposePath(): Promise<void> {
  let picked: string | string[] | null = null;
  try {
    picked = await open({
      directory: false,
      multiple: false,
      title: "选择 docker-compose.yml（或 compose.yaml）",
      filters: [{ name: "Compose", extensions: ["yml", "yaml"] }],
      defaultPath: lastImportDir ?? state.projects[0]?.path ?? undefined,
    });
  } catch (e) {
    toast(`打开文件选择器失败：${String(e)}`, "error");
    return;
  }
  if (!picked) return;

  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  lastImportDir = path;

  try {
    const res = await invoke<ComposeImportResponse>("import_compose_path", { path });
    setState(res.state);
    render();

    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    const how = res.created ? "已导入" : "已更新";
    const detail = parts.length ? `（${parts.join(" · ")}）` : "";
    toast(`${how}「${res.projectName}」：${res.services} 个服务${detail}`);

    if (res.stale.length) console.warn("[compose] 已消失的服务：", res.stale);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目右键「重新读取 docker-compose.yaml」：路径直接给项目根，后端自己找 compose 文件 */
export async function rereadCompose(p: Proj): Promise<void> {
  try {
    const res = await invoke<ComposeImportResponse>("import_compose_path", { path: p.path });
    setState(res.state);
    render();
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    toast(`「${res.projectName}」${res.services} 个服务（${parts.join(" · ") || "无变化"}）`);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** 项目右键「重新读取 package.json」 */
export async function rereadPackage(p: Proj): Promise<void> {
  try {
    const res = await invoke<NpmImportResponse>("import_package_path", { path: p.path });
    setState(res.state);
    render();
    const parts: string[] = [];
    if (res.added.length) parts.push(`新增 ${res.added.length}`);
    if (res.kept.length) parts.push(`已存在 ${res.kept.length}`);
    if (res.stale.length) parts.push(`已失效 ${res.stale.length}`);
    toast(`「${res.projectName}」${res.manager}（${parts.join(" · ") || "无变化"}）`);
  } catch (e) {
    toast(String(e), "error");
  }
}

export let lastImportDir: string | null = null;

export async function removeProject(p: Proj): Promise<void> {
  const ok = await confirm(`确定要从列表中移除「${p.name}」吗？\n（不会删除磁盘上的任何文件）`, {
    title: "移除项目",
    kind: "warning",
  });
  if (!ok) return;

  try {
    setState(await invoke<State>("remove_project", { id: p.id }));
    flutterInfo.delete(p.id);
    render();
    toast(`已移除：${p.name}`);
  } catch (e) {
    toast(String(e), "error");
  }
}

/**
 * 重命名项目：只改显示名，不动磁盘目录。
 *
 * 不做原生 prompt（没装 dialog 的 prompt 能力），用一个轻量输入弹窗；
 * 回车保存、Esc 取消。名称的最终清洗在后端（`ops::rename_project_in`）。
 */
export async function renameProject(p: Proj): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 460px">
      <div class="modal-head">
        <span>重命名项目</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="set-row">
          <label>项目名称</label>
          <input
            class="set-input"
            id="rename-input"
            maxlength="60"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="set-desc" id="rename-path"></div>
        <div class="set-desc">只改显示名，不会重命名磁盘上的文件夹。</div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="rename-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="rename-cancel">取消</button>
        <button class="btn primary" id="rename-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#rename-input") as HTMLInputElement;
  const hint = overlay.querySelector("#rename-hint") as HTMLSpanElement;
  const pathEl = overlay.querySelector("#rename-path") as HTMLDivElement;

  input.value = p.name;
  pathEl.textContent = p.path;
  pathEl.title = p.path;
  pathEl.style.overflowWrap = "anywhere";

  const close = (): void => overlay.remove();

  const save = (): void => {
    void (async () => {
      const name = input.value.trim();
      if (!name) {
        hint.textContent = "请填写项目名称";
        return;
      }
      if (name === p.name) {
        close();
        return;
      }

      try {
        const oldName = p.name;
        setState(await invoke<State>("rename_project", { id: p.id, name }));
        // 已打开标签的标题是后端拼的「项目名 · 命令/终端」，同步改掉前缀
        let touched = false;
        for (const s of sessions) {
          if (s.projectId === p.id && s.title.startsWith(oldName)) {
            s.title = name + s.title.slice(oldName.length);
            touched = true;
          }
        }
        // 顺手把会话日志里的标题也落盘，重启后恢复出来的标签不会还是旧名字
        if (touched) schedulePersist();
        close();
        render();
        toast(`已重命名：${oldName} → ${name}`);
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  };

  overlay.querySelector(".modal-x")?.addEventListener("click", close);
  overlay.querySelector("#rename-cancel")?.addEventListener("click", close);
  overlay.querySelector("#rename-save")?.addEventListener("click", save);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener("keydown", (e) => {
    // 别让 Esc / 回车漏给全局快捷键或终端
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  input.focus();
  input.select();
}

/* ---------------- Flutter 重命名（rename CLI） ---------------- */

export interface FlutterRenameStatus {
  installed: boolean;
  version: string | null;
  onPath: boolean;
  exe: string | null;
  pubBin: string;
  flutter: string | null;
  flutterSource: string;
  error: string | null;
}

export interface FlutterRenameActivation {
  status: FlutterRenameStatus;
  log: string;
}

export interface FlutterRenameInfo {
  projectName: string;
  projectPath: string;
  platforms: string[];
  bundleIds: Record<string, string | null>;
  appNames: Record<string, string | null>;
  log: string;
}

export interface FlutterRenameApply {
  ok: boolean;
  command: string;
  log: string;
  values: Record<string, string | null>;
}

export const RENAME_PLATFORM_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  macos: "macOS",
  linux: "Linux",
  web: "Web",
  windows: "Windows",
};

export type RenameAction = "bundle" | "name";

/**
 * Flutter 重命名面板：读取/修改包名与应用名称。
 * 实际执行 `rename setBundleId/setAppName --targets ... --value ...`。
 */
export async function openFlutterRename(p: Proj): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal fl-rename-modal">
      <div class="modal-head">
        <span>Flutter 重命名 · ${esc(p.name)}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="rename-banner" id="flr-banner">正在检查 rename CLI…</div>
        <div class="rename-warning">
          会直接修改项目里的包名 / 应用名称；建议先提交 Git。
          只修改勾选的平台，未勾选的平台保持原样。
        </div>
        <div id="flr-body"></div>
        <pre class="rename-log" id="flr-log" hidden></pre>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="flr-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="flr-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#flr-body") as HTMLDivElement;
  const banner = overlay.querySelector("#flr-banner") as HTMLDivElement;
  const logEl = overlay.querySelector("#flr-log") as HTMLPreElement;
  const hint = overlay.querySelector("#flr-hint") as HTMLSpanElement;

  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#flr-close") as HTMLButtonElement).addEventListener("click", close);
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

  const setBanner = (kind: "ok" | "warn" | "bad", text: string): void => {
    banner.className = `rename-banner ${kind}`;
    banner.textContent = text;
  };

  const showLog = (text: string): void => {
    logEl.hidden = false;
    logEl.textContent = text;
  };

  let status: FlutterRenameStatus;
  try {
    status = await invoke<FlutterRenameStatus>("rename_status");
  } catch (e) {
    setBanner("bad", `检查 rename 失败：${String(e)}`);
    return;
  }

  if (!status.installed) {
    setBanner(
      "bad",
      `未安装 rename。请执行 flutter pub global activate rename，或到「设置 → Flutter」里安装。` +
        (status.pubBin ? `\npub bin：${status.pubBin}` : "") +
        (status.error ? `\n${status.error}` : ""),
    );
    const go = document.createElement("button");
    go.className = "btn";
    go.textContent = "打开设置 → Flutter";
    go.addEventListener("click", () => {
      close();
      openSettings();
    });
    body.appendChild(go);
    return;
  }

  setBanner(
    status.onPath ? "ok" : "warn",
    status.onPath
      ? `rename ${status.version ?? ""} 已就绪${status.exe ? `（${status.exe}）` : ""}`
      : `rename ${status.version ?? ""} 已安装，但不在 PATH。AppDeck 会用\n` +
          `${status.exe ?? status.pubBin} 直接调用；想在终端里直接输入 rename，请把 ${status.pubBin} 加入 PATH。`,
  );

  let info: FlutterRenameInfo;
  const loading = document.createElement("div");
  loading.className = "set-desc";
  loading.textContent = "正在读取当前包名 / 应用名称…";
  body.appendChild(loading);
  try {
    info = await invoke<FlutterRenameInfo>("rename_project_info", { projectId: p.id });
  } catch (e) {
    loading.remove();
    setBanner("bad", `读取包名/应用名称失败：${String(e)}`);
    showLog(String(e));
    return;
  }
  loading.remove();

  const pathLine = document.createElement("div");
  pathLine.className = "set-desc rename-path";
  pathLine.textContent = info.projectPath;
  pathLine.title = info.projectPath;
  body.appendChild(pathLine);

  const commonValue = (
    map: Record<string, string | null>,
    targets: string[],
  ): string => {
    const vals = targets.map((t) => (map[t] ?? "").trim()).filter(Boolean);
    if (vals.length !== targets.length) return "";
    return vals.every((v) => v === vals[0]) ? vals[0] : "";
  };

  const makeSection = (
    action: RenameAction,
    title: string,
    desc: string,
    map: Record<string, string | null>,
  ): void => {
    // rename 3.1.0 对包名只支持 android/ios/macos；应用名称支持全部。
    // 以「读到的平台」为准，避免用户勾选后必然报错的平台。
    const sectionPlatforms = info.platforms.filter((x) => map[x] != null);
    if (!sectionPlatforms.length) return;

    const section = document.createElement("div");
    section.className = "rename-section";

    const head = document.createElement("div");
    head.className = "rename-head";
    const h = document.createElement("h3");
    h.textContent = title;
    const d = document.createElement("span");
    d.className = "set-desc";
    d.textContent = desc;
    head.append(h, d);
    section.appendChild(head);

    const preferred = sectionPlatforms.filter((x) => x === "android" || x === "ios");
    const selected = new Set<string>(
      preferred.length ? preferred : sectionPlatforms.slice(0, 1),
    );
    let userEdited = false;

    const current = document.createElement("div");
    current.className = "rename-current";
    section.appendChild(current);

    const row = document.createElement("div");
    row.className = "set-row";
    const lab = document.createElement("label");
    lab.textContent = action === "bundle" ? "新包名" : "新名称";
    const cell = document.createElement("div");
    cell.className = "set-cell";
    const input = document.createElement("input");
    input.className = "set-input";
    input.spellcheck = false;
    input.value = commonValue(map, [...selected]);
    input.placeholder =
      action === "bundle" ? "如 com.example.app" : "如 Today";
    cell.appendChild(input);
    row.append(lab, cell);
    section.appendChild(row);

    const platforms = document.createElement("div");
    platforms.className = "rename-platforms";
    for (const p2 of sectionPlatforms) {
      const l = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p2;
      cb.checked = selected.has(p2);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(p2);
        else selected.delete(p2);
        fillFromCommon();
        sync();
      });
      l.append(cb, document.createTextNode(RENAME_PLATFORM_LABELS[p2] ?? p2));
      platforms.appendChild(l);
    }
    section.appendChild(platforms);

    const skipped = info.platforms.filter((x) => !sectionPlatforms.includes(x));
    if (skipped.length) {
      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent = `rename 3.1.0 没有提供这些平台的该操作：${skipped
        .map((x) => RENAME_PLATFORM_LABELS[x] ?? x)
        .join(" / ")}`;
      section.appendChild(note);
    }

    const cmd = document.createElement("code");
    cmd.className = "rename-cmd";
    section.appendChild(cmd);

    const actions = document.createElement("div");
    actions.className = "rename-actions";
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = action === "bundle" ? "更新包名" : "更新名称";
    actions.appendChild(btn);
    section.appendChild(actions);

    const targetsNow = (): string[] => sectionPlatforms.filter((x) => selected.has(x));
    const commandText = (): string => {
      const targets = targetsNow();
      const value = input.value.trim() || "…";
      const cmdName = action === "bundle" ? "setBundleId" : "setAppName";
      return `rename ${cmdName} --targets ${targets.join(",") || "…"} --value "${value}"`;
    };

    const sync = (): void => {
      const targets = targetsNow();
      current.textContent =
        "当前：" +
        (targets.length
          ? targets
              .map((t) => `${RENAME_PLATFORM_LABELS[t] ?? t}=${map[t] ?? "读取失败"}`)
              .join("  ·  ")
          : "未选择平台");
      cmd.textContent = commandText();
      btn.disabled = targets.length === 0 || !input.value.trim();
    };
    // 切换平台时，只有在用户没改过输入框的情况下才用当前值补空
    const fillFromCommon = (): void => {
      if (userEdited || input.value.trim()) return;
      const common = commonValue(map, targetsNow());
      if (common) input.value = common;
    };
    input.addEventListener("input", () => {
      userEdited = true;
      sync();
    });
    btn.addEventListener("click", () => {
      void (async () => {
        const targets = targetsNow();
        const value = input.value.trim();
        hint.textContent = "";
        if (!targets.length) {
          hint.textContent = "请选择至少一个平台";
          return;
        }
        if (!value) {
          hint.textContent = "请填写新值";
          return;
        }
        if (action === "bundle" && /\s/.test(value)) {
          hint.textContent = "包名不能包含空格";
          return;
        }

        btn.disabled = true;
        btn.textContent = "更新中…";
        showLog(`$ ${commandText()}\n\n执行中…`);

        try {
          const res = await invoke<FlutterRenameApply>("rename_apply", {
            projectId: p.id,
            action,
            targets,
            value,
          });
          for (const [k, v] of Object.entries(res.values)) {
            if (v) map[k] = v;
          }
          showLog(`$ ${res.command}\n\n${res.log}`);
          sync();
          toast(`已更新${title}（${targets.join(", ")}）`);
        } catch (e) {
          showLog(`$ ${commandText()}\n\n${String(e)}`);
          toast(String(e), "error");
        } finally {
          btn.disabled = false;
          btn.textContent = action === "bundle" ? "更新包名" : "更新名称";
        }
      })();
    });

    body.appendChild(section);
    sync();
  };

  makeSection(
    "bundle",
    "包名（Bundle ID）",
    "Android applicationId / iOS PRODUCT_BUNDLE_IDENTIFIER 等",
    info.bundleIds,
  );
  makeSection(
    "name",
    "应用名称",
    "桌面图标与安装后显示的应用名称",
    info.appNames,
  );
}

/* ---------------- 工具栏自定义命令 ---------------- */
