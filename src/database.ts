/* ============================================================
   AppDeck — Database（由 main.ts 拆分而来）
   ============================================================ */
import { esc, req, toast } from "./core";

import { closeAllMenus, renderMenuRows, setProjMenuEl } from "./project-menu";

import { projectLabel } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Proj } from "./core";
import type { MenuRow } from "./project-menu";

export interface DbDeviceInfo {
  serial: string;
  state: string;
  model: string;
  product: string;
}

export interface DbEnvInfo {
  adb: string | null;
  adbVersion: string | null;
  devices: DbDeviceInfo[];
  package: string | null;
  foreground: string | null;
  notes: string[];
}

export interface DbFileInfo {
  path: string;
  size: number;
}

export interface DbTableInfo {
  name: string;
  sql: string | null;
}

export interface DbOpenInfo {
  sessionId: string;
  localPath: string;
  remotePath: string;
  size: number;
  wal: boolean;
  tables: DbTableInfo[];
}

export interface DbPageInfo {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  elapsedMs: number;
  total: number | null;
}

export interface PrefEntry {
  key: string;
  /** string / int / long / float / boolean / set */
  type: string;
  value: string;
}

export function dbSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function dbPkgKey(projectId: string): string {
  return `appdeck.db.package.${projectId}`;
}

/** 把 run-as 的原始报错翻译成能指导下一步操作的提示 */
export function dbErrorText(e: unknown): string {
  const msg = String(e);
  if (/unknown package|not debuggable|run-as/i.test(msg)) {
    return `${msg}（只有 debug 包能用 run-as 读取；可用 adb shell pm list packages -3 确认包名）`;
  }
  return msg;
}

/**
 * Android 数据库查看器：`adb run-as` 拉取 db（+ `-wal`）到本机，只读打开。
 *
 * 与 Android Studio Database Inspector 的区别：
 * - 不需要 IDE、不走 JDWP，也不要求 app 集成任何依赖；
 * - 看到的是拉取那一刻的快照，点「读取数据库」可重新拉；
 * - release 包（非 debuggable）没有 `run-as`，这里会直接报错。
 */
/** 复制文本：优先 Clipboard API，失败时退回 textarea + execCommand（WebView 未聚焦时也能用） */
export async function copyPlainText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("复制失败：剪贴板不可用");
  }
}

/** 右键单元格：复制完整内容（长文本在格子里是截断的，dataset.full 存原文） */
export function showDbCellMenu(ev: MouseEvent, td: HTMLTableCellElement): void {
  closeAllMenus();

  const tr = td.parentElement as HTMLTableRowElement | null;
  const cellText = td.dataset.full ?? td.textContent ?? "";
  const rowText = tr
    ? Array.from(tr.children)
        .map((c) => (c as HTMLElement).dataset.full ?? c.textContent ?? "")
        .join("\t")
    : cellText;

  const menu = document.createElement("div");
  menu.className = "device-menu db-cell-menu";
  menu.innerHTML = `<div class="dm-head"><span>复制单元格</span></div><div class="dm-body"></div>`;
  document.body.appendChild(menu);
  setProjMenuEl(menu);

  const rows: MenuRow[] = [
    {
      kind: "item",
      name: "复制单元格",
      detail: cellText.length > 80 ? `${cellText.slice(0, 80)}…` : cellText || "（空）",
      onClick: () =>
        void copyPlainText(cellText)
          .then(() => toast("已复制单元格"))
          .catch((e) => toast(String(e), "error")),
    },
    {
      kind: "item",
      name: "复制整行",
      detail: "列之间用 Tab 分隔，可直接粘到 Excel",
      onClick: () =>
        void copyPlainText(rowText)
          .then(() => toast("已复制整行"))
          .catch((e) => toast(String(e), "error")),
    },
  ];
  renderMenuRows(menu.querySelector(".dm-body") as HTMLDivElement, rows);

  const w = menu.offsetWidth || 280;
  const h = menu.offsetHeight || 120;
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - h - 8))}px`;
}

export async function openDbInspector(p: Proj): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal db-modal">
      <div class="modal-head">
        <span>数据库 · ${esc(projectLabel(p))}</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="db-toolbar">
        <label for="db-device">设备</label>
        <select id="db-device" class="set-input"></select>
        <label for="db-pkg">包名</label>
        <input id="db-pkg" class="set-input" spellcheck="false" autocomplete="off" />
        <button class="btn" id="db-load">读取数据库</button>
        <span class="db-hint" id="db-hint">正在探测设备…</span>
      </div>
      <div class="db-main">
        <aside class="db-side">
          <div class="db-side-title"><span>数据库</span><span id="db-file-count"></span></div>
          <div class="db-files" id="db-files"></div>
          <div class="db-side-title"><span>表</span><span id="db-table-count"></span></div>
          <div class="db-tables" id="db-tables"></div>
        </aside>
        <section class="db-work">
          <div class="db-tabs">
            <button class="db-tab active" data-mode="db">数据库</button>
            <button class="db-tab" data-mode="prefs">SharedPreferences</button>
            <span class="flex1"></span>
            <button class="btn" id="db-export" disabled>导出副本</button>
            <button class="btn" id="db-reveal" disabled>在资源管理器中显示</button>
          </div>
          <div class="db-subtabs" id="db-subtabs">
            <button class="db-subtab active" data-tab="data">数据</button>
            <button class="db-subtab" data-tab="sql">SQL</button>
          </div>
          <div class="db-pane" id="db-pane-data">
            <div class="db-grid-wrap"><table class="db-grid" id="db-grid"></table></div>
            <div class="db-pager">
              <button class="btn" id="db-prev" disabled>‹ 上一页</button>
              <span id="db-page-info">—</span>
              <button class="btn" id="db-next" disabled>下一页 ›</button>
              <select id="db-limit" class="set-input db-limit">
                <option value="100">100 行</option>
                <option value="200" selected>200 行</option>
                <option value="500">500 行</option>
                <option value="1000">1000 行</option>
              </select>
              <span class="db-status" id="db-status"></span>
            </div>
          </div>
          <div class="db-pane" id="db-pane-sql" hidden>
            <textarea id="db-sql" class="db-sql" spellcheck="false"
              placeholder="SELECT * FROM users LIMIT 50;   -- 只读：SELECT / PRAGMA / WITH / EXPLAIN"></textarea>
            <div class="db-sql-bar">
              <button class="btn primary" id="db-run">执行（Ctrl+Enter）</button>
              <span class="db-status" id="db-sql-status"></span>
            </div>
            <div class="db-grid-wrap"><table class="db-grid" id="db-sql-grid"></table></div>
          </div>
          <div class="db-pane" id="db-pane-prefs" hidden>
            <div class="prefs-bar">
              <label for="prefs-file">文件</label>
              <select id="prefs-file" class="set-input"></select>
              <button class="btn" id="prefs-refresh">刷新</button>
              <input id="prefs-search" class="set-input" placeholder="搜索 key / value" spellcheck="false" />
              <label class="prefs-check">
                <input type="checkbox" id="prefs-flutter" /> 只看 Flutter 键
              </label>
              <span class="db-status" id="prefs-status"></span>
            </div>
            <div class="db-grid-wrap prefs-table-wrap">
              <table class="db-grid prefs-grid" id="prefs-grid"></table>
            </div>
            <div class="prefs-path" id="prefs-path"></div>
          </div>
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const hint = req<HTMLSpanElement>("#db-hint", overlay);
  const deviceSel = req<HTMLSelectElement>("#db-device", overlay);
  const pkgInput = req<HTMLInputElement>("#db-pkg", overlay);
  const loadBtn = req<HTMLButtonElement>("#db-load", overlay);
  const filesEl = req<HTMLDivElement>("#db-files", overlay);
  const tablesEl = req<HTMLDivElement>("#db-tables", overlay);
  const fileCount = req<HTMLSpanElement>("#db-file-count", overlay);
  const tableCount = req<HTMLSpanElement>("#db-table-count", overlay);
  const dataGrid = req<HTMLTableElement>("#db-grid", overlay);
  const sqlGrid = req<HTMLTableElement>("#db-sql-grid", overlay);
  const pageInfo = req<HTMLSpanElement>("#db-page-info", overlay);
  const status = req<HTMLSpanElement>("#db-status", overlay);
  const sqlStatus = req<HTMLSpanElement>("#db-sql-status", overlay);
  const sqlInput = req<HTMLTextAreaElement>("#db-sql", overlay);
  const prevBtn = req<HTMLButtonElement>("#db-prev", overlay);
  const nextBtn = req<HTMLButtonElement>("#db-next", overlay);
  const limitSel = req<HTMLSelectElement>("#db-limit", overlay);
  const exportBtn = req<HTMLButtonElement>("#db-export", overlay);
  const revealBtn = req<HTMLButtonElement>("#db-reveal", overlay);
  const dataPane = req<HTMLDivElement>("#db-pane-data", overlay);
  const sqlPane = req<HTMLDivElement>("#db-pane-sql", overlay);
  const prefsPane = req<HTMLDivElement>("#db-pane-prefs", overlay);
  const dbSide = req<HTMLElement>(".db-side", overlay);
  const prefsFile = req<HTMLSelectElement>("#prefs-file", overlay);
  const prefsRefresh = req<HTMLButtonElement>("#prefs-refresh", overlay);
  const prefsSearch = req<HTMLInputElement>("#prefs-search", overlay);
  const prefsFlutter = req<HTMLInputElement>("#prefs-flutter", overlay);
  const prefsGrid = req<HTMLTableElement>("#prefs-grid", overlay);
  const prefsStatus = req<HTMLSpanElement>("#prefs-status", overlay);
  const prefsPathEl = req<HTMLDivElement>("#prefs-path", overlay);
  const topTabs = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".db-tab"));
  const subTabs = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".db-subtab"));
  const subtabsEl = req<HTMLDivElement>("#db-subtabs", overlay);

  let sessionId: string | null = null;
  let localPath = "";
  let files: DbFileInfo[] = [];
  let tables: DbTableInfo[] = [];
  let activeFile: string | null = null;
  let activeTable: string | null = null;
  let total = 0;
  let offset = 0;
  let limit = 200;
  let currentTab = "data";
  let dbSubTab = "data";
  let prefsFiles: DbFileInfo[] = [];
  let prefsEntries: PrefEntry[] = [];
  let prefsLoadedFor = "";
  let prefsActivePath = "";
  let savedDbHint = "";

  const clearGrid = (el: HTMLTableElement): void => {
    el.innerHTML = "";
  };

  const renderGrid = (el: HTMLTableElement, page: DbPageInfo): void => {
    el.innerHTML = "";
    if (page.columns.length === 0) return;

    const head = el.createTHead().insertRow();
    for (const c of page.columns) {
      const th = document.createElement("th");
      th.textContent = c;
      head.appendChild(th);
    }
    const body = el.createTBody();
    for (const row of page.rows) {
      const tr = body.insertRow();
      for (const cell of row) {
        const td = tr.insertCell();
        if (cell === null) {
          td.textContent = "NULL";
          td.className = "db-null";
        } else {
          td.textContent = cell.length > 500 ? `${cell.slice(0, 500)}…` : cell;
          if (cell.length > 500) {
            td.title = cell;
            td.dataset.full = cell;
          }
        }
      }
    }
  };

  const switchTab = (tab: "data" | "sql"): void => {
    const prevTab = currentTab;
    currentTab = tab;
    dbSubTab = tab;
    if (prevTab === "prefs" && savedDbHint) hint.textContent = savedDbHint;

    for (const t of topTabs) t.classList.toggle("active", t.dataset.mode === "db");
    for (const t of subTabs) t.classList.toggle("active", t.dataset.tab === tab);
    dbSide.hidden = false;
    subtabsEl.hidden = false;
    dataPane.hidden = tab !== "data";
    sqlPane.hidden = tab !== "sql";
    prefsPane.hidden = true;
    exportBtn.hidden = false;
    revealBtn.hidden = false;
    if (tab === "sql" && sqlInput.value.trim() === "") {
      sqlInput.value = activeTable
        ? `SELECT * FROM "${activeTable.replace(/"/g, '""')}" LIMIT 100;`
        : "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;";
    }
  };

  const switchMode = (mode: "db" | "prefs"): void => {
    if (mode === "prefs") {
      if (currentTab === "prefs") return;
      savedDbHint = hint.textContent;
      if (currentTab === "sql" || currentTab === "data") dbSubTab = currentTab;
      currentTab = "prefs";
      for (const t of topTabs) t.classList.toggle("active", t.dataset.mode === "prefs");
      dbSide.hidden = true;
      subtabsEl.hidden = true;
      dataPane.hidden = true;
      sqlPane.hidden = true;
      prefsPane.hidden = false;
      exportBtn.hidden = true;
      revealBtn.hidden = true;
      hint.textContent = "SharedPreferences 只读查看（run-as）";
      void loadPrefs();
      return;
    }

    if (currentTab === "prefs" && savedDbHint) hint.textContent = savedDbHint;
    switchTab(dbSubTab === "sql" ? "sql" : "data");
  };

  const renderFiles = (): void => {
    filesEl.innerHTML = "";
    fileCount.textContent = files.length > 0 ? `(${files.length})` : "";
    for (const f of files) {
      const el = document.createElement("div");
      el.className = `db-file${activeFile === f.path ? " active" : ""}`;
      const path = document.createElement("div");
      path.className = "db-file-path";
      path.textContent = f.path;
      const size = document.createElement("div");
      size.className = "db-file-size";
      size.textContent = dbSize(f.size);
      el.append(path, size);
      el.addEventListener("click", () => void openFile(f));
      filesEl.appendChild(el);
    }
    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "set-desc";
      empty.textContent = "（还没有读取）";
      filesEl.appendChild(empty);
    }
  };

  const renderTables = (): void => {
    tablesEl.innerHTML = "";
    tableCount.textContent = tables.length > 0 ? `(${tables.length})` : "";
    for (const t of tables) {
      const el = document.createElement("div");
      el.className = `db-table-item${t.name === activeTable ? " active" : ""}`;
      el.textContent = t.name;
      el.title = t.sql ?? t.name;
      el.addEventListener("click", () => void selectTable(t.name));
      tablesEl.appendChild(el);
    }
  };

  /* ---------- SharedPreferences ---------- */

  const parsePrefsXml = (xml: string): PrefEntry[] => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) {
      throw new Error(`SharedPreferences XML 解析失败：${err.textContent ?? "格式错误"}`);
    }
    const root = doc.documentElement;
    const out: PrefEntry[] = [];
    for (const el of Array.from(root.children)) {
      const key = el.getAttribute("name") ?? "";
      if (!key) continue;
      const type = el.tagName.toLowerCase();
      let value = "";
      if (type === "set") {
        value = Array.from(el.children)
          .map((c) => c.textContent ?? "")
          .join(", ");
      } else if (["int", "long", "float", "boolean"].includes(type)) {
        // Android 把这些类型写在 value 属性里：<int name="x" value="3" />
        value = el.getAttribute("value") ?? el.textContent ?? "";
      } else {
        value = el.textContent ?? "";
      }
      out.push({ key, type, value });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  };

  const renderPrefs = (): void => {
    const q = prefsSearch.value.trim().toLowerCase();
    const flutterOnly = prefsFlutter.checked;
    const list = prefsEntries.filter((e) => {
      if (flutterOnly && !e.key.startsWith("flutter.")) return false;
      if (!q) return true;
      return e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q);
    });

    prefsGrid.innerHTML = "";
    const head = prefsGrid.createTHead().insertRow();
    for (const h of ["键", "类型", "值"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    const body = prefsGrid.createTBody();
    for (const e of list) {
      const tr = body.insertRow();
      const k = tr.insertCell();
      k.textContent = e.key;
      k.className = "prefs-key";
      k.title = e.key;
      const t = tr.insertCell();
      t.textContent = e.type === "set" ? "set" : e.type;
      t.className = "prefs-type";
      const v = tr.insertCell();
      const shown = e.value.length > 1200 ? `${e.value.slice(0, 1200)}…` : e.value;
      v.textContent = shown;
      v.className = "prefs-value";
      if (e.value.length > 1200) {
        v.title = e.value;
        v.dataset.full = e.value;
      }
    }
    if (list.length === 0) {
      const tr = body.insertRow();
      const td = tr.insertCell();
      td.colSpan = 3;
      td.className = "db-null";
      td.textContent = prefsEntries.length
        ? "没有匹配的键"
        : "这个文件里没有键值（或尚未读取）";
    }

    const filtered = list.length !== prefsEntries.length;
    prefsStatus.textContent = prefsEntries.length
      ? `${list.length}${filtered ? ` / ${prefsEntries.length}` : ""} 项`
      : "";
    prefsPathEl.textContent = prefsActivePath;
    prefsPathEl.title = prefsActivePath;
  };

  const readPrefs = async (remotePath: string): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial || !pkg) return;
    prefsStatus.textContent = "读取中…";
    try {
      const xml = await invoke<string>("android_prefs_read", {
        serial,
        package: pkg,
        remotePath,
      });
      prefsEntries = parsePrefsXml(xml);
      prefsActivePath = remotePath;
      renderPrefs();
    } catch (e) {
      prefsEntries = [];
      prefsActivePath = remotePath;
      renderPrefs();
      prefsStatus.textContent = dbErrorText(e);
    }
  };

  const loadPrefs = async (force = false): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial) {
      prefsStatus.textContent = "没有可用设备（检查 USB 调试与授权）";
      return;
    }
    if (!pkg) {
      prefsStatus.textContent = "请填写包名（applicationId）";
      return;
    }
    const key = `${serial}|${pkg}`;
    if (!force && prefsLoadedFor === key && prefsFiles.length > 0) {
      renderPrefs();
      return;
    }

    prefsStatus.textContent = "读取 shared_prefs 列表…";
    prefsRefresh.disabled = true;
    try {
      const old = prefsFile.value;
      prefsFiles = await invoke<DbFileInfo[]>("android_prefs_files", {
        serial,
        package: pkg,
      });
      prefsFile.innerHTML = "";
      for (const f of prefsFiles) {
        const o = document.createElement("option");
        o.value = f.path;
        const name = f.path.split("/").pop() ?? f.path;
        o.textContent = `${name}（${dbSize(f.size)}）`;
        prefsFile.appendChild(o);
      }
      if (prefsFiles.length === 0) {
        prefsEntries = [];
        prefsActivePath = "";
        prefsLoadedFor = key;
        prefsFile.innerHTML = "";
        renderPrefs();
        prefsStatus.textContent =
          "没有找到 shared_prefs/*.xml（release 包、未安装，或 run-as 不可用）";
        return;
      }
      const wanted = prefsFiles.some((f) => f.path === old)
        ? old
        : prefsFiles[0].path;
      prefsFile.value = wanted;
      await readPrefs(wanted);
      prefsLoadedFor = key;
    } catch (e) {
      prefsStatus.textContent = dbErrorText(e);
    } finally {
      prefsRefresh.disabled = false;
    }
  };

  const closeSession = (): void => {
    if (sessionId) {
      const id = sessionId;
      sessionId = null;
      void invoke("android_db_close", { sessionId: id }).catch(() => undefined);
    }
    localPath = "";
  };

  const loadRows = async (): Promise<void> => {
    if (!sessionId || !activeTable) return;
    status.textContent = "读取中…";
    try {
      const page = await invoke<DbPageInfo>("android_db_rows", {
        sessionId,
        table: activeTable,
        offset,
        limit,
      });
      total = page.total ?? 0;
      renderGrid(dataGrid, page);
      const from = page.rows.length === 0 ? 0 : offset + 1;
      const to = offset + page.rows.length;
      pageInfo.textContent = total === 0 ? "空表" : `${from}–${to} / ${total}`;
      prevBtn.disabled = offset <= 0;
      nextBtn.disabled = total === 0 || offset + page.rows.length >= total;
      status.textContent = `${page.rows.length} 行 · ${page.elapsedMs} ms${page.truncated ? " · 已截断" : ""}`;
    } catch (e) {
      status.textContent = String(e);
    }
  };

  const selectTable = async (name: string): Promise<void> => {
    activeTable = name;
    offset = 0;
    renderTables();
    switchTab("data");
    await loadRows();
  };

  const openFile = async (f: DbFileInfo): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial || !pkg) return;

    closeSession();
    activeFile = f.path;
    activeTable = null;
    tables = [];
    offset = 0;
    total = 0;
    renderFiles();
    renderTables();
    clearGrid(dataGrid);
    clearGrid(sqlGrid);
    pageInfo.textContent = "—";
    status.textContent = "";
    sqlStatus.textContent = "";
    exportBtn.disabled = true;
    revealBtn.disabled = true;
    hint.textContent = `正在拉取 ${f.path} …`;

    try {
      const opened = await invoke<DbOpenInfo>("android_db_open", {
        serial,
        package: pkg,
        remotePath: f.path,
      });
      sessionId = opened.sessionId;
      localPath = opened.localPath;
      tables = opened.tables;
      renderTables();
      exportBtn.disabled = false;
      revealBtn.disabled = false;
      hint.textContent = `${dbSize(opened.size)} · ${opened.wal ? "已包含 WAL" : "无 WAL"} · 只读快照`;
      if (tables.length > 0) {
        await selectTable(tables[0].name);
      } else {
        status.textContent = "数据库里没有表";
      }
    } catch (e) {
      hint.textContent = dbErrorText(e);
    }
  };

  const loadFiles = async (): Promise<void> => {
    const serial = deviceSel.value;
    const pkg = pkgInput.value.trim();
    if (!serial) {
      hint.textContent = "没有可用设备（检查 USB 调试与授权）";
      return;
    }
    if (!pkg) {
      hint.textContent = "请填写包名（applicationId）";
      return;
    }
    localStorage.setItem(dbPkgKey(p.id), pkg);

    closeSession();
    files = [];
    activeFile = null;
    activeTable = null;
    tables = [];
    prefsFiles = [];
    prefsEntries = [];
    prefsLoadedFor = "";
    prefsActivePath = "";
    prefsFile.innerHTML = "";
    prefsGrid.innerHTML = "";
    renderFiles();
    renderTables();
    clearGrid(dataGrid);
    clearGrid(sqlGrid);
    exportBtn.disabled = true;
    revealBtn.disabled = true;
    hint.textContent = "读取数据库列表…";
    loadBtn.disabled = true;
    try {
      files = await invoke<DbFileInfo[]>("android_db_files", { serial, package: pkg });
      renderFiles();
      if (files.length === 0) {
        hint.textContent = "没找到 .db / .sqlite 文件（release 包、未安装，或 run-as 不可用）";
        return;
      }
      hint.textContent = `找到 ${files.length} 个数据库文件`;
      await openFile(files[0]);
    } catch (e) {
      hint.textContent = dbErrorText(e);
    } finally {
      loadBtn.disabled = false;
    }
  };

  const runSql = async (): Promise<void> => {
    if (!sessionId) {
      sqlStatus.textContent = "先打开一个数据库";
      return;
    }
    const sql = sqlInput.value.trim();
    if (!sql) return;
    sqlStatus.textContent = "执行中…";
    try {
      const page = await invoke<DbPageInfo>("android_db_query", { sessionId, sql, limit });
      renderGrid(sqlGrid, page);
      sqlStatus.textContent = `${page.rows.length} 行${page.truncated ? "（已截断）" : ""} · ${page.elapsedMs} ms`;
    } catch (e) {
      sqlStatus.textContent = String(e);
    }
  };

  const exportCopy = async (): Promise<void> => {
    if (!sessionId) return;
    const base = (activeFile ?? "database.db").split("/").pop() ?? "database.db";
    const suggested = `${base.replace(/\.(db|sqlite|sqlite3|db3)$/i, "")}.view.db`;
    const dest = await save({
      title: "导出数据库副本",
      defaultPath: suggested,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite"] }],
    });
    if (typeof dest !== "string" || !dest) return;
    try {
      await invoke("android_db_export", { sessionId, dest });
      toast("已导出副本，可直接用 DB Browser / DataGrip 打开");
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const revealCopy = async (): Promise<void> => {
    if (!localPath) return;
    try {
      await revealItemInDir(localPath);
    } catch (e) {
      toast(String(e), "error");
    }
  };

  for (const t of topTabs) {
    t.addEventListener("click", () =>
      switchMode(t.dataset.mode === "prefs" ? "prefs" : "db"),
    );
  }
  for (const t of subTabs) {
    t.addEventListener("click", () =>
      switchTab(t.dataset.tab === "sql" ? "sql" : "data"),
    );
  }
  const bindCellCopy = (grid: HTMLTableElement): void => {
    grid.addEventListener("contextmenu", (e) => {
      const td = (e.target as HTMLElement).closest("td");
      if (!td || !grid.contains(td)) return;
      e.preventDefault();
      showDbCellMenu(e, td as HTMLTableCellElement);
    });
  };
  bindCellCopy(dataGrid);
  bindCellCopy(sqlGrid);
  bindCellCopy(prefsGrid);
  loadBtn.addEventListener("click", () => void loadFiles());
  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - limit);
    void loadRows();
  });
  nextBtn.addEventListener("click", () => {
    offset += limit;
    void loadRows();
  });
  limitSel.addEventListener("change", () => {
    limit = Number(limitSel.value) || 200;
    offset = 0;
    void loadRows();
  });
  exportBtn.addEventListener("click", () => void exportCopy());
  revealBtn.addEventListener("click", () => void revealCopy());
  req<HTMLButtonElement>("#db-run", overlay).addEventListener("click", () => void runSql());
  sqlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runSql();
    }
  });
  prefsFile.addEventListener("change", () => {
    if (prefsFile.value) void readPrefs(prefsFile.value);
  });
  prefsRefresh.addEventListener("click", () => void loadPrefs(true));
  prefsSearch.addEventListener("input", renderPrefs);
  prefsFlutter.addEventListener("change", renderPrefs);

  const close = (): void => {
    closeSession();
    overlay.remove();
  };
  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const boot = async (): Promise<void> => {
    try {
      const env = await invoke<DbEnvInfo>("android_db_env", { projectId: p.id });
      const devices = env.devices.filter((d) => d.state === "device");
      deviceSel.innerHTML = "";
      for (const d of devices) {
        const o = document.createElement("option");
        o.value = d.serial;
        o.textContent = `${d.model || d.serial}（${d.serial}）`;
        deviceSel.appendChild(o);
      }
      const saved = localStorage.getItem(dbPkgKey(p.id)) ?? "";
      pkgInput.value = saved || env.package || env.foreground || "";
      hint.textContent =
        [env.adbVersion, ...env.notes].filter(Boolean).join(" · ") || "就绪";
      if (devices.length === 0) {
        hint.textContent = env.notes.join(" · ") || "没有可用设备（检查 USB 调试）";
        return;
      }
      if (pkgInput.value.trim()) void loadFiles();
    } catch (e) {
      hint.textContent = String(e);
    }
  };
  void boot();

  deviceSel.addEventListener("change", () => {
    if (currentTab === "prefs") {
      void loadPrefs(true);
      return;
    }
    if (pkgInput.value.trim()) void loadFiles();
  });
  pkgInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (currentTab === "prefs") void loadPrefs(true);
    else void loadFiles();
  });
}

/* ---------------- 设置页 ---------------- */

/** 最后一次编译（打包）的时间：exe 修改时间与前端打包时间取较大者。
 *  exe mtime ≈ 最后一次编译链接/打包；前端常量覆盖"只重打包了前端"的情况。 */
