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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(rename = "flutterTool", default)]
    pub flutter_tool: FlutterToolSetting,
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
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            settings: Settings::default(),
            projects: Vec::new(),
            command_templates: default_templates(),
        }
    }
}









