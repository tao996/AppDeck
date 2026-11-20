/* ============================================================
   AppDeck — Panels（由 main.ts 拆分而来）
   ============================================================ */
import { esc, sessions, setState, state, toast } from "./core";
import { mountSession, replaceSessionInPlace, staleSessionFor } from "./launcher";
import { openProcessManager } from "./process-manager";
import { projectLabel, render } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FilingInfo, Proj, StartResponse, State } from "./core";

export function openProcessPanel(): void {
  openProcessManager({
    notify: toast,
    initialPrefs: {
      hideRules: [...(state.ui?.processHideRules ?? [])],
      hideRulesEnabled: state.ui?.processHideRulesEnabled ?? true,
      autoRefresh: state.ui?.processAutoRefresh ?? true,
    },
    savePrefs: async (prefs) => {
      setState(await invoke<State>("save_process_prefs", {
        hideRules: prefs.hideRules,
        hideRulesEnabled: prefs.hideRulesEnabled,
        autoRefresh: prefs.autoRefresh,
      }));
    },
    // 把 AppDeck 自己拉起的会话标出来，避免误杀时不知道是哪个标签
    sessionPids: () => {
      const map = new Map<number, string>();
      for (const s of sessions) {
        if (s.pid) map.set(s.pid, s.title);
      }
      return map;
    },
  });
}

/** 在项目目录开一个交互终端（继承项目环境）。 */
export async function openProjectTerminal(p: Proj): Promise<void> {
  try {
    const res = await invoke<StartResponse>("open_terminal", {
      projectId: p.id,
      rows: 30,
      cols: 100,
    });
    const session = mountSession(res, "terminal", "terminal", { projectId: p.id });
    // 已结束的旧终端标签别留着变成同名重复 tab：新终端放回它的位置
    const stale = staleSessionFor(
      (s) => s.kind === "terminal" && s.projectId === p.id && s.id !== session.id,
    );
    if (stale) replaceSessionInPlace(stale.id, session.id);
  } catch (e) {
    toast(String(e), "error");
  }
}

/* ---------------- 项目环境变量 ---------------- */

export interface EnvEntry {
  key: string;
  value: string;
  /** 全局 / .fvmrc / 项目 */
  source: string;
}

export interface ProjectEnvInfo {
  harmony: boolean;
  exe: string;
  flutterSource: string;
  shim: string | null;
  entries: EnvEntry[];
}

export async function openEnvDialog(p: Proj): Promise<void> {
  let info: ProjectEnvInfo;
  try {
    info = await invoke<ProjectEnvInfo>("project_env", { projectId: p.id });
  } catch (e) {
    toast(String(e), "error");
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 760px">
      <div class="modal-head">
        <span>环境变量 · ${esc(projectLabel(p))}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="env-body"></div>
      <div class="modal-foot">
        <span class="modal-hint">${esc(p.path)}</span>
        <span class="flex1"></span>
        <button class="btn" id="env-reset">重置项目覆盖</button>
        <button class="btn primary" id="env-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#env-body") as HTMLDivElement;
  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);

  // 生效来源一览
  const sum = document.createElement("div");
  sum.className = "env-summary";
  sum.innerHTML = `
    <div class="fl-row"><span class="fl-label">flutter</span><span class="fl-value">${esc(
      info.exe || "（未解析到）",
    )}</span></div>
    <div class="fl-row"><span class="fl-label">来源</span><span class="fl-value">${esc(
      info.flutterSource || "—",
    )}</span></div>
    <div class="fl-row"><span class="fl-label">PATH shim</span><span class="fl-value">${esc(
      info.shim ?? "（未生成：与 PATH 中的 flutter 相同或非鸿蒙工程）",
    )}</span></div>
  `;
  body.appendChild(sum);

  if (!info.harmony) {
    const warn = document.createElement("div");
    warn.className = "fl-banner";
    warn.textContent =
      "该项目没有 ohos/ 目录，不属于鸿蒙工程：下面这些变量不会注入（仅 .fvmrc 的 env 除外）。";
    body.appendChild(warn);
  }

  const listTitle = document.createElement("div");
  listTitle.className = "set-sub";
  listTitle.textContent = `生效环境变量（${info.entries.length}）`;
  body.appendChild(listTitle);

  const list = document.createElement("div");
  list.className = "env-list";
  for (const e of info.entries) {
    const row = document.createElement("div");
    row.className = "env-row";
    const k = document.createElement("span");
    k.className = "env-tag-key";
    k.textContent = e.key;
    const v = document.createElement("span");
    v.className = "env-tag-value";
    v.textContent = e.value;
    const src = document.createElement("span");
    src.className = "chip env-src";
    src.textContent = e.source;
    row.append(k, v, src);
    list.appendChild(row);
  }
  if (info.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "set-desc";
    empty.textContent = "（暂无，可在下方添加项目级变量）";
    list.appendChild(empty);
  }
  body.appendChild(list);

  // 项目级覆盖编辑器
  const pTitle = document.createElement("div");
  pTitle.className = "set-sub";
  pTitle.textContent = "项目级变量（优先级最高）";
  body.appendChild(pTitle);

  const editBox = document.createElement("div");
  editBox.className = "env-list";
  body.appendChild(editBox);

  const rows: Array<[string, string]> = Object.entries(p.env ?? {});
  const collect = (): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const [k, v] of rows) if (k.trim() !== "") m[k.trim()] = v;
    return m;
  };

  const renderEdit = (): void => {
    editBox.innerHTML = "";

    rows.forEach(([k, v], idx) => {
      const row = document.createElement("div");
      row.className = "env-row";

      const kEl = document.createElement("input");
      kEl.className = "set-input env-key";
      kEl.value = k;
      kEl.placeholder = "KEY";
      kEl.addEventListener("input", () => {
        rows[idx][0] = kEl.value;
      });

      const vEl = document.createElement("input");
      vEl.className = "set-input";
      vEl.value = v;
      vEl.placeholder = "value";
      vEl.addEventListener("input", () => {
        rows[idx][1] = vEl.value;
      });

      const del = document.createElement("button");
      del.className = "btn";
      del.textContent = "×";
      del.title = "删除该变量";
      del.addEventListener("click", () => {
        rows.splice(idx, 1);
        renderEdit();
      });

      row.append(kEl, vEl, del);
      editBox.appendChild(row);
    });

    const add = document.createElement("button");
    add.className = "btn";
    add.textContent = "＋ 添加变量";
    add.addEventListener("click", () => {
      rows.push(["", ""]);
      renderEdit();
    });
    editBox.appendChild(add);
  };
  renderEdit();

  (overlay.querySelector("#env-reset") as HTMLButtonElement).addEventListener("click", () => {
    rows.length = 0;
    renderEdit();
  });

  (overlay.querySelector("#env-save") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        setState(await invoke<State>("save_project_env", {
          projectId: p.id,
          env: collect(),
        }));
        render();
        toast("环境变量已保存（下次启动会话生效）");
        close();
      } catch (e) {
        toast(String(e), "error");
      }
    })();
  });
}

/* ---------------- 备案信息（安卓） ---------------- */

export let lastApkDir: string | null = null;
export let lastFiling: FilingInfo | null = null;

export async function pickApkAndInspect(): Promise<void> {
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "选择要查看的 APK",
      defaultPath: lastApkDir ?? undefined,
      filters: [{ name: "Android 安装包", extensions: ["apk"] }],
    });
    if (typeof picked !== "string") return;
    lastApkDir = picked.replace(/[\\/][^\\/]+$/, "");
    await showFilingInfo(picked);
  } catch (e) {
    toast(String(e), "error");
  }
}

export function filingField(label: string, value: string | null | undefined, big = false): string {
  const v = value?.trim() || "";
  return `
    <div class="fl-row${big ? " big" : ""}">
      <span class="fl-label">${esc(label)}</span>
      <code class="fl-value">${v ? esc(v) : '<span class="fl-empty">—</span>'}</code>
      ${v ? `<button class="btn fl-copy" data-copy="${esc(v)}">复制</button>` : ""}
    </div>`;
}

export async function showFilingInfo(apk: string): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width: 820px">
      <div class="modal-head">
        <span>安卓备案信息</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="fl-body">
        <div class="dm-loading">正在读取 APK 签名与清单…</div>
      </div>
      <div class="modal-foot">
        <span class="modal-hint" id="fl-hint">${esc(apk)}</span>
        <span class="flex1"></span>
        <button class="btn" id="fl-copy-all">复制全部</button>
        <button class="btn" id="fl-repick">换一个 APK</button>
        <button class="btn primary" id="fl-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#fl-body") as HTMLDivElement;
  const close = (): void => overlay.remove();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#fl-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  (overlay.querySelector("#fl-copy-all") as HTMLButtonElement).addEventListener("click", () =>
    copyAllFiling(),
  );
  (overlay.querySelector("#fl-repick") as HTMLButtonElement).addEventListener("click", () => {
    close();
    void pickApkAndInspect();
  });

  let info: FilingInfo;
  try {
    info = await invoke<FilingInfo>("filing_info", { apk });
  } catch (e) {
    body.innerHTML = `<div class="dr-raw">${esc(String(e))}</div>`;
    return;
  }
  lastFiling = info;

  if (info.error) {
    body.innerHTML = `<div class="dr-raw">${esc(info.error)}</div>`;
    return;
  }

  const debugSigned = (info.dn ?? "").toLowerCase().includes("android debug");

  body.innerHTML = `
    ${debugSigned ? '<div class="fl-banner">当前为调试签名，请勿用于备案</div>' : ""}
    <div class="fl-section">备案三要素</div>
    ${filingField("应用名称", info.appLabel, true)}
    ${filingField("应用包名", info.package, true)}
    ${filingField("应用 MD5", info.md5, true)}
    ${
      info.publicKey
        ? filingField("应用公钥", info.publicKey, true)
        : `<div class="fl-row big">
             <span class="fl-label">应用公钥</span>
             <code class="fl-value"><span class="fl-empty">待解析（第二期提供：解析 APK 签名块）</span></code>
           </div>`
    }

    <div class="fl-section">附加信息</div>
    ${filingField("版本", [info.versionName, info.versionCode ? `(${info.versionCode})` : ""].filter(Boolean).join(" "))}
    ${filingField("SDK", [info.minSdk ? `min ${info.minSdk}` : "", info.targetSdk ? `target ${info.targetSdk}` : ""].filter(Boolean).join(" · "))}
    ${filingField("签名方案", info.scheme ? `V${info.scheme}` : null)}
    ${filingField("证书 DN", info.dn)}
    ${filingField("SHA-1", info.sha1)}
    ${filingField("SHA-256", info.sha256)}

    ${
      info.warnings.length
        ? `<div class="fl-section">提示</div>${info.warnings
            .map((w) => `<div class="fl-warn">${esc(w)}</div>`)
            .join("")}`
        : ""
    }
  `;

  body.querySelectorAll<HTMLButtonElement>(".fl-copy").forEach((b) => {
    b.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(b.dataset.copy ?? "")
        .then(() => toast("已复制"))
        .catch((e) => toast(String(e), "error"));
    });
  });
}

export function copyAllFiling(): void {
  const i = lastFiling;
  if (!i) return;

  const lines = [
    `应用名称：${i.appLabel ?? ""}`,
    `应用包名：${i.package ?? ""}`,
    `应用公钥：${i.publicKey ?? "（待解析）"}`,
    `应用MD5：${i.md5 ?? ""}`,
    `版本：${i.versionName ?? ""} (${i.versionCode ?? ""})`,
    `SHA1：${i.sha1 ?? ""}`,
    `SHA256：${i.sha256 ?? ""}`,
    `证书DN：${i.dn ?? ""}`,
    `签名方案：${i.scheme ? `V${i.scheme}` : ""}`,
  ];

  void navigator.clipboard
    .writeText(lines.join("\n"))
    .then(() => toast("备案信息已复制"))
    .catch((e) => toast(String(e), "error"));
}

/* ---------------- 体检（§14 / §6.6）：工具栏按钮 ---------------- */
