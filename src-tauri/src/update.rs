use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;

const RELEASES_URL: &str = "https://api.github.com/repos/Dawei-star/Lattice/releases?per_page=20";
const GITHUB_HOST: &str = "github.com";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: Option<String>,
    name: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
    draft: Option<bool>,
    assets: Option<Vec<GithubAsset>>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: Option<String>,
    browser_download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub tag_name: String,
    pub name: String,
    pub html_url: String,
    pub published_at: Option<String>,
    pub installer: Option<UpdateAsset>,
    pub portable: Option<UpdateAsset>,
    pub download_url: String,
    pub is_update_available: bool,
}

fn version_parts(value: &str) -> Option<[u64; 3]> {
    let value = value.trim();
    let start = value.find(|character: char| character.is_ascii_digit())?;
    let mut parts = [0_u64; 3];
    let mut count = 0;
    for component in value[start..].split(['.', '-', '+']) {
        if count == 3 || component.is_empty() {
            break;
        }
        let digits: String = component
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            break;
        }
        parts[count] = digits.parse().ok()?;
        count += 1;
    }
    (count > 0).then_some(parts)
}

fn release_version(release: &GithubRelease) -> Option<[u64; 3]> {
    release
        .tag_name
        .as_deref()
        .and_then(version_parts)
        .or_else(|| release.name.as_deref().and_then(version_parts))
}

fn github_url(value: Option<&str>) -> Option<String> {
    let url = Url::parse(value?).ok()?;
    if url.scheme() != "https" || url.host_str()? != GITHUB_HOST {
        return None;
    }
    Some(url.to_string())
}

/// 目标平台（函数参数化，便于在任意平台单测三套资产规则）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetPlatform {
    Windows,
    Linux,
    Macos,
}

impl TargetPlatform {
    fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

fn is_asset_for(platform: TargetPlatform, lower: &str) -> bool {
    match platform {
        TargetPlatform::Windows => lower.ends_with(".exe") || lower.ends_with(".msi"),
        TargetPlatform::Linux => {
            lower.ends_with(".deb") || lower.ends_with(".appimage") || lower.ends_with(".rpm")
        }
        TargetPlatform::Macos => lower.ends_with(".dmg"),
    }
}

/// 按平台优先级选出 installer / portable。
/// Linux：`.deb` > `.AppImage` > `.rpm`，AppImage 同时映射为 portable（免安装）；
/// Windows：`setup` > 其他 `.exe/.msi`，`portable` 单独识别；
/// macOS：`.dmg` 为 installer，无 portable 概念。
fn select_assets(
    platform: TargetPlatform,
    assets: Vec<UpdateAsset>,
) -> (Option<UpdateAsset>, Option<UpdateAsset>) {
    let by_suffix = |suffix: &str| {
        assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().ends_with(suffix))
            .cloned()
    };
    let installer = match platform {
        TargetPlatform::Windows => assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().contains("setup"))
            .cloned()
            .or_else(|| assets.first().cloned()),
        TargetPlatform::Linux => by_suffix(".deb")
            .or_else(|| by_suffix(".appimage"))
            .or_else(|| by_suffix(".rpm")),
        TargetPlatform::Macos => by_suffix(".dmg"),
    };
    let portable = match platform {
        TargetPlatform::Windows => assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().contains("portable"))
            .cloned(),
        TargetPlatform::Linux => by_suffix(".appimage"),
        TargetPlatform::Macos => None,
    };
    (installer, portable)
}

fn parse_release(
    release: GithubRelease,
    current: [u64; 3],
    platform: TargetPlatform,
) -> Option<(UpdateInfo, [u64; 3])> {
    let version = release_version(&release)?;
    let html_url = github_url(release.html_url.as_deref())?;
    let assets: Vec<UpdateAsset> = release
        .assets
        .unwrap_or_default()
        .into_iter()
        .filter_map(|asset| {
            let name = asset.name.unwrap_or_default();
            let url = github_url(asset.browser_download_url.as_deref())?;
            let lower = name.to_ascii_lowercase();
            is_asset_for(platform, &lower).then_some(UpdateAsset { name, url })
        })
        .collect();
    let (installer, portable) = select_assets(platform, assets);
    let version_string = format!("{}.{}.{}", version[0], version[1], version[2]);
    let tag_name = release
        .tag_name
        .unwrap_or_else(|| format!("v{version_string}"));
    let name = release.name.unwrap_or_else(|| tag_name.clone());
    let download_url = installer
        .as_ref()
        .map(|asset| asset.url.clone())
        .unwrap_or_else(|| html_url.clone());

    Some((
        UpdateInfo {
            version: version_string,
            tag_name,
            name,
            html_url,
            published_at: release.published_at,
            installer,
            portable,
            download_url,
            is_update_available: version.cmp(&current) == Ordering::Greater,
        },
        version,
    ))
}

pub async fn check(current: Option<&str>) -> Result<UpdateInfo, String> {
    let current = current.and_then(version_parts).unwrap_or([0, 0, 0]);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Lattice-Update-Check")
        .build()
        .map_err(|error| format!("无法初始化更新检查：{error}"))?;
    let response = client
        .get(RELEASES_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法连接 GitHub，请稍后重试：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub 返回了 {} 状态", response.status().as_u16()));
    }
    let releases = response
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|error| format!("GitHub 返回了无法解析的数据：{error}"))?;
    releases
        .into_iter()
        .filter(|release| !release.draft.unwrap_or(false))
        .filter_map(|release| parse_release(release, current, TargetPlatform::current()))
        .max_by(|left, right| left.1.cmp(&right.1))
        .map(|(info, _)| info)
        .ok_or_else(|| "GitHub Releases 中没有可用的版本".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        GithubAsset, GithubRelease, TargetPlatform, UpdateAsset, parse_release, version_parts,
    };

    fn release_with_assets(names: &[&str]) -> GithubRelease {
        GithubRelease {
            tag_name: Some("v0.3.0".to_owned()),
            name: Some("Lattice 0.3.0".to_owned()),
            html_url: Some("https://github.com/Dawei-star/Lattice/releases/tag/v0.3.0".to_owned()),
            published_at: None,
            draft: Some(false),
            assets: Some(
                names
                    .iter()
                    .map(|name| GithubAsset {
                        name: Some((*name).to_owned()),
                        browser_download_url: Some(format!(
                            "https://github.com/Dawei-star/Lattice/releases/download/v0.3.0/{name}"
                        )),
                    })
                    .collect(),
            ),
        }
    }

    fn assets_for(
        platform: TargetPlatform,
        names: &[&str],
    ) -> (Option<UpdateAsset>, Option<UpdateAsset>) {
        let (info, _) = parse_release(release_with_assets(names), [0, 2, 0], platform)
            .expect("release 应可解析");
        (info.installer, info.portable)
    }

    #[test]
    fn parses_release_versions_with_prefix_and_suffix() {
        assert_eq!(version_parts("v0.2.0"), Some([0, 2, 0]));
        assert_eq!(version_parts("Lattice 1.4.2-beta.1"), Some([1, 4, 2]));
        assert_eq!(version_parts("not-a-version"), None);
    }

    #[test]
    fn linux_prefers_deb_then_appimage_and_maps_appimage_to_portable() {
        let (installer, portable) = assets_for(
            TargetPlatform::Linux,
            &[
                "Lattice_0.3.0_amd64.AppImage",
                "Lattice-0.3.0-1.x86_64.rpm",
                "Lattice_0.3.0_amd64.deb",
                "Lattice_0.3.0_x64-setup.exe",
            ],
        );
        assert_eq!(
            installer.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_amd64.deb")
        );
        assert_eq!(
            portable.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_amd64.AppImage")
        );
    }

    #[test]
    fn linux_falls_back_to_appimage_then_rpm() {
        let (installer, portable) = assets_for(
            TargetPlatform::Linux,
            &["Lattice-0.3.0-1.x86_64.rpm", "Lattice_0.3.0_amd64.AppImage"],
        );
        assert_eq!(
            installer.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_amd64.AppImage")
        );
        assert_eq!(
            portable.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_amd64.AppImage")
        );

        let (rpm_only, portable) =
            assets_for(TargetPlatform::Linux, &["Lattice-0.3.0-1.x86_64.rpm"]);
        assert_eq!(
            rpm_only.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice-0.3.0-1.x86_64.rpm")
        );
        assert!(portable.is_none(), "rpm 不是免安装包");
    }

    #[test]
    fn linux_ignores_non_linux_assets_and_falls_back_to_release_page() {
        let release = release_with_assets(&["Lattice_0.3.0_x64-setup.exe"]);
        let (info, _) = parse_release(release, [0, 2, 0], TargetPlatform::Linux).unwrap();
        assert!(info.installer.is_none());
        assert!(info.portable.is_none());
        assert_eq!(info.download_url, info.html_url, "无资产时回落到发布页");
        assert!(info.is_update_available);
    }

    #[test]
    fn windows_keeps_setup_and_portable_priority() {
        let (installer, portable) = assets_for(
            TargetPlatform::Windows,
            &[
                "Lattice_0.3.0_x64_en-US.msi",
                "Lattice_0.3.0_portable.exe",
                "Lattice_0.3.0_x64-setup.exe",
            ],
        );
        assert_eq!(
            installer.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_x64-setup.exe")
        );
        assert_eq!(
            portable.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_portable.exe")
        );
    }

    #[test]
    fn macos_uses_dmg_as_installer() {
        let (installer, portable) = assets_for(
            TargetPlatform::Macos,
            &[
                "Lattice_0.3.0_aarch64.dmg",
                "Lattice_0.3.0_aarch64.app.tar.gz",
            ],
        );
        assert_eq!(
            installer.as_ref().map(|asset| asset.name.as_str()),
            Some("Lattice_0.3.0_aarch64.dmg")
        );
        assert!(portable.is_none());
    }
}
