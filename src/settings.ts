/* ============================================================
   AppDeck — Settings（由 main.ts 拆分而来）
   ============================================================ */
import { APP_NAME, defaultSettings, setState, state, toast } from "./core";
import { render } from "./tree";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { Detected, SettingsModel, State } from "./core";
import type { FlutterRenameActivation, FlutterRenameStatus } from "./projects";

/** vite.config.ts 的 define 会在编译期注入该常量 */
declare const __BUILD_TIME__: string;

export async function buildStamp(): Promise<string | null> {
  let ms = 0;
  try {
    const exeMs = await invoke<number | null>("build_time");
    if (typeof exeMs === "number" && exeMs > 0) ms = exeMs;
  } catch {
    // 老后端 / 非 Tauri 环境：忽略，退回前端打包时间
  }
  const feMs = Date.parse(__BUILD_TIME__);
  if (Number.isFinite(feMs) && feMs > ms) ms = feMs;
  if (!ms) return null;

  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function openSettings(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="modal-head">
        <span>设置</span>
        <button class="modal-x" title="关闭">×</button>
      </div>
      <div class="modal-body" id="settings-body"></div>
      <div class="modal-foot">
        <span class="set-version" id="settings-version"></span>
        <span class="modal-hint" id="settings-hint"></span>
        <span class="flex1"></span>
        <button class="btn" id="set-detect">自动检测</button>
        <button class="btn" id="set-cancel">取消</button>
        <button class="btn primary" id="set-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#settings-body") as HTMLDivElement;

  // 单页滚动：所有分区按固定顺序排列（不再分页签）
  const SECTION_ORDER: Record<string, number> = {
    窗口与托盘: 1,
    命令模板: 2,
    会话恢复: 3,
    终端: 4,
    编辑器: 5,
    Git: 6,
    Flutter: 7,
    Android: 8,
    HarmonyOS: 9,
    Npm: 10,
    Docker: 11,
  };

  /** 上一次「自动检测」的结果；只用来在输入框下面提示，不直接改用户填的值 */
  let detected: Detected | null = null;

  const hint = overlay.querySelector("#settings-hint") as HTMLSpanElement;
  const draft: SettingsModel = JSON.parse(
    JSON.stringify(state.settings ?? defaultSettings()),
  ) as SettingsModel;

  const close = (): void => overlay.remove();

  // 左下角：最后一次编译（打包）时间。原来显示 "state schema vN"——
  // 内部版本号对用户没意义，拿到包只需要知道"这个版本是什么时候出的"。
  const versionEl = overlay.querySelector("#settings-version") as HTMLSpanElement;
  versionEl.textContent = `${APP_NAME} · 正在读取编译时间…`;
  void buildStamp().then((t) => {
    versionEl.textContent = t
      ? `${APP_NAME} · 最后编译 ${t}`
      : `${APP_NAME} · 编译时间未知`;
  });

  const section = (title: string, desc: string): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "set-section";
    // 单页里靠序号排序，避免 build() 里的书写顺序绑死展示顺序
    s.dataset.pri = String(SECTION_ORDER[title] ?? 99);
    s.dataset.title = title;
    const h = document.createElement("div");
    h.className = "set-title";
    h.textContent = title;
    s.appendChild(h);
    if (desc) {
      const d = document.createElement("div");
      d.className = "set-desc";
      d.textContent = desc;
      s.appendChild(d);
    }
    body.appendChild(s);
    return s;
  };

  /**
   * 某一项「自动检测」得到的结果。
   * 按「分区标题 + 字段标签」对应，这样 13 个输入框不用逐个改调用。
   */
  const detectedValueFor = (sec: string, label: string): string | null => {
    const d = detected;
    if (!d) return null;

    let v: string | null | undefined;
    if (sec === "Flutter") {
      v = label === "自定义路径" ? d.flutter : null;
    } else if (sec === "Android") {
      const m: Record<string, string | null | undefined> = {
        "SDK 目录": d.android.sdkPath,
        "emulator.exe": d.android.emulatorPath,
        "AVD 目录": d.android.avdPath,
        "build-tools": d.android.buildToolsPath,
        keytool: d.android.keytoolPath,
      };
      v = m[label];
    } else if (sec === "HarmonyOS") {
      const m: Record<string, string | null | undefined> = {
        "Emulator 目录": d.harmony.emulatorPath,
        实例目录: d.harmony.instancePath,
        镜像目录: d.harmony.imageRoot,
        "Flutter 分支": d.harmony.flutterPath,
        "SDK 目录": d.harmony.sdkPath,
      };
      v = m[label];
    } else if (sec === "编辑器") {
      v = label === "编辑器程序" ? d.editor.path : null;
    } else if (sec === "Git") {
      v = d.git.desktopPath;
    } else if (sec === "Npm") {
      v = label === "node 目录" ? d.npm.nodePath : null;
    } else if (sec === "Docker") {
      v = label === "docker 路径" ? d.docker.dockerPath : null;
    }

    const t = (v ?? "").trim();
    return t ? t : null;
  };

  /**
   * 一个输入行。
   * 与「自动检测」结果不一致时，在下方提示检测到的值并提供「填写」按钮——
   * 不直接覆盖，因为输入框里可能是用户手填的。
   */
  const field = (
    parent: HTMLElement,
    label: string,
    value: string | null,
    onChange: (v: string | null) => void,
    opts: { browse?: "dir" | "none" } = {},
  ): void => {
    const row = document.createElement("div");
    row.className = "set-row";

    const lab = document.createElement("label");
    lab.textContent = label;

    const input = document.createElement("input");
    input.className = "set-input";
    input.value = value ?? "";
    input.placeholder = "未配置";
    input.addEventListener("input", () => onChange(input.value.trim() || null));

    row.append(lab, input);

    // 选文件（exe）的字段自带专用按钮（带扩展名过滤），这里就不再给目录选择器
    if ((opts.browse ?? "dir") === "dir") {
      const browse = document.createElement("button");
      browse.className = "btn";
      browse.textContent = "浏览…";
      browse.addEventListener("click", () => {
        void (async () => {
          const picked = await open({ directory: true, multiple: false, title: `选择${label}` });
          if (typeof picked === "string") {
            input.value = picked;
            onChange(picked);
          }
        })();
      });
      row.appendChild(browse);
    }

    parent.appendChild(row);

    const auto = (detectedValueFor(parent.dataset.title ?? "", label) ?? "").trim();
    const current = (value ?? "").trim();
    if (auto && auto !== current) {
      const tip = document.createElement("div");
      tip.className = "set-detected";

      const text = document.createElement("span");
      text.className = "set-detected-val";
      text.textContent = `检测到：${auto}`;
      text.title = auto;

      const fill = document.createElement("button");
      fill.className = "btn btn-tiny";
      fill.textContent = "填写";
      fill.addEventListener("click", () => {
        onChange(auto);
        build();
      });

      tip.append(text, fill);
      parent.appendChild(tip);
    }
  };

  const build = (): void => {
    body.innerHTML = "";

    // 窗口与托盘
    {
      // 老状态文件里没有 window 字段：补默认值，别让下拉框空着
      if (draft.window?.closeBehavior !== "quit" && draft.window?.closeBehavior !== "tray") {
        draft.window = { closeBehavior: "quit" };
      }

      const s = section(
        "窗口与托盘",
        "点标题栏关闭按钮时做什么。托盘图标常驻，左键或双击可把窗口拉回来。",
      );

      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "关闭按钮";

      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const [value, text] of [
        ["quit", "退出程序"],
        ["tray", "最小化到托盘"],
      ] as const) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        if (draft.window.closeBehavior === value) o.selected = true;
        sel.appendChild(o);
      }

      const note = document.createElement("div");
      note.className = "set-desc";
      const syncNote = (): void => {
        note.textContent =
          draft.window.closeBehavior === "tray"
            ? "关闭后进程驻留托盘：正在跑的构建和终端不会中断；从托盘「显示主窗口」或双击图标恢复。"
            : "关闭即退出：先结束所有终端会话与 flutter daemon，再关闭程序。";
      };
      sel.addEventListener("change", () => {
        draft.window = { closeBehavior: sel.value };
        syncNote();
      });
      syncNote();

      row.append(lab, sel);
      s.appendChild(row);
      s.appendChild(note);
    }

    // Flutter
    {
      const s = section("Flutter", "auto：优先项目 .fvm，其次自定义路径，最后 PATH");
      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "模式";
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["auto", "custom", "fvm"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        if (draft.flutterTool.mode === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.flutterTool.mode = sel.value;
      });
      row.append(lab, sel);
      s.appendChild(row);
      field(s, "自定义路径", draft.flutterTool.customPath, (v) => {
        draft.flutterTool.customPath = v;
      });

      // rename CLI：检查 pub global 安装与 PATH；安装/更新也放这里，避免用户另开终端
      const renameRow = document.createElement("div");
      renameRow.className = "set-row";
      const renameLab = document.createElement("label");
      renameLab.textContent = "rename CLI";
      const renameCell = document.createElement("div");
      renameCell.className = "set-cell";
      const renameState = document.createElement("span");
      renameState.className = "set-desc";
      renameState.textContent = "检查中…";
      const renameCheck = document.createElement("button");
      renameCheck.className = "btn";
      renameCheck.textContent = "重新检查";
      const renameInstall = document.createElement("button");
      renameInstall.className = "btn";
      renameInstall.textContent = "安装 / 更新";
      const renameCopy = document.createElement("button");
      renameCopy.className = "btn";
      renameCopy.textContent = "复制 PATH 目录";
      renameCopy.hidden = true;
      renameCell.append(renameState, renameCheck, renameInstall, renameCopy);
      renameRow.append(renameLab, renameCell);
      s.appendChild(renameRow);

      const renameNote = document.createElement("div");
      renameNote.className = "set-desc";
      s.appendChild(renameNote);

      let renamePubBin = "";
      const renderRename = (st: FlutterRenameStatus): void => {
        renamePubBin = st.pubBin;
        renameState.classList.remove("rename-ok", "rename-warn", "rename-bad");
        if (!st.installed) {
          renameState.textContent = "未安装";
          renameState.classList.add("rename-bad");
        } else if (!st.onPath) {
          renameState.textContent = `已安装 ${st.version ?? ""} · 不在 PATH`;
          renameState.classList.add("rename-warn");
        } else {
          renameState.textContent = `已安装 ${st.version ?? ""} · PATH 已就绪`;
          renameState.classList.add("rename-ok");
        }

        const parts: string[] = [];
        if (st.exe) parts.push(`命令：${st.exe}`);
        if (!st.onPath) {
          parts.push(
            `pub bin：${st.pubBin}（把这个目录加入用户 PATH 后，终端里才能直接运行 rename）`,
          );
        }
        if (!st.installed) {
          parts.push("点「安装 / 更新」会执行：flutter pub global activate rename");
        }
        if (st.error) parts.push(st.error);
        renameNote.textContent = parts.join("\n");
        renameNote.style.whiteSpace = "pre-line";
        renameCopy.hidden = st.onPath;
        renameCopy.title = `复制 ${st.pubBin}`;
      };

      const refreshRename = async (force = false): Promise<void> => {
        renameCheck.disabled = true;
        renameState.textContent = "检查中…";
        try {
          const st = await invoke<FlutterRenameStatus>(
            force ? "rename_refresh" : "rename_status",
          );
          renderRename(st);
        } catch (e) {
          renameState.textContent = "检查失败";
          renameState.classList.add("rename-bad");
          renameNote.textContent = String(e);
        } finally {
          renameCheck.disabled = false;
        }
      };

      renameCheck.addEventListener("click", () => void refreshRename(true));
      renameInstall.addEventListener("click", () => {
        void (async () => {
          renameInstall.disabled = true;
          renameInstall.textContent = "安装中…";
          renameState.textContent = "正在执行 flutter pub global activate rename…";
          try {
            const res = await invoke<FlutterRenameActivation>("rename_activate");
            renderRename(res.status);
            toast(
              res.status.onPath
                ? `rename 已安装并在 PATH 中：${res.status.version ?? ""}`
                : `rename 已安装，但不在 PATH；请把 ${res.status.pubBin} 加入 PATH`,
            );
          } catch (e) {
            renameState.textContent = "安装失败";
            renameState.classList.add("rename-bad");
            renameNote.textContent = String(e);
            toast(String(e), "error");
          } finally {
            renameInstall.disabled = false;
            renameInstall.textContent = "安装 / 更新";
          }
        })();
      });
      renameCopy.addEventListener("click", () => {
        if (!renamePubBin) return;
        void navigator.clipboard
          .writeText(renamePubBin)
          .then(() => toast("已复制 PATH 目录"))
          .catch((e) => toast(String(e), "error"));
      });
      void refreshRename();
    }

    // 会话恢复
    {
      const s = section("会话恢复", "重启后恢复 tab 与历史输出，但不自动拉起进程");
      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "历史";
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "清空已保存的会话历史";
      btn.addEventListener("click", () => {
        void (async () => {
          const ok = await confirm("清空后，下次启动不会再恢复这些 tab。确定？", {
            title: "清空会话历史",
            kind: "warning",
          });
          if (!ok) return;
          try {
            await invoke("clear_session_logs");
            toast("已清空会话历史");
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });
      row.append(lab, btn);
      s.appendChild(row);
    }

    // Android
    {
      const s = section("Android", "SDK、emulator.exe、AVD 目录");
      field(s, "SDK 目录", draft.android.sdkPath, (v) => {
        draft.android.sdkPath = v;
      });
      field(s, "emulator.exe", draft.android.emulatorPath, (v) => {
        draft.android.emulatorPath = v;
      });
      field(s, "AVD 目录", draft.android.avdPath, (v) => {
        draft.android.avdPath = v;
      });
      field(s, "build-tools", draft.android.buildToolsPath, (v) => {
        draft.android.buildToolsPath = v;
      });
      field(s, "keytool", draft.android.keytoolPath, (v) => {
        draft.android.keytoolPath = v;
      });
      const note = document.createElement("div");
      note.className = "set-desc";
      note.textContent =
        "build-tools（aapt2 / apksigner）留空则取 SDK 下最高版本；keytool 留空则自动探测。备案只用到这两个。";
      s.appendChild(note);
    }

    // HarmonyOS
    {
      const s = section("HarmonyOS", "DevEco 模拟器（Emulator.exe）与鸿蒙 Flutter 分支");
      field(s, "Emulator 目录", draft.harmony.emulatorPath, (v) => {
        draft.harmony.emulatorPath = v;
      });
      field(s, "实例目录", draft.harmony.instancePath, (v) => {
        draft.harmony.instancePath = v;
      });
      field(s, "镜像目录", draft.harmony.imageRoot, (v) => {
        draft.harmony.imageRoot = v;
      });
      field(s, "Flutter 分支", draft.harmony.flutterPath, (v) => {
        draft.harmony.flutterPath = v;
      });
      field(s, "SDK 目录", draft.harmony.sdkPath, (v) => {
        draft.harmony.sdkPath = v;
      });

      // 鸿蒙环境变量：只注入有 ohos/ 的工程
      const envTitle = document.createElement("div");
      envTitle.className = "set-sub";
      envTitle.textContent = "环境变量（仅鸿蒙工程生效）";
      s.appendChild(envTitle);

      const envNote = document.createElement("div");
      envNote.className = "set-desc";
      envNote.textContent =
        "如 FLUTTER_STORAGE_BASE_URL / PUB_CACHE / DEVECO_SDK_HOME / FLUTTER_GIT_URL。" +
        "项目里 .fvmrc 的 env 会覆盖这里的同名项；项目右键「环境变量…」可再按项目覆盖。";
      s.appendChild(envNote);

      const envBox = document.createElement("div");
      envBox.className = "env-list";
      s.appendChild(envBox);

      // 本地行数组，改完同步回 draft.harmony.env（空 KEY 不落盘）
      const rows: Array<[string, string]> = Object.entries(draft.harmony.env ?? {});
      const syncEnv = () => {
        const m: Record<string, string> = {};
        for (const [k, v] of rows) if (k.trim() !== "") m[k.trim()] = v;
        draft.harmony.env = m;
      };

      const renderEnv = () => {
        envBox.innerHTML = "";

        rows.forEach(([k, v], idx) => {
          const row = document.createElement("div");
          row.className = "env-row";

          const kEl = document.createElement("input");
          kEl.className = "set-input env-key";
          kEl.value = k;
          kEl.placeholder = "KEY";
          kEl.addEventListener("input", () => {
            rows[idx][0] = kEl.value;
            syncEnv();
          });

          const vEl = document.createElement("input");
          vEl.className = "set-input";
          vEl.value = v;
          vEl.placeholder = "value";
          vEl.addEventListener("input", () => {
            rows[idx][1] = vEl.value;
            syncEnv();
          });

          const del = document.createElement("button");
          del.className = "btn";
          del.textContent = "×";
          del.title = "删除该变量";
          del.addEventListener("click", () => {
            rows.splice(idx, 1);
            syncEnv();
            renderEnv();
          });

          row.append(kEl, vEl, del);
          envBox.appendChild(row);
        });

        if (rows.length === 0) {
          const empty = document.createElement("div");
          empty.className = "set-desc";
          empty.textContent = "（暂无，可点下方添加）";
          envBox.appendChild(empty);
        }

        const add = document.createElement("button");
        add.className = "btn";
        add.textContent = "＋ 添加变量";
        add.addEventListener("click", () => {
          rows.push(["", ""]);
          renderEnv();
        });
        envBox.appendChild(add);
      };
      renderEnv();

      // 终端环境提示属于鸿蒙，放在这里（原来错放在「通用 → 终端」下面）
      const termHint = document.createElement("div");
      termHint.className = "set-desc";
      termHint.textContent =
        "打开的终端会继承项目环境：鸿蒙工程自动注入全局/项目变量并前置 PATH shim，" +
        "可直接敲 flutter --version。";
      s.appendChild(termHint);
    }

    // 默认终端
    {
      const s = section("终端", "项目右键「在终端中打开」使用；留空则自动探测");
      field(
        s,
        "终端程序",
        draft.terminal?.path ?? "",
        (v) => {
          const t = (v ?? "").trim();
          draft.terminal = { ...(draft.terminal ?? { path: null, filters: [] }), path: t === "" ? null : t };
        },
        { browse: "none" }, // 下面有带 exe 过滤的「浏览 exe…」
      );

      const bar = document.createElement("div");
      bar.className = "set-desc";
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.alignItems = "center";

      const detectBtn = document.createElement("button");
      detectBtn.className = "btn";
      detectBtn.textContent = "从系统读取";
      detectBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const list = await invoke<Array<{ name: string; path: string }>>("detect_terminals");
            if (list.length === 0) {
              toast("没有检测到可用终端", "error");
              return;
            }
            draft.terminal = { ...(draft.terminal ?? { path: null, filters: [] }), path: list[0].path };
            const more = list.slice(1).map((x) => x.name).join("、");
            toast(`已选择 ${list[0].name}${more ? `；系统还检测到：${more}` : ""}`);
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      const browseBtn = document.createElement("button");
      browseBtn.className = "btn";
      browseBtn.textContent = "浏览 exe…";
      browseBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择终端可执行文件",
              filters: [{ name: "可执行文件", extensions: ["exe"] }],
              defaultPath: draft.terminal?.path ?? undefined,
            });
            if (!picked) return;
            const p = Array.isArray(picked) ? picked[0] : picked;
            draft.terminal = { ...(draft.terminal ?? { path: null, filters: [] }), path: p };
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(detectBtn, browseBtn);
      s.appendChild(bar);
    }

    // 默认编辑器（终端里的路径可点开）
    {
      const s = section(
        "编辑器",
        "终端里的路径和 package: 链接用 Ctrl+单击打开；留空则自动探测",
      );
      field(
        s,
        "编辑器程序",
        draft.editor?.path ?? "",
        (v) => {
          const t = (v ?? "").trim();
          draft.editor = { path: t === "" ? null : t };
        },
        { browse: "none" }, // 下面有带 exe 过滤的「浏览 exe…」
      );

      const bar = document.createElement("div");
      bar.className = "set-desc";
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.alignItems = "center";

      const browseBtn = document.createElement("button");
      browseBtn.className = "btn";
      browseBtn.textContent = "浏览 exe…";
      browseBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择编辑器程序（Code.exe / zed.exe / sublime_text.exe…）",
              filters: [{ name: "可执行文件", extensions: ["exe"] }],
              defaultPath: draft.editor?.path ?? undefined,
            });
            if (!picked) return;
            const p = Array.isArray(picked) ? picked[0] : picked;
            draft.editor = { path: p };
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(browseBtn);
      s.appendChild(bar);

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "留空则自动探测（VS Code / Zed / Sublime Text / Cursor / Notepad++）。" +
        "请选 GUI 程序，不要选 bin 目录里的 code.cmd、subl 这类启动脚本";
      s.appendChild(hint);

      // 留空时告诉用户实际会用哪一个，免得"未配置"让人以为不能用
      void (async () => {
        try {
          const auto = await invoke<string | null>("detect_editor_path");
          // 跑过「自动检测」后，输入框下面已经有「检测到：…」，这里不再重复
          if (!draft.editor?.path && auto && !detected) {
            hint.textContent = `留空时使用：${auto}`;
          }
        } catch {
          /* 探测失败就保持通用提示 */
        }
      })();
    }

    // Git 桌面客户端（GitHub Desktop 等）
    {
      const s = section(
        "Git",
        "填了程序后，项目右键会出现「在 Git Desktop 中打开」；留空则不显示该项",
      );

      field(
        s,
        "Git Desktop 程序",
        draft.git?.desktopPath ?? "",
        (v) => {
          const t = (v ?? "").trim();
          draft.git = { desktopPath: t === "" ? null : t };
        },
        { browse: "none" }, // 下面有带 exe 过滤的「浏览…」
      );

      const bar = document.createElement("div");
      bar.className = "set-desc";
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.alignItems = "center";

      const browseBtn = document.createElement("button");
      browseBtn.className = "btn";
      browseBtn.textContent = "浏览 GitHubDesktop.exe…";
      browseBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const picked = await open({
              multiple: false,
              title: "选择 Git 桌面客户端（GitHubDesktop.exe / SourceTree.exe…）",
              filters: [{ name: "可执行文件", extensions: ["exe"] }],
              defaultPath: draft.git?.desktopPath ?? undefined,
            });
            if (!picked) return;
            const p = Array.isArray(picked) ? picked[0] : picked;
            draft.git = { desktopPath: p };
            build();
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      const fillBtn = document.createElement("button");
      fillBtn.className = "btn";
      fillBtn.textContent = "读取已安装的 GitHub Desktop";
      fillBtn.addEventListener("click", () => {
        void (async () => {
          try {
            const auto = await invoke<string | null>("detect_git_desktop_path");
            if (!auto) {
              toast("没有自动检测到 GitHub Desktop，请手动浏览 exe", "error");
              return;
            }
            draft.git = { desktopPath: auto };
            build();
            toast("已填入探测到的 GitHub Desktop");
          } catch (e) {
            toast(String(e), "error");
          }
        })();
      });

      bar.append(browseBtn, fillBtn);
      s.appendChild(bar);

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "GitHub Desktop 会自动用 --cli-open 打开项目目录；其它客户端按「程序 + 目录」启动。";
      s.appendChild(hint);
    }

    // Npm
    {
      const s = section(
        "Npm",
        "导入 package.json 时按这里的规则生成命令；分类只是猜测，可在命令里逐条改",
      );

      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "包管理器";
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["auto", "npm", "pnpm", "yarn"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m === "auto" ? "auto（按 lockfile 探测）" : m;
        if ((draft.npm?.manager ?? "auto") === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.npm = { ...(draft.npm ?? { nodePath: null }), manager: sel.value };
      });
      const cell = document.createElement("div");
      cell.className = "set-cell";
      cell.appendChild(sel);
      row.append(lab, cell);
      s.appendChild(row);

      field(s, "node 目录", draft.npm?.nodePath ?? "", (v) => {
        const t = (v ?? "").trim();
        draft.npm = { ...(draft.npm ?? { manager: null }), nodePath: t === "" ? null : t };
      });

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "auto：pnpm-lock.yaml > yarn.lock > package-lock.json > npm。" +
        "dev/start/serve → 长时间运行；build/bundle → 一次性产物；其余 → 普通任务。";
      s.appendChild(hint);
    }

    // Docker
    {
      const s = section("Docker", "docker-compose 导入尚未实现，这里先保留路径与调用风格");

      field(s, "docker 路径", draft.docker?.dockerPath ?? "", (v) => {
        const t = (v ?? "").trim();
        draft.docker = {
          ...(draft.docker ?? { composeStyle: null }),
          dockerPath: t === "" ? null : t,
        };
      });

      const row = document.createElement("div");
      row.className = "set-row";
      const lab = document.createElement("label");
      lab.textContent = "compose 风格";
      const sel = document.createElement("select");
      sel.className = "set-input";
      for (const m of ["auto", "v2", "v1"]) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent =
          m === "auto" ? "auto（优先 v2）" : m === "v2" ? "v2：docker compose" : "v1：docker-compose";
        if ((draft.docker?.composeStyle ?? "auto") === m) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        draft.docker = { ...(draft.docker ?? { dockerPath: null }), composeStyle: sel.value };
      });
      const cell = document.createElement("div");
      cell.className = "set-cell";
      cell.appendChild(sel);
      row.append(lab, cell);
      s.appendChild(row);

      const hint = document.createElement("div");
      hint.className = "set-desc";
      hint.textContent =
        "导入 compose 后：每个 service 生成「启动 / 日志」，整份文件再加一条「全部停止」。" +
        "命令用确定性 id 去重，服务被删只标失效、不删数据。";
      s.appendChild(hint);
    }

    // 单页滚动：按 SECTION_ORDER 重排（书写顺序不必等于展示顺序）
    const sections = Array.from(body.querySelectorAll<HTMLElement>(".set-section"));
    sections.sort((a, b) => Number(a.dataset.pri) - Number(b.dataset.pri));
    for (const el of sections) body.appendChild(el);
  };

  build();

  (overlay.querySelector(".modal-x") as HTMLButtonElement).addEventListener("click", close);
  (overlay.querySelector("#set-cancel") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const detectBtn = overlay.querySelector("#set-detect") as HTMLButtonElement;
  detectBtn.addEventListener("click", () => {
    // 只做探测：不覆盖用户已经填过的值。
    // 探测结果以「检测到：…」+「填写」的形式挂在对应输入框下面，由用户决定要不要用。
    detectBtn.disabled = true;
    hint.textContent = "检测中…";
    void (async () => {
      try {
        detected = await invoke<Detected>("detect_toolchains");
        build();
        hint.textContent = "";
        toast("检测完成：与当前设置不同的项已在输入框下方标出");
      } catch (e) {
        hint.textContent = String(e);
      } finally {
        detectBtn.disabled = false;
      }
    })();
  });

  (overlay.querySelector("#set-save") as HTMLButtonElement).addEventListener("click", () => {
    void (async () => {
      try {
        setState(await invoke<State>("save_settings", { settings: draft }));
        close();
        render();
        toast("设置已保存");
      } catch (e) {
        hint.textContent = String(e);
      }
    })();
  });
}

/* ---------------- 启动 ---------------- */

