/* ============================================================
   AppDeck — Doctor（由 main.ts 拆分而来）
   ============================================================ */
import { esc, state, toast } from "./core";
import { mountSession } from "./launcher";
import { openProcessPanel, pickApkAndInspect } from "./panels";
import { closeAllMenus, setProjMenuEl, setToolsMenuEl, toolsMenuEl } from "./project-menu";
import { invoke } from "@tauri-apps/api/core";
import type { StartResponse } from "./core";

export interface DoctorCheck {
  key: string;
  name: string;
  summary: string;
  status: string;
  details: string[];
  fix: string | null;
  canRun: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  issues: number;
  summary: string | null;
  raw: string;
  error: string | null;
  ranAt: number;
}

export let doctorReport: DoctorReport | null = null;
export let doctorBusy = false;

export const DOCTOR_ICON: Record<string, string> = {
  ok: "√",
  warn: "!",
  error: "✗",
};

export function doctorIssues(): DoctorCheck[] {
  return (doctorReport?.checks ?? []).filter((c) => c.status !== "ok");
}

/** 工具栏按钮即体检入口：状态直接体现在按钮上 */
export function renderDoctorButton(): void {
  const item = document.querySelector<HTMLElement>("#tools-doctor");
  if (!item) return;
  const detail = item.querySelector<HTMLElement>(".dm-sub");
  if (!detail) return;

  item.classList.toggle("checking", doctorBusy);
  const rep = doctorReport;

  if (doctorBusy) {
    detail.textContent = "正在运行 flutter doctor…";
    item.title = "正在运行 flutter doctor…";
    return;
  }

  // 没跑过：不自动触发（flutter doctor 要 20+ 秒），等用户点
  if (!rep) {
    detail.textContent = "未体检 · 点击运行（约 20 秒）";
    item.title = "点击运行 flutter doctor（结果会缓存）";
    return;
  }

  if (rep.error) {
    detail.textContent = `失败：${rep.error}`;
    item.title = `体检未能完成：${rep.error}\n点击查看详情`;
    return;
  }

  const bad = doctorIssues();
  if (bad.length === 0) {
    detail.textContent = `${rep.checks.length} 项全部正常 · 点击查看`;
    item.title = `${rep.checks.length} 项检查全部正常\n点击查看详情`;
  } else {
    detail.textContent = `${bad.length} 项异常 · 点击查看`;
    item.title = `${bad.map((c) => c.name).join("、")}\n点击查看详情`;
  }
}

export function openDoctorEntry(): void {
  if (doctorBusy) {
    toast("体检进行中…");
    return;
  }
  if (doctorReport) openDoctorReport();
  else void refreshDoctor(true);
}

export function openToolsMenu(anchor: HTMLElement): void {
  if (toolsMenuEl) {
    closeAllMenus();
    return;
  }
  closeAllMenus();

  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "device-menu tools-menu";
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 300)}px`;
  menu.innerHTML = `
    <div class="dm-head"><span>工具</span></div>
    <div class="dm-body">
      <div class="dm-item" id="tools-filing">
        <span class="dm-name">📋 备案</span>
        <span class="dm-sub">安卓 APK 包名 / MD5 / 公钥</span>
      </div>
      <div class="dm-item" id="tools-doctor">
        <span class="dm-name">🩺 体检</span>
        <span class="dm-sub"></span>
      </div>
      <div class="dm-item" id="tools-processes">
        <span class="dm-name">🧩 进程</span>
        <span class="dm-sub">进程与端口管理</span>
      </div>
    </div>
  `;
  document.body.appendChild(menu);
  setProjMenuEl(menu);
  setToolsMenuEl(menu);

  menu.querySelector("#tools-filing")?.addEventListener("click", () => {
    closeAllMenus();
    void pickApkAndInspect();
  });
  menu.querySelector("#tools-doctor")?.addEventListener("click", () => {
    closeAllMenus();
    openDoctorEntry();
  });
  menu.querySelector("#tools-processes")?.addEventListener("click", () => {
    closeAllMenus();
    openProcessPanel();
  });

  renderDoctorButton();
}

/* ---------------- 循环任务（工具栏一级入口） ---------------- */

/** 面板打开时的刷新函数；运行事件到达时用它更新列表 */

export async function loadCachedDoctor(): Promise<void> {
  try {
    const rep = await invoke<DoctorReport>("flutter_doctor", {
      projectId: state.projects[0]?.id ?? null,
      force: false,
      cachedOnly: true,
    });
    // ranAt === 0 表示后端没有缓存（不是"检查通过"）
    doctorReport = rep.ranAt ? rep : null;
  } catch {
    doctorReport = null;
  }
  renderDoctorButton();
}

export async function refreshDoctor(force = false): Promise<void> {
  if (doctorBusy) return;

  doctorBusy = true;
  renderDoctorButton();

  try {
    doctorReport = await invoke<DoctorReport>("flutter_doctor", {
      projectId: state.projects[0]?.id ?? null,
      force,
    });
  } catch (e) {
    doctorReport = {
      checks: [],
      issues: 0,
      summary: null,
      raw: "",
      error: String(e),
      ranAt: Date.now(),
    };
  } finally {
    doctorBusy = false;
    renderDoctorButton();
  }
}

export function openDoctorReport(): void {
  const rep = doctorReport;
  if (!rep) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const body = rep.error
    ? `<div class="dr-raw">${esc(rep.error)}</div>`
    : rep.checks
        .map((c) => {
          const details = c.details.length
            ? `<div class="dr-details">${c.details.map((d) => esc(d)).join("<br>")}</div>`
            : "";
          const fix = c.fix
            ? `<div class="dr-fix">
                 <span class="dr-fix-label">修复：</span>
                 <code>${esc(c.fix)}</code>
                 <button class="btn dr-copy" data-copy="${esc(c.fix)}">复制</button>
                 ${c.canRun ? `<button class="btn primary dr-run" data-fix="${esc(c.fix)}">在终端执行</button>` : ""}
               </div>`
            : "";
          return `
            <div class="dr-check ${c.status}">
              <div class="dr-head">
                <span class="dr-icon">${DOCTOR_ICON[c.status] ?? "?"}</span>
                <span class="dr-name">${esc(c.name)}</span>
                <span class="dr-summary">${esc(c.summary)}</span>
              </div>
              ${details}
              ${fix}
            </div>`;
        })
        .join("");

  overlay.innerHTML = `
    <div class="modal" style="width: 780px">
      <div class="modal-head">
        <span>flutter doctor 体检报告</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="dr-body">${body}</div>
      <div class="modal-foot">
        <span class="modal-hint">${esc(rep.summary ?? "")}</span>
        <span class="flex1"></span>
        <button class="btn" id="dr-copy-raw">复制原始输出</button>
        <button class="btn" id="dr-rerun">重新体检</button>
        <button class="btn primary" id="dr-close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = (): void => overlay.remove();
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#dr-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  (overlay.querySelector("#dr-rerun") as HTMLButtonElement).addEventListener("click", () => {
    close();
    void refreshDoctor(true);
  });

  (overlay.querySelector("#dr-copy-raw") as HTMLButtonElement).addEventListener("click", () => {
    void navigator.clipboard
      .writeText(rep.raw || rep.error || "")
      .then(() => toast("原始输出已复制"))
      .catch((e) => toast(String(e), "error"));
  });

  overlay.querySelectorAll<HTMLButtonElement>(".dr-copy").forEach((b) => {
    b.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(b.dataset.copy ?? "")
        .then(() => toast("命令已复制"))
        .catch((e) => toast(String(e), "error"));
    });
  });

  overlay.querySelectorAll<HTMLButtonElement>(".dr-run").forEach((b) => {
    b.addEventListener("click", () => {
      const project = state.projects[0];
      if (!project) {
        toast("需要先添加一个项目", "error");
        return;
      }
      close();
      void invoke<StartResponse>("start_doctor_fix", {
        projectId: project.id,
        fix: b.dataset.fix ?? "",
        rows: 30,
        cols: 100,
      })
        .then((res) => {
          mountSession(res, "custom", "debug", { projectId: project.id });
          toast("已在终端启动修复流程，按提示输入 y 确认");
        })
        .catch((e) => toast(String(e), "error"));
    });
  });
}

/* ---------------- 会话恢复（D-10） ---------------- */
