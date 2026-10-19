use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const SCHEMA_VERSION: u32 = 4;

/// 内置命令模板：新项目会自动套用，也可在设置里增删改
pub fn default_templates() -> Vec<Command> {
    vec![
        Command {
            id: "tpl-debug".into(),
            name: "Debug".into(),
            kind: "run".into(),
            program: None,
            cwd: None,
            flutter_mode: Some("debug".into()),
            args: vec![],
            env: HashMap::new(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("template".into()),
        },
        Command {
            id: "tpl-build-apk".into(),
            name: "Build APK".into(),
            kind: "build".into(),
            program: None,
            cwd: None,
            flutter_mode: None,
            args: vec![],
            env: HashMap::new(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: Some("apk".into()),
            source: Some("template".into()),
        },
        Command {
            id: "tpl-build-windows".into(),
            name: "Build Windows".into(),
            kind: "build".into(),
            program: None,
            cwd: None,
            flutter_mode: None,
            args: vec![],
            env: HashMap::new(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: Some("windows".into()),
            source: Some("template".into()),
        },
        Command {
            id: "tpl-build-web".into(),
            name: "Build Web".into(),
            kind: "build".into(),
            program: None,
            cwd: None,
            flutter_mode: None,
            args: vec![],
            env: HashMap::new(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: Some("web".into()),
            source: Some("template".into()),
        },
    ]
}

/// 由模板实例化出属于某个项目的命令（换新 id，标记来源）
pub fn instantiate_template(tpl: &Command, project_id: &str) -> Command {
    let mut c = tpl.clone();
    c.id = make_id("cmd", &format!("{}|{}|{}", project_id, tpl.name, tpl.kind));
    c.source = Some("template".into());
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
