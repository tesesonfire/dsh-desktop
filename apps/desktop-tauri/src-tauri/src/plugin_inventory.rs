//! Plugin inventory (read-only): scan a DSH profile's node_modules for
//! packages declaring a `dsh` manifest section with `bundle` (patch) or
//! `client` fields. Display only — the shell never installs or patches here.

use std::fs;
use std::path::Path;

use serde::Serialize;

/// camelCase to match packages/protocol/src/bridge.ts.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_platform: Option<String>,
}

#[derive(serde::Deserialize)]
struct ManifestView {
    name: Option<String>,
    version: Option<String>,
    #[serde(default)]
    dsh: Option<DshView>,
}

#[derive(serde::Deserialize)]
struct DshView {
    #[serde(default)]
    bundle: Option<BundleView>,
    #[serde(default)]
    client: Option<ClientView>,
}

#[derive(serde::Deserialize)]
struct BundleView {
    #[serde(default)]
    patch: Option<String>,
}

#[derive(serde::Deserialize)]
struct ClientView {
    #[serde(default)]
    platform: Option<String>,
}

fn parse_manifest(dir: &Path) -> Option<InstalledPlugin> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let manifest: ManifestView = serde_json::from_str(&text).ok()?;
    let bundle_patch = manifest.dsh.as_ref()?.bundle.as_ref()?.patch.clone();
    let client_platform = manifest.dsh.as_ref()?.client.as_ref()?.platform.clone();
    if bundle_patch.is_none() && client_platform.is_none() {
        return None;
    }
    Some(InstalledPlugin {
        name: manifest.name?,
        version: manifest.version?,
        patch_path: bundle_patch,
        client_platform,
    })
}

fn scan_node_modules(node_modules: &Path, out: &mut Vec<InstalledPlugin>) {
    let Ok(entries) = fs::read_dir(node_modules) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if file_name.starts_with('@') {
            // scoped: node_modules/@scope/<name>
            let Ok(scoped) = fs::read_dir(&path) else { continue };
            for inner in scoped.flatten() {
                if let Some(found) = parse_manifest(&inner.path()) {
                    out.push(found);
                }
            }
            continue;
        }
        if let Some(found) = parse_manifest(&path) {
            out.push(found);
        }
    }
}

/// List DSH plugins installed in `profile_dir` (top-level node_modules only —
/// the surface the user manages).
pub fn list_profile_plugins(profile_dir: &Path) -> Vec<InstalledPlugin> {
    let mut plugins = Vec::new();
    scan_node_modules(&profile_dir.join("node_modules"), &mut plugins);
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, content).expect("write");
    }

    #[test]
    fn finds_bundle_and_client_manifests_including_scoped() {
        let root = std::env::temp_dir().join(format!("dsh-plugins-test-{}", std::process::id()));
        let nm = root.join("node_modules");
        write(
            &nm.join("dsh-desktop-shell").join("package.json"),
            r#"{"name":"dsh-desktop-shell","version":"0.1.0","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}"#,
        );
        write(
            &nm.join("@scope").join("web-client").join("package.json"),
            r#"{"name":"@scope/web-client","version":"1.2.3","dsh":{"client":{"platform":"web"}}}"#,
        );
        write(&nm.join("plain-lib").join("package.json"), r#"{"name":"plain-lib","version":"0.0.1"}"#);

        let plugins = list_profile_plugins(&root);
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name, "@scope/web-client");
        assert_eq!(plugins[0].client_platform.as_deref(), Some("web"));
        assert_eq!(plugins[1].name, "dsh-desktop-shell");
        assert_eq!(plugins[1].patch_path.as_deref(), Some("./cordis.patch.yml"));

        let _ = fs::remove_dir_all(&root);
    }
}
