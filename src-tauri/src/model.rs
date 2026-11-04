use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const SCHEMA_VERSION: u32 = 6;

/// 内置命令模板：新项目会自动套用，也可在设置里增删改
/// 内置命令模板。
///
/// **v5 起只保留 Pub Get**：`Debug` / `Build APK` / `Build Windows` / `Build Web`
/// 已退役——它们的能力改由「项目右键 → 平台 → 动作」动态派生，
/// 不再需要在每个项目里存一条命令。
pub fn default_templates() -> Vec<Command> {
    vec![Command {
        id: "tpl-pub-get".into(),
        name: "Pub Get".into(),
        kind: "custom".into(),
        program: Some("%FLUTTER%".into()),
        cwd: None,
        flutter_mode: None,
        args: vec!["pub".into(), "get".into()],
        env: HashMap::new(),
        tool_args: vec![],
        device_id: None,
        emulator_id: None,
        build_type: None,
        source: Some("template".into()),
        scope: Some("global".into()),
        stale: false,
        group: None,
        role: None,
        category: Some("flutter".into()),
    }]
}

/// v5 退役的内置模板 id（迁移时从旧状态文件里清掉）
pub const RETIRED_TEMPLATE_IDS: [&str; 4] = [
    "tpl-debug",
    "tpl-build-apk",
    "tpl-build-windows",
    "tpl-build-web",
];

/// 这些名字 + 类型的模板实例化命令也要一并清理
pub const RETIRED_COMMAND_NAMES: [&str; 4] =
    ["Debug", "Build APK", "Build Windows", "Build Web"];

pub fn instantiate_template(tpl: &Command, project_id: &str) -> Command {
    let mut c = tpl.clone();
    c.id = make_id("cmd", &format!("{}|{}|{}", project_id, tpl.name, tpl.kind));
    c.source = Some("template".into());
    // 导入到项目后一律按项目作用域处理
    c.scope = Some("project".into());
    c
}

/// 稳定 ID 生成（FNV-1a），避免引入 uuid 依赖
pub fn make_id(prefix: &str, seed: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{}-{:016x}", prefix, h)
}

fn default_mode() -> String {
    "auto".to_string()
}

fn default_kind() -> String {
    "run".to_string()
}

fn default_project_kind() -> String {
    "single".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlutterToolSetting {
    /// auto | custom | fvm
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(rename = "customPath", default)]
    pub custom_path: Option<String>,
}

impl Default for FlutterToolSetting {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            custom_path: None,
        }
    }
}

/// 主窗口 / 托盘行为
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSettings {
    /// quit | tray
    ///
    /// 点标题栏关闭按钮时：`quit` 退出程序；`tray` 收进系统托盘（进程继续
    /// 跑，正在执行的 flutter build / 终端会话不受影响）。
    ///
    /// 默认 `quit`：和老版本行为一致，升级后不会出现"点了叉程序还在"的困惑。
    #[serde(rename = "closeBehavior", default = "default_close_behavior")]
    pub close_behavior: String,
}

fn default_close_behavior() -> String {
    "quit".to_string()
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            close_behavior: default_close_behavior(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(rename = "flutterTool", default)]
    pub flutter_tool: FlutterToolSetting,
    #[serde(default)]
    pub window: WindowSettings,
    #[serde(default)]
    pub android: AndroidSettings,
    #[serde(default)]
    pub harmony: HarmonySettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub npm: NpmSettings,
    #[serde(default)]
    pub docker: DockerSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub git: GitSettings,
}

/// Git 桌面客户端（GitHub Desktop 等）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitSettings {
    /// 客户端 exe 的完整路径；**留空则项目右键不显示「在 Git Desktop 中打开」**
    #[serde(rename = "desktopPath", default)]
    pub desktop_path: Option<String>,
}

/// 默认编辑器（VS Code / Zed / Sublime Text / Cursor / Notepad++ …）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EditorSettings {
    /// 编辑器可执行文件的完整路径；留空表示自动探测。
    ///
    /// 老状态文件里这个字段叫 `vscodePath`，用 alias 兼容，保存后写成 `path`。
    #[serde(alias = "vscodePath", default)]
    pub path: Option<String>,
}

/// npm / Node 相关设置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NpmSettings {
    /// auto | npm | pnpm | yarn
    /// auto：按 lockfile 探测（pnpm-lock.yaml > yarn.lock > package-lock.json > npm）
    #[serde(default)]
    pub manager: Option<String>,
    /// node / npm 所在目录；留空表示用 PATH
    #[serde(rename = "nodePath", default)]
    pub node_path: Option<String>,
}

/// Docker 相关设置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DockerSettings {
    /// docker 可执行文件路径；留空表示用 PATH
    #[serde(rename = "dockerPath", default)]
    pub docker_path: Option<String>,
    /// auto | v2 | v1 —— v2 是 `docker compose`，v1 是 `docker-compose`
    #[serde(rename = "composeStyle", default)]
    pub compose_style: Option<String>,
}

/// 默认终端（项目右键「在终端中打开」使用）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TerminalSettings {
    /// 终端可执行文件路径；留空则自动探测（pwsh > wt > powershell > cmd > bash）
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AndroidSettings {
    /// Android SDK 根目录
    #[serde(rename = "sdkPath", default)]
    pub sdk_path: Option<String>,
    /// emulator.exe 路径（通常 <sdk>/emulator/emulator.exe）
    #[serde(rename = "emulatorPath", default)]
    pub emulator_path: Option<String>,
    /// AVD 目录（通常 %USERPROFILE%\.android\avd）
    #[serde(rename = "avdPath", default)]
    pub avd_path: Option<String>,
    /// build-tools 目录（含 aapt2 / apksigner）；留空则取 <sdk>/build-tools 下最高版本
    #[serde(rename = "buildToolsPath", default)]
    pub build_tools_path: Option<String>,
    /// keytool 路径；留空则自动探测
    #[serde(rename = "keytoolPath", default)]
    pub keytool_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HarmonySettings {
    /// DevEco 的 Emulator.exe
    #[serde(rename = "emulatorPath", default)]
    pub emulator_path: Option<String>,
    /// 实例目录（通常 %LOCALAPPDATA%\Huawei\Emulator\deployed）
    #[serde(rename = "instancePath", default)]
    pub instance_path: Option<String>,
    /// 系统镜像根目录
    #[serde(rename = "imageRoot", default)]
    pub image_root: Option<String>,
    /// 鸿蒙 Flutter 分支（flutter_flutter）
    #[serde(rename = "flutterPath", default)]
    pub flutter_path: Option<String>,
    /// 鸿蒙 SDK 路径
    #[serde(rename = "sdkPath", default)]
    pub sdk_path: Option<String>,
    /// 全局鸿蒙环境变量（**仅注入鸿蒙工程**）：
    /// FLUTTER_STORAGE_BASE_URL / PUB_CACHE / DEVECO_SDK_HOME / FLUTTER_GIT_URL 等
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub id: String,
    pub name: String,
    /// run | build
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub program: Option<String>,
    /// 相对「工作区根」的路径（不是相对 .vscode）
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(rename = "flutterMode", default)]
    pub flutter_mode: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(rename = "toolArgs", default)]
    pub tool_args: Vec<String>,
    #[serde(rename = "deviceId", default)]
    pub device_id: Option<String>,
    #[serde(rename = "emulatorId", default)]
    pub emulator_id: Option<String>,
    #[serde(rename = "buildType", default)]
    pub build_type: Option<String>,
    /// launch-json | manual
    #[serde(default)]
    pub source: Option<String>,
    /// project | global：全局模板可在项目右键直接执行，无需加入项目
    #[serde(default)]
    pub scope: Option<String>,
    /// 来源已失效：npm 命令对应的 script 已从 package.json 移除（保留命令，只做标记）
    #[serde(default)]
    pub stale: bool,
    /// 分组键：docker 里是服务名。树里把同组的命令折叠成一个节点
    #[serde(default)]
    pub group: Option<String>,
    /// 组内角色：up | stop | restart | rm | logs | shell | up-all | logs-all | down
    #[serde(default)]
    pub role: Option<String>,
    /// 模板分类：flutter | npm | docker | custom（只对全局模板有意义）。
    /// 为空时按 program/args 推断，见 `ops::template_category`。
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// single（自身是 Flutter 应用）| workspace（多应用，靠 cwd 区分）
    /// | folder（任意文件夹/目录，导入后命令为空，见 `ops::add_folder_to`）
    #[serde(default = "default_project_kind")]
    pub kind: String,
    #[serde(rename = "flutterTool", default)]
    pub flutter_tool: Option<FlutterToolSetting>,
    #[serde(default)]
    pub commands: Vec<Command>,
    /// 项目级环境变量。**只注入鸿蒙工程（有 ohos/ 目录）**，
    /// 优先级：全局鸿蒙 env < .fvmrc.env < 项目 env < 命令 env
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// 工具栏「自定义命令」：全局命令，不绑定项目。
/// 直接启动目标程序（.lnk 会先解析），不经过 ShellExecute，避免弹系统控制台。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommand {
    pub id: String,
    pub name: String,
    /// 用户选择的 .lnk / .exe；.lnk 会解析出 target
    pub program: String,
    /// 快捷方式解析出的真实 exe；运行优先用它
    #[serde(default)]
    pub target: Option<String>,
    /// Windows 命令行参数原文（快捷方式参数也存这里）
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// 全局命令模板库
    #[serde(rename = "commandTemplates", default)]
    pub command_templates: Vec<Command>,
    /// 工具栏自定义命令（全局）
    #[serde(rename = "customCommands", default)]
    pub custom_commands: Vec<CustomCommand>,
    /// 纯界面状态（与业务无关，丢了不影响功能）
    #[serde(default)]
    pub ui: UiState,
}

/// 界面状态：只放"下次打开还应该保持原样"的展示偏好
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    /// 右侧项目树里被折叠的项目 id（没列出来的 = 展开）
    #[serde(default)]
    pub collapsed_projects: Vec<String>,
    /// 进程面板的隐藏规则：程序名包含任一规则就不显示
    #[serde(default)]
    pub process_hide_rules: Vec<String>,
    /// 隐藏规则是否生效（默认开；关掉后规则保留，但不过滤）
    #[serde(default = "default_true")]
    pub process_hide_rules_enabled: bool,
    /// 进程面板是否自动刷新（默认开）
    #[serde(default = "default_true")]
    pub process_auto_refresh: bool,
}

fn default_true() -> bool {
    true
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            collapsed_projects: Vec::new(),
            process_hide_rules: Vec::new(),
            process_hide_rules_enabled: true,
            process_auto_refresh: true,
        }
    }
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            settings: Settings::default(),
            projects: Vec::new(),
            command_templates: default_templates(),
            custom_commands: Vec::new(),
            ui: UiState::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 老状态文件里没有 `window` 字段：必须补成「退出程序」。
    /// 否则升级后第一次点关闭按钮的行为无法预期（用户可能以为程序没退出）。
    #[test]
    fn settings_without_window_defaults_to_quit() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.window.close_behavior, "quit");
    }

    /// 前端用 camelCase，字段名写错就会静默丢设置——所以钉住序列化形状。
    #[test]
    fn close_behavior_roundtrips_as_camel_case() {
        let s = Settings {
            window: WindowSettings {
                close_behavior: "tray".into(),
            },
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"closeBehavior\":\"tray\""), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.window.close_behavior, "tray");
    }

    /// 编辑器设置从 `vscodePath` 改名成通用的 `path`：老状态文件必须还能读。
    #[test]
    fn editor_setting_accepts_legacy_vscode_path() {
        let legacy: Settings =
            serde_json::from_str(r#"{"editor":{"vscodePath":"C:\\apps\\Code.exe"}}"#).unwrap();
        assert_eq!(legacy.editor.path.as_deref(), Some(r"C:\apps\Code.exe"));

        // 新字段名也认，并且保存后统一写成 `path`
        let current: Settings =
            serde_json::from_str(r#"{"editor":{"path":"C:\\apps\\zed.exe"}}"#).unwrap();
        assert_eq!(current.editor.path.as_deref(), Some(r"C:\apps\zed.exe"));
        let json = serde_json::to_string(&current).unwrap();
        assert!(json.contains("\"path\":\"C:\\\\apps\\\\zed.exe\""), "{json}");
        assert!(!json.contains("vscodePath"), "{json}");
    }

    /// 进程面板偏好：老状态文件没有这些字段时，自动刷新/隐藏规则默认开。
    #[test]
    fn ui_state_defaults_auto_refresh_on_and_roundtrips() {
        let ui: UiState = serde_json::from_str("{}").unwrap();
        assert!(ui.process_auto_refresh, "默认应开启自动刷新");
        assert!(ui.process_hide_rules_enabled, "默认应启用隐藏规则");
        assert!(ui.process_hide_rules.is_empty());

        let mut state = State::default();
        assert!(state.ui.process_auto_refresh, "State::default 也应开启");
        assert!(state.ui.process_hide_rules_enabled);

        state.ui.process_hide_rules = vec!["svchost".into(), "SearchHost".into()];
        state.ui.process_hide_rules_enabled = false;
        state.ui.process_auto_refresh = false;
        let json = serde_json::to_string(&state.ui).unwrap();
        assert!(json.contains("\"processAutoRefresh\":false"), "{json}");
        assert!(json.contains("\"processHideRulesEnabled\":false"), "{json}");
        assert!(
            json.contains("\"processHideRules\":[\"svchost\",\"SearchHost\"]"),
            "{json}"
        );

        let back: UiState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.process_hide_rules.len(), 2);
        assert!(!back.process_hide_rules_enabled);
        assert!(!back.process_auto_refresh);
    }
}
