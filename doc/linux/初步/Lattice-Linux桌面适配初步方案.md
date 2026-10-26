# Lattice Linux 桌面适配初步方案

> 日期：2026-10-26 · 分支：`phase/p1-rust-ai` · 状态：初步提案（待评审）
> 范围：在 Linux 上开发、运行、打包、分发 Lattice 桌面端（Tauri 2）
> 关联：`doc/AI/地基/Lattice-AI地基架构方案.md`、`doc/AI/初步/权限/权限说明书.md`

**一句话：** 应用层已经跨平台（Tauri 2 + Web 前端 + Rust 后端），Linux 的主要工作不是"移植重写"，而是补齐三件平台事实——**系统依赖与打包基线、系统密钥服务、更新资产识别**；其余是 WebKitGTK 环境下必须逐项验收的运行时差异。

---

## 1. 目标与边界

| 级别 | 目标 | 判定标准 |
| --- | --- | --- |
| G0 | Linux 上能开发 | `npm run dev:desktop` 打开窗口；前端 HMR、Rust 增量重启正常 |
| G0 | Linux 上能跑测试 | `cargo test --release`、`npm run verify` 全绿 |
| G0 | 产出可安装包 | 生成 `.deb` 与 `.AppImage`，在目标发行版上安装、启动、完成核心闭环 |
| G1 | 功能与 Windows 等价 | 密钥持久化、更新检查、剪贴板、文件对话框、外部文件监听、中文输入可用 |
| G1 | CI 持续覆盖 | Linux 构建产物归档；Rust 测试与 clippy 在 Linux runner 跑通 |
| G2 | 可长期维护 | 明确最低发行版/glibc 基线、测试矩阵、已知问题与规避参数 |

**本期不做：** Flatpak / Snap 封装、ARM64 构建、托盘常驻、应用内自动安装更新、自定义无边框标题栏。这些都不阻塞前三个 G0。

---

## 2. 现状盘点（实测）

### 2.1 本机环境

| 项 | 实测值 | 结论 |
| --- | --- | --- |
| 发行版 | Ubuntu 26.10 | 仅适合开发，不建议作为对外分发的构建机 |
| Node / npm | 24.19.0 / 11.16.0 | 满足根 `package.json` 的 `>=22.5.0` |
| Rust / Cargo | 1.99.1 | 满足 `src-tauri/Cargo.toml` 的 `rust-version = "1.90"` |
| tauri-cli | 2.12.2 | 与 `Cargo.toml` 的 tauri 2.12.3 同代 |
| WebKitGTK 开发库 | **缺失** | `pkg-config webkit2gtk-4.1` / `gtk+-3.0` / `libsoup-3.0` 均找不到 |
| 依赖产物 | 已有 Linux 版 esbuild / rollup / tauri-cli 二进制 | 前端构建与 `tauri` 命令本身可用 |

**结论：** 当前 `npm run dev:desktop` 会卡在 Rust 链接阶段，先装系统依赖即可，无需改动代码。

### 2.2 已有基础（不需要从零做）

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 跨平台运行时 | Tauri 2 + 条件编译仅限 Windows 子系统属性 | `src-tauri/src/main.rs:2` |
| Linux 构建 | CI 已在 `ubuntu-22.04` 上构建桌面包 | `.github/workflows/upgrade-gate.yml:68` |
| Linux 依赖清单 | CI 已装 `libwebkit2gtk-4.1-dev` 等 | `.github/workflows/upgrade-gate.yml:81` |
| 路径安全 | 统一 `PathBuf`、符号链接拒绝、根目录逃逸检查 | `src-tauri/src/vault.rs:74-122`、`workspace.rs:4101` |
| 原子写 | `NamedTempFile` + `sync_all` + rename | `src-tauri/src/vault.rs:203`、`366` |
| 文件监听 | `notify` 8（Linux 下为 inotify） | `src-tauri/src/watcher.rs:6` |
| 文件对话框 | `tauri-plugin-dialog`（Linux 下 GTK3 原生对话框） | `src-tauri/src/lib.rs:91` |
| 剪贴板 | wry 在 WebKitGTK 下注册自定义协议为安全源并开启剪贴板访问 | `wry` 0.57.0 `webkitgtk/mod.rs:438` |

### 2.3 Linux 差异清单

按处理优先级排序；"证据"均指当前代码位置。

| # | 差异 | 级别 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 系统开发库未安装（本机） | P0 | `pkg-config` 实测 | 无法编译/运行 |
| D2 | Linux 密钥存储回退 mock，读取恒空 | P0 | `src-tauri/Cargo.toml:47`、`ai/core/config/secrets.rs:110-125` | AI API Key 无法持久化；重启后需重新输入 |
| D3 | 分发基线未定义：本机 glibc 较新 | P0 | 本机 Ubuntu 26.10 | 在本机打的包无法在 22.04/24.04 运行 |
| D4 | 更新检查只识别 `.exe` 资产 | P1 | `src-tauri/src/update.rs:95` | Linux 端 `installer`/`portable` 恒为空，只能回落到 Releases 网页 |
| D5 | CSP `connect-src 'self'` 未放行 IPC 自定义协议 | P1 | `src-tauri/tauri.conf.json:25` | Linux 下 `ipc://` 请求被 CSP 拦，回退 `postMessage`，控制台出现回退警告 |
| D6 | 原子写临时文件默认 0600，覆盖后权限被改 | P1 | `vault.rs:203`、`366`；`workspace.rs:188` | 笔记/画布覆盖后变为仅本人可读，影响外部工具、备份与同步 |
| D7 | `.lattice` 内部目录默认 0755 | P1 | `vault.rs:201`、`workspace.rs:561`；**M0 已复现** | 同机其他用户可读索引库 `lattice.db`、历史快照、审计 `audit.jsonl`、`mcp.json` |
| D8 | WebKitGTK 渲染与输入差异 | P1 | 无法静态确认 | BlockSuite 编辑、Mermaid/KaTeX、输入法、拖放、剪贴板需真机验收 |
| D9 | Windows 专用的"仅改大小写"重命名豁免 | P2 | `workspace.rs:2137-2141`、`4088-4094` | Linux 大小写敏感，行为本身正确，但需产品确认"是否允许仅大小写不同的同名文件" |
| D10 | inotify 限制与网络盘 | P2 | `watcher.rs` | 超大 Vault 触发 `max_user_watches`；NFS/SMB 上 inotify 不生效 |
| D11 | "在文件管理器中显示"依赖未注入的桌面桥 | P2 | `web/src/settings/SettingsModal.tsx:363`，全仓库无 `window.latticeDesktop` 注入 | 该入口在 Tauri 下不可用（非 Linux 独有，但 Linux 用户预期更强） |
| D12 | CI 无 Linux 运行时冒烟 | P1 | `.github/workflows/upgrade-gate.yml:41`（`rust-test` 仅 Windows） | 编译通过不等于能启动，回归不可见 |

---

## 3. 方案设计

### 3.1 环境基线

系统依赖（本机安装，sudo 由用户执行）：

```bash
sudo apt update
sudo apt install -y build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  librsvg2-dev patchelf file
# 仅在引入托盘功能时需要：
# sudo apt install -y libayatana-appindicator3-dev
# 中文界面字体（多数桌面发行版已自带，最小安装需显式装）：
# sudo apt install -y fonts-noto-cjk
```

验证：

```bash
pkg-config --modversion webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 javascriptcoregtk-4.1
```

说明：
- **不需要 `libssl-dev`**：锁文件中的 TLS 后端是 `rustls`（`hyper-rustls`/`rustls`），M0 用 `ldd` 实测发布二进制不链接 `libssl`/`libcrypto`。
- `patchelf`、`file` 只服务 AppImage 打包。
- `libdbus-1-3` 是桌面发行版默认自带，密钥方案（§3.3）运行期依赖它。

### 3.2 开发循环

```bash
cd /home/bot/项目/other/item/init/lattice/Lattice
npm run dev:desktop                                  # tauri dev
LATTICE_VAULT_DIR=/tmp/lattice-dev npm run dev:desktop   # 隔离测试库
npm run dev:web                                      # 只调前端（无 Rust 能力）
```

- 前端改 `web/src/` 走 HMR；Rust 改 `src-tauri/src/` 自动重编译重启。
- 调试构建自带 WebKit 检查器：窗口内右键 → Inspect Element。
- 数据目录：`~/.local/share/app.lattice.desktop/vault`；配置：`~/.config/app.lattice.desktop/`；两者都可用 `LATTICE_VAULT_DIR` 覆盖 vault 根（`src-tauri/src/lib.rs:70`）。
- 日志：调试构建启用 `tauri-plugin-log`（`lib.rs:95-100`）；发布构建目前无文件日志，Linux 排障先用终端启动二进制观察 stderr。

### 3.3 密钥服务（D2，P0）

Linux 没有凭据管理器/钥匙串的等价物，`keyring` 必须在构建期选择后端，否则默认落到 mock（[keyring README](https://github.com/hwchen/keyring-rs) 明确说明"未启用平台后端即为 mock"）。

**推荐配置**（与 keyring 3.6.3 docs.rs 元数据一致）：

```toml
keyring = { version = "3", features = [
  "windows-native",
  "apple-native",
  "linux-native-sync-persistent",
  "crypto-rust",
] }
```

- `linux-native-sync-persistent` = keyutils（内核缓存）+ Secret Service（持久化，GNOME Keyring / KWallet）。
- 最小改法也可用 `sync-secret-service`（上游 README 示例）；`crypto-rust` 用纯 Rust 加密，避免额外的 OpenSSL 依赖链。
- 运行期需要 D-Bus 会话与 Secret Service 守护进程。**不是所有 Linux 桌面都有**（i3/Sway 最小环境常见缺失）。
- 读取是同步 D-Bus 调用，通常几十到几百毫秒：确认调用发生在 AI worker 线程而非 UI 主线程。

**降级与可见性：**
- 现有环境变量覆盖仍然有效：`LATTICE_PROVIDER__<ID>__API_KEY`（`ai/core/config/secrets.rs:53`），无 Secret Service 时作为唯一持久方案。
- 当前所有 keyring 错误都按"密钥不存在"静默处理（`secrets.rs:110-125`）。Linux 上要补一条**一次性可见提示**：保存密钥成功但无法持久化时，明确告知"重启后需重新输入，或改用环境变量"，避免用户误以为已保存。

**测试：**
- 纯函数测试照旧跨平台跑。
- 真实 Secret Service 读写测试加环境开关（CI 无 keyring 守护进程，默认跳过），并保留现有 Windows 条件编译测试（`secrets.rs:213`）。

### 3.4 更新检查（D4，P1）

当前只收集 `.exe`（`update.rs:95`），Linux 端实际没有可下载资产。

改法：
1. 把资产过滤改为"目标平台 + 扩展名"：Windows `.exe/.msi`；Linux `.deb/.AppImage/.rpm`；macOS `.dmg`。
2. 安装包优先级：Windows `setup` > 其他；Linux `deb` > `AppImage` > `rpm`。
3. `portable` 概念是 Windows 专有；Linux 可将 AppImage 映射为 portable。
4. 平台判断不要写死在 `cfg!` 里，改为函数参数，便于在任意平台单测三套过滤规则。
5. 维持现有 GitHub 域名校验（`update.rs:76-85`）与版本比较逻辑不变。

### 3.5 CSP 与 IPC（D5，P1）

Linux/macOS 的 IPC 走自定义协议 `ipc://localhost`，Tauri 官方配置示例要求 CSP 放行：

```json
"connect-src": "'self' ipc: http://ipc.localhost"
```

当前为 `connect-src 'self'`（`tauri.conf.json:25`）。不改也能工作——`ipc-protocol.js` 会在 fetch 失败后回退 `window.ipc.postMessage`——但会多一条控制台警告和多一次失败请求。M0 启动时先看控制台是否出现 `IPC custom protocol failed`，出现即按上述补充。

### 3.6 文件权限与内部目录（D6/D7，P1）

Linux 默认权限语义与 Windows ACL 不同，需显式处理：

| 对象 | 现状 | 建议 |
| --- | --- | --- |
| 笔记/画布（覆盖写） | `NamedTempFile` 0600，rename 后保持 0600 | 覆盖前读取原文件 mode，写临时文件后 `set_permissions` 还原；新建文件用 0644（受 umask 约束） |
| `.lattice/` 内部目录 | 0755 | 创建时 0700 |
| `lattice.db`、`history/`、`audit.jsonl`、`mcp.json` | 受 umask 影响 | 最小化：放在 0700 目录下；必要时文件 0600 |
| 锁文件 `workspace.lock` | 默认 | 保持 0600 即可 |

实现位置：`vault.rs` 的 `write`/`write_asset`、`workspace.rs` 的原子写与 `WorkspaceService::open` 的 `.lattice` 创建。仅 `#[cfg(unix)]` 生效，Windows 分支不变。

### 3.7 桌面集成验收项

| 能力 | 现状/风险 | 验收方式 |
| --- | --- | --- |
| 中文输入法 | BlockSuite contenteditable 依赖 WebKitGTK 合成事件 | fcitx5 与 ibus 各测：正文、搜索框、重命名、AI 输入框 |
| 剪贴板 | wry 已开启且自定义协议注册为安全源 | 复制笔记路径、AI 消息、代码块；Wayland 与 X11 各测 |
| 文件对话框 | GTK3 原生；Wayland 下可能由 xdg-desktop-portal 接管 | 打开/切换 Vault、上传附件、导出 |
| 拖放 | Tauri 默认开启，WebKitGTK 实现不同 | 从文件管理器拖图片/Markdown 进编辑器与附件区 |
| 字体 | 字体栈含 "Source Han Sans SC"/Noto，缺字体时回退 | 最小安装（无 `fonts-noto-cjk`）检查是否有豆腐块 |
| 文件管理器定位 | 桌面桥未注入（D11） | 实现 Rust 命令：目录用 `xdg-open`，文件用 `org.freedesktop.FileManager1.ShowItems` |
| 窗口/任务栏图标 | WebKitGTK 窗口的 WM_CLASS 可能与 .desktop 不匹配 | GNOME/KDE 检查是否出现双图标 |
| GPU/渲染 | NVIDIA + Wayland 下 WebKitGTK DMABUF 可能黑屏/闪烁 | 先在 Intel/AMD Mesa 与 NVIDIA 专有驱动各跑一轮；异常时以 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 验证是否 DMABUF 问题 |
| 缩放 | HiDPI 下 125%/150% | 检查编辑器光标、弹层定位、图表清晰度 |

### 3.8 打包与分发

**产物与定位：**

| 格式 | 定位 | 注意 |
| --- | --- | --- |
| `.deb` | 首选 | 自动声明 `libwebkit2gtk-4.1-0` 等依赖；建议加 `Recommends: fonts-noto-cjk` |
| `.AppImage` | 次选/免安装 | 实测会打包宿主 WebKitGTK 等库（105 MiB），不再依赖宿主 `libwebkit2gtk-4.1`；构建需联网下载 linuxdeploy；运行需 FUSE（无 FUSE 可 `--appimage-extract-and-run`） |
| `.rpm` | 可选 | Tauri 自带打包，覆盖 Fedora/openSUSE |

**glibc 基线（D3）：**
- 对外分发包统一在 **Ubuntu 22.04** runner 构建（glibc 2.35），可覆盖 22.04/24.04/26.04 与 Debian 13。
- 本机 26.10 只用于开发与本地验证，不产出对外包。
- 若将来 22.04 runner 退场，迁移到 24.04 前需确认最低用户基线。

**构建命令：**

```bash
npx tauri build --bundles deb          # 只打 deb，最稳
npx tauri build --bundles appimage     # 需要网络下载打包工具
npm run build:desktop                  # targets=all：deb + rpm + AppImage
```

产物目录：`src-tauri/target/release/bundle/{deb,rpm,appimage}/`。

**发布资产命名**（供 §3.4 更新检查识别）：`Lattice_<version>_amd64.deb`、`Lattice_<version>_amd64.AppImage`、`Lattice-<version>-1.x86_64.rpm`。本地实测产物与命名一致（见 §10）。

**本机打包注意（Ubuntu 26.10）：**
- AppImage 构建前需把 GNU `cp` 放到 PATH 前面，绕开 uutils coreutils 的 `--parents` bug（D21）：
  ```bash
  mkdir -p /tmp/lattice-shim
  printf '#!/bin/sh\nexec /usr/bin/gnucp "$@"\n' > /tmp/lattice-shim/cp && chmod +x /tmp/lattice-shim/cp
  PATH=/tmp/lattice-shim:$PATH NODE_OPTIONS=--max-old-space-size=3072 npx tauri build --bundles appimage
  ```
- AppImage 打包需联网下载 AppRun/linuxdeploy/appimagetool runtime，失败可直接重试（D22）。

### 3.9 CI 与测试矩阵

**CI 改动（最小闭环）：**
1. 新增 `rust-test-linux` job（`ubuntu-22.04`）：装依赖 → `cargo test --release` → `cargo clippy -- -D warnings`。
2. `desktop-build` 增加产物上传（`.deb`、`.AppImage`），供人工下载验收。
3. 可选冒烟：`xvfb-run -a ./src-tauri/target/release/lattice`，10 秒后检查进程存活与日志无 panic。WebKitGTK 在 Xvfb 下可启动，但 GPU 能力受限，仅作"能起窗口"的最低保障。
4. `web-test`、`typecheck` 已在 Linux runner，无需改。

**人工测试矩阵：**

| 维度 | 取值 |
| --- | --- |
| 发行版 | Ubuntu 24.04 LTS、Ubuntu 26.04 LTS、Debian 13、Fedora 44 |
| 会话 | Wayland、X11 |
| GPU | Intel/AMD Mesa、NVIDIA 专有驱动 |
| 输入法 | fcitx5、ibus |
| 缩放 | 100%、150% |
| 数据规模 | 1 万篇笔记 + 1000 附件；文件名含空格/CJK/emoji |
| 异常 | Vault 只读、磁盘满、同机第二个实例、符号链接逃逸 |

---

## 4. 分阶段计划

| 阶段 | 工作项 | 产出/验收 | 预估 |
| --- | --- | --- | --- |
| M0 跑通 | 装系统依赖；`dev:desktop` 起窗口；`cargo test --release`；打 `.deb` 并安装启动 | 创建/编辑/搜索笔记、外部改文件触发刷新、AI 请求（env Key）通过；控制台无 CSP/IPC 警告 | 0.5–1 天 |
| M1 功能补齐 | D2 密钥后端 + 降级提示；D5 CSP；D4 更新资产；D6/D7 权限；D8 验收并记录问题 | Linux 功能对照表全过；密钥重启后仍可用；更新页能给出 `.deb`/AppImage 链接 | 2–3 天 |
| M2 打包分发 | deb 元数据（Recommends/分类）；AppImage 构建；CI 产物归档；发布命名规范 | 全新 24.04 虚拟机安装 `.deb` 可用；AppImage 在 24.04 可运行；22.04 构建产物在 26.04 可运行 | 1–2 天（元数据与 AppImage 已完成，见 §10；跨发行版验收待人工） |
| M3 长期化 | Linux rust-test/clippy 门禁；发布日志；发行版矩阵回归；已知问题文档化 | CI 全绿；每版发布前按 §3.9 矩阵抽测 | 持续 |

**依赖关系：** M1 的 D2 需要先定后端选型（见 §6 Q1）；M2 依赖 M0 的本地打包成功；M3 依赖 M1/M2 稳定。

---

## 5. 验收清单（M1 结束时逐项勾选）

> M0 已实际验证的条目（构建、测试、窗口渲染、deb 解包运行）见 §8；其余为 M1/M2 验收项。

- [ ] `npm run dev:desktop` 在 Wayland 与 X11 都能打开窗口
- [ ] `cargo test --release`、`cargo clippy -- -D warnings` 在 Ubuntu 22.04/24.04 通过
- [ ] 新建、编辑、重命名、删除笔记；双链、标签、图谱、搜索正确
- [ ] 外部编辑器修改文件后 1 秒内索引更新（inotify）
- [ ] 附件上传、预览、删除；画布读写
- [ ] AI 设置中保存 Key → 重启应用 → Key 仍在（Secret Service 可用时）
- [ ] 无 Secret Service 环境给出明确提示，env Key 可用
- [ ] 更新检查在 Linux 上返回 `.deb` 或 AppImage 下载地址
- [x] 覆盖写后笔记权限不再变成 0600；`.lattice` 为 0700（M1 单测覆盖）
- [ ] fcitx5 与 ibus 中文输入在编辑器中正常（含候选框定位）
- [ ] 剪贴板、文件对话框、拖放、HiDPI、深色模式正常
- [ ] `.deb` 安装后从应用菜单启动，图标/名称正确（M1 包已安装可启动；中文菜单名待装 M2 包后确认）
- [x] 第二个实例启动被单实例锁拦截（Rust 测试覆盖）
- [ ] 全程无未处理 panic、无 CSP/IPC 回退警告

---

## 6. 风险与待决

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Secret Service 在最小桌面缺失 | Key 无法持久化 | 保留 env 覆盖 + 明确 UI 提示；不把 keyutils 单独作为默认（重启失效，用户更难理解） |
| WebKitGTK 渲染差异阻塞编辑器 | 核心功能不可用 | M0 最早暴露；保留 `WEBKIT_DISABLE_DMABUF_RENDERER=1`、`WEBKIT_DISABLE_COMPOSITING_MODE=1` 两个诊断开关；必要时在文档标注最低 WebKitGTK 版本 |
| 本机 26.10 打的包不可分发 | 用户安装失败 | 对外包只在 22.04 runner 构建 |
| AppImage 构建依赖外网下载 | 构建不稳定 | 默认发 `.deb`；AppImage 放 CI 单独 job，允许失败 |
| inotify 上限/网络盘 | 外部修改不刷新 | 文档写明 Vault 不放网络盘；必要时启动时检测 `max_user_watches` 并提示 |
| 发行版 WebKitGTK 版本差异 | 个别 CSS/JS 行为不同 | 测试矩阵覆盖 LTS；以 22.04 的 WebKitGTK 作为最低版本基线验证 |

**需要拍板的 4 个问题：**

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | 密钥后端选 Secret Service 还是 keyutils？ | Secret Service（持久、符合桌面习惯）+ env 兜底 |
| Q2 | 分发格式优先级？ | `.deb` 一等、AppImage 二等、rpm 可选 |
| Q3 | Linux 支持等级：一等公民（CI 运行时冒烟）还是"能构建"？ | 至少做到 CI 构建 + 发布前人工矩阵抽测；运行时冒烟作为加分项 |
| Q4 | 最低支持发行版？ | Ubuntu 22.04+ / Debian 13+（以 glibc 2.35、WebKitGTK 4.1 为基线） |

---

## 7. 命令速查

```bash
# 环境自检
node -v && rustc --version && npx tauri --version
pkg-config --modversion webkit2gtk-4.1

# 开发
npm run dev:desktop
LATTICE_VAULT_DIR=/tmp/lattice-dev npm run dev:desktop

# 测试
npm run verify
cargo test --release --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# 打包
npx tauri build --bundles deb
npx tauri build --bundles appimage

# 诊断（仅在出现渲染异常时使用）
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run dev:desktop
```

---

## 8. M0 实测记录（2026-10-26）

**环境：** Ubuntu 26.10 · GNOME Wayland（`:0`）· WebKitGTK 2.52.6 · GTK 3.24.52 · libsoup 3.6.6 · Node 24.19.0（Ubuntu 发行版构建）· Rust 1.99.1 · tauri-cli 2.12.2。

### 8.1 执行结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| Rust 编译检查 | `cargo check` | 通过，41.24s，2 条告警 |
| 桌面开发模式 | `npm run dev:desktop` | 构建 48.15s，`target/debug/lattice` 启动；AT-SPI 确认窗口 `frame \| 格物 Lattice` 与已加载文档页 |
| 默认数据初始化 | 无 | `~/.local/share/app.lattice.desktop/vault/.lattice/` 生成 `lattice.db`、`audit.jsonl`、`workspace.lock` |
| 前端类型检查 | `npm --prefix web run typecheck` | 通过 |
| 前端测试 | `npm --prefix web run test` | 60 个测试文件全部通过（需 `tsx` 加载器，见 D13） |
| Rust 测试 | `cargo test --release` | **171 passed / 0 failed**（0.58s 执行） |
| 前端生产构建 | `npm --prefix web run build` | 通过，31.71s，`web/dist` 79MB（含 sourcemap） |
| deb 打包 | `npx tauri build --bundles deb` | 通过，release 编译 58.42s，产物 23.90MiB |
| 发布二进制运行 | 解包后直接执行 `usr/bin/lattice` | 窗口正常渲染，AT-SPI 确认同上 |

产物：

- `src-tauri/target/release/bundle/deb/Lattice_0.2.0_amd64.deb`（23.90MiB）
- `src-tauri/target/release/lattice`（41MB，内嵌前端资源）
- deb 控制信息：`Depends: libwebkit2gtk-4.1-0, libgtk-3-0`；`Installed-Size: 42147`
- `.desktop`：`Exec=lattice`、`Icon=lattice`、`StartupWMClass=lattice`、`Categories=`（空）

### 8.2 M0 新发现与既有项确认

| # | 发现 | 级别 | 处理 |
| --- | --- | --- | --- |
| D7 已复现 | `.lattice` 目录 `0775`；`lattice.db` `0644`；`audit.jsonl` / `workspace.lock` `0664` | P1 | **M1 已实现**：新建 `.lattice` 0700；`audit.jsonl`/`workspace.lock` 0600（旧文件也修正）；笔记覆盖保留原 mode、新文件 0644 且受 umask 约束；`lattice.db` 由 0700 目录保护 |
| D13 | Ubuntu 发行版 Node 未编译 TS 支持（`node_use_amaro:false`），测试直接加载 `.ts` 报 `ERR_UNKNOWN_FILE_EXTENSION` | 环境 | 本地用 `NODE_OPTIONS='--import tsx'`；CI 用官方 Node 不受影响；写入开发说明 |
| D14 | Vite 生产构建在 Node 默认 2240MB 堆上限 OOM（`sourcemap: true` 加剧） | 构建环境 | `NODE_OPTIONS=--max-old-space-size=3072` 后通过；CI 需确认堆上限 |
| D15 | deb 元数据缺口：`Maintainer: lattice`、`Description` 长描述为 `(none)`、`Categories` 为空、菜单名为英文 `Lattice`、无字体推荐 | P2（M2） | 补 maintainer/homepage/section、中文菜单名、`Recommends: fonts-noto-cjk` |
| D16 | TLS 实际为 rustls，发布二进制不链接 `libssl`/`libcrypto` | 修正 | §3.1 已移除 `libssl-dev` |
| D17 | `LATTICE_VAULT_DIR` 指向的目录必须已存在，否则静默回退默认 Vault（`lib.rs:70-78` 的 `is_dir` 过滤） | P3 | 开发文档写明 `mkdir -p`；可考虑启动日志提示回退 |
| D18 | Linux 独有 2 条告警：`delete_secret` 未使用（仅 Windows 测试用）、`SecretsVault` trait 无外部引用 | P3 | **M1 已清理**；测试构建亦无告警 |
| D19 | GNOME Wayland 下自动化受阻：Shell 截图接口 `AccessDenied`，Portal 截图返回 `code=2`；无法注入键鼠；JS 控制台不可读 | 测试手段 | 交互项改为人工验收；M3 引入 `tauri-driver` + `WebKitWebDriver`；D5 的 CSP 警告暂按静态缺口处理 |
| D20 | deb 仅解包运行验证，未执行系统安装（需 sudo） | 验收缺口 | 用户执行 `sudo apt install ./Lattice_0.2.0_amd64.deb` 后确认菜单/图标 |

### 8.3 M0 结论

- **G0 达成 3/4**：Linux 可开发、可测试、可打包、发布二进制可运行；仅"安装进系统菜单"因权限待用户确认。
- **功能闭环未验收**：新建/搜索/附件/密钥/更新等交互项受 D19 限制，需人工或后续 WebDriver 自动化；Rust 侧 171 项测试已覆盖 Vault、索引、工作区、AI 运行等核心逻辑。
- **M1 优先级不变**：D2 密钥（最高）→ D4 更新资产 → D5 CSP → D6/D7 权限 → D18 告警；D15 并入 M2 打包工作。

### 8.4 下一步

1. 用户安装 deb 并确认菜单名、图标、启动：
   ```bash
   sudo apt install ./src-tauri/target/release/bundle/deb/Lattice_0.2.0_amd64.deb
   ```
2. M1 代码项：keyring Linux feature + 降级提示、更新资产按平台过滤、CSP 放行 `ipc:`、Unix 权限、Linux 告警清理。
3. CI：新增 Linux `cargo test`/clippy job 与 deb/AppImage 产物归档；确认 Node 堆环境。
4. 测试手段：评估 `webkit2gtk-driver` + `tauri-driver`，补 Wayland 下可自动化的 E2E 冒烟。

---

## 9. M1 实施记录（2026-10-26）

**范围：** D2 密钥后端、D4 更新资产、D5 CSP、D6/D7 Unix 权限、D18 告警清理、Linux CI。

### 9.1 改动清单

| 项 | 文件 | 实现 |
| --- | --- | --- |
| D2 密钥后端 | `src-tauri/Cargo.toml` | `keyring` 增加 `linux-native-sync-persistent` + `crypto-rust`，Linux 走 Secret Service（zbus），不引入 OpenSSL |
| D2 密钥回环测试 | `src-tauri/src/ai/core/config/secrets.rs`、`src-tauri/src/ai/runtime/small_model.rs` | 真实密钥服务读写删测试扩到 Linux；无桌面会话时由 `LATTICE_KEYRING_TEST=1` 显式开启，默认跳过 |
| D2 降级提示 | `src-tauri/src/lib.rs`、`secrets.rs`、`web/src/settings/aiSettings.ts`、`ModelCenter.tsx` | 密钥写入失败不再只记日志：命令回执带 `secretStoreWarnings`，模型管理页展示警告并给出 `LATTICE_PROVIDER__<ID>__API_KEY` 兜底方式。密钥写入从服务层移到命令边界，parity 回放不再触碰真实密钥服务 |
| D4 更新资产 | `src-tauri/src/update.rs` | 资产过滤按平台参数化：Windows `.exe/.msi`（setup 优先）、Linux `.deb` > `.AppImage` > `.rpm`（AppImage 同时映射 portable）、macOS `.dmg`；新增 6 项单测 |
| D4 更新文案 | `web/src/lib/update.ts`、`SettingsModal.tsx` | 按钮按资产扩展名显示 `.deb`/AppImage/RPM/Windows/macOS；关于页平台名由 UA 推导，不再写死 Windows |
| D5 CSP | `src-tauri/tauri.conf.json` | `connect-src` 增加 `ipc: http://ipc.localhost`，避免 Linux/macOS 自定义协议预检失败后回退 |
| D6/D7 权限 | 新增 `src-tauri/src/fs_perm.rs`；`vault.rs`、`workspace.rs` | `.lattice` 创建为 0700；审计日志与单实例锁收紧为 0600（已存在的宽松文件一并修正）；原子写覆盖沿用原 mode；新文件 0644 并扣掉进程 umask（Linux 读 `/proc/self/status`，其他 Unix 回落 022） |
| D18 告警 | `secrets.rs`、`config/mod.rs`、`small_model.rs`、`workspace.rs` | 清理 Linux 两条告警与测试残留导入；`cargo check` 零告警 |
| CI | `.github/workflows/upgrade-gate.yml` | 新增 `rust-test-linux`（ubuntu-22.04，`cargo test --release`）；desktop-build 上传 `.deb`/`.AppImage`/`.rpm`；Vite 构建设置 3072MB 堆 |

### 9.2 验证结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Rust 编译 | `cargo check` | 通过，零告警 |
| Rust 测试 | `cargo test --lib` / `cargo test --release --lib` | **184 passed / 0 failed**（debug/release 一致；新增 13 项：密钥警告、更新资产 6 项、权限 4 项等） |
| Secret Service 回环 | `LATTICE_KEYRING_TEST=1 cargo test --lib ...keyring_roundtrip...` | 通过（`org.freedesktop.secrets` 由 `gnome-keyring-d` 提供） |
| 前端类型检查 | `npx tsc --noEmit` | 通过 |
| 前端测试 | `NODE_OPTIONS='--import tsx' npm test` | 60 个测试文件通过（含新增更新文案断言） |
| 开发模式 | `npm run dev:desktop` | 13.10s 构建启动；AT-SPI 确认 `frame \| 格物 Lattice`；日志无 error/warn |
| 发布二进制 | `LATTICE_VAULT_DIR=/tmp/... ./src-tauri/target/release/lattice` | 窗口渲染正常；实测 `.lattice` 0700、`audit.jsonl`/`workspace.lock` 0600、`lattice.db` 0644（位于 0700 目录内） |
| deb 重打包 | `npx tauri build --bundles deb` | 通过，`Lattice_0.2.0_amd64.deb` 24.18MiB（含 M1 改动） |

### 9.3 未完成 / 待验证

| 项 | 原因 | 下一步 |
| --- | --- | --- |
| 密钥保存 → 重启仍可用 | 需在模型管理页实际输入 Key；D19 限制自动化 | 用户人工验收；Rust 回环测试已覆盖 Secret Service 读写 |
| 无 Secret Service 时的界面提示 | 需停掉 `gnome-keyring`，会影响当前桌面会话 | 代码路径已由单测覆盖（非法 id → `INVALID_PROVIDER_ID`），界面文案待人工断网/停服务验收 |
| 更新页返回 Linux 资产 | GitHub Release 尚无 `.deb`/AppImage 资产 | 资产选择单测已覆盖；发布首个 Linux 包后验收 |
| Linux CI 实跑 | 工作流已改，尚未推送触发 | 推送后确认 `rust-test-linux` 与产物上传 |
| Linux clippy 门禁 | 本机 clippy 1.99 对既有代码报 22 条历史 lint（`collapsible_if` 等），非本次改动 | 单独清理后再加 Linux clippy；当前 clippy 仅由 Windows job 承担 |
| `.lattice` 已存在目录权限 | 创建时 0700，已存在的 0775 不会被追溯修改 | 如需收紧，用户可 `chmod 700`；后续可加一次性迁移提示 |

---

## 10. M2 实施记录（2026-10-26）

**范围：** D15 deb 元数据、自定义桌面项（中文菜单名）、AppImage 构建、CI 产物路径复核、发布命名确认。

### 10.1 改动清单

| 项 | 文件 | 实现 |
| --- | --- | --- |
| deb 元数据 | `src-tauri/tauri.conf.json` | `publisher=Dawei-star`（落到 `Maintainer`）、`homepage`、`license=MulanPSL-2.0`、`category=Productivity`、`shortDescription`/`longDescription`；`linux.deb.section=editors`、`priority=optional`、`recommends=[fonts-noto-cjk]` |
| 桌面项中文名 | `src-tauri/linux/lattice.desktop.hbs`（新增） | 自定义模板：`Name[zh_CN]=格物 Lattice`、`GenericName[zh_CN]=知识工作台`、`Comment[zh_CN]=本地优先的知识工作台`，保留 `StartupWMClass`/`Categories`；deb 与 rpm 共用 |
| AppImage | 构建流程 | 本机 `npx tauri build --bundles appimage` 成功；CI `desktop-build` 已上传 `appimage/*.AppImage` |
| 发布命名 | 实测产物 | `Lattice_0.2.0_amd64.deb`、`Lattice_0.2.0_amd64.AppImage`，与 §3.8 命名及 D4 资产过滤一致 |

### 10.2 验证结果

| 项 | 命令/方式 | 结果 |
| --- | --- | --- |
| deb 控制信息 | `dpkg-deb -I` | `Maintainer: Dawei-star`、`Section: editors`、`Priority: optional`、`Homepage`、`Recommends: fonts-noto-cjk`、中文长描述齐全 |
| 桌面项语法 | `desktop-file-validate` | 通过 |
| 桌面项内容 | 解包 `usr/share/applications/Lattice.desktop` | `Categories=Office;`、`Name[zh_CN]=格物 Lattice`、`Exec=lattice`、`StartupWMClass=lattice` |
| 依赖可满足 | `apt-get -s install ./Lattice_0.2.0_amd64.deb` | 模拟升级通过（本机已装 M1 版同版本包） |
| AppImage 构建 | `npx tauri build --bundles appimage`（PATH 前置 GNU cp） | 通过，105.49 MiB |
| AppImage 桌面项 | `--appimage-extract` 后查看 `Lattice.desktop` | 中文 `Name`/`GenericName`/`Comment` 与 deb 一致 |
| AppImage 运行 | `LATTICE_VAULT_DIR=/tmp/lattice-appimage-test ./Lattice_0.2.0_amd64.AppImage` + gjs AT-SPI | 进程持续存活；`application \| lattice` → `frame \| 格物 Lattice` → 文档页；仅一条 `GStreamer element appsink not found` 告警，不影响启动 |

### 10.3 新发现

| # | 发现 | 级别 | 处理 |
| --- | --- | --- | --- |
| D21 | 本机 Ubuntu 26.10 的 `cp` 是 uutils coreutils 0.12.0，`cp --archive --parents` 误判同文件，linuxdeploy GTK 插件复制 gschemas 时中断（`failed to run linuxdeploy`） | 构建环境 | 构建时 PATH 前置 `gnucp` 包装脚本（§3.8）；22.04/24.04 runner 使用 GNU coreutils，不受影响 |
| D22 | AppImage 构建需联网下载 AppRun/linuxdeploy/appimagetool runtime，首次两次因网络中断失败（`peer closed connection`、`status code 0`），重试成功 | 构建环境 | 沿用 §6 风险处理：AppImage 放 CI 单独步骤，允许失败后重跑 |
| D23 | AppImage 实际打包了宿主 WebKitGTK 等库（105 MiB），并非"只打包自身、依赖宿主 WebKit" | 认知修正 | §3.8 已修正；对外资产以 22.04 CI 产物为准 |
| D24 | 本机已安装 M1 版 deb（`/usr/bin/lattice` 时间 14:35），菜单项仍为旧元数据（`Name=Lattice`、`Categories=` 空） | 验收状态 | 用户重装 M2 包后确认中文菜单名 |

### 10.4 未完成 / 待验证

| 项 | 原因 | 下一步 |
| --- | --- | --- |
| 全新 24.04 虚拟机安装新 deb | 无虚拟机环境 | 人工验收 |
| 22.04 CI 产物在 26.04 运行 | 需推送触发 CI 产出 | 推送后下载 `lattice-linux-<sha>` 验收 |
| 中文菜单名生效 | 需 sudo 重装 | `sudo apt install ./src-tauri/target/release/bundle/deb/Lattice_0.2.0_amd64.deb` |
| Maintainer 邮箱 | 用户选择先只写名称 | 发布前补 `姓名 <邮箱>`，满足 Debian 政策 |
| Linux CI 实跑 | 工作流已改，尚未推送触发 | 推送后确认 `rust-test-linux`、AppImage 打包与产物上传 |


