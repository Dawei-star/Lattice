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

fn parse_release(release: GithubRelease, current: [u64; 3]) -> Option<(UpdateInfo, [u64; 3])> {
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
            lower.ends_with(".exe").then_some(UpdateAsset { name, url })
        })
        .collect();
    let installer = assets
        .iter()
        .find(|asset| asset.name.to_ascii_lowercase().contains("setup"))
        .cloned()
        .or_else(|| assets.first().cloned());
    let portable = assets
        .iter()
        .find(|asset| asset.name.to_ascii_lowercase().contains("portable"))
        .cloned();
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
        .filter_map(|release| parse_release(release, current))
        .max_by(|left, right| left.1.cmp(&right.1))
        .map(|(info, _)| info)
        .ok_or_else(|| "GitHub Releases 中没有可用的版本".to_owned())
}

#[cfg(test)]
mod tests {
    use super::version_parts;

    #[test]
    fn parses_release_versions_with_prefix_and_suffix() {
        assert_eq!(version_parts("v0.2.0"), Some([0, 2, 0]));
        assert_eq!(version_parts("Lattice 1.4.2-beta.1"), Some([1, 4, 2]));
        assert_eq!(version_parts("not-a-version"), None);
    }
}
