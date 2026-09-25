# 格物 Lattice

一个**本地优先**的双链笔记知识库，参照 Obsidian 的核心体验实现，包含完整的后端、前端与数据库。

所有数据都在你自己的机器上，不需要注册、不需要联网。

---

## 文档

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| 本文 | 开发者 / 二次开发 | 架构、技术选型、API、数据模型、测试、构建与打包 |
| [`docs/使用说明书.md`](docs/使用说明书.md) | 最终使用者 | 安装启动、界面导览、日常操作、快捷键、备份迁移、升卸载、故障排查 |

两份文档的定位不同：本文假设你愿意读代码，说明书假设你只想把笔记写好。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| Markdown 编辑 | 编辑 / 分栏 / 预览三种模式，900ms 静默自动保存，滚动同步 |
| 附件与图片 | 图片 / PDF 存进本地附件文件夹（默认数据库同级 `data/attachments`），通过工具栏按钮、粘贴或拖拽插入正文，预览内嵌渲染；独立的「附件」面板列出全部文件、显示被哪篇笔记引用、一键清理未引用的孤儿 |
| 导出静态站点 | 一键把整库预渲染成自包含静态 HTML 站点（首页按目录/标签分组，双链转相对链接、嵌入内联、附件随带），落盘 `data/export` 并可本地预览，整体拷走即可发布 |
| 版本历史 | 每次实质改动前自动快照被覆盖的旧内容（按最小间隔节流、每篇限量保留），编辑区「历史」面板可预览任一版本正文并一键回滚；回滚本身也会先存一条，故可再次撤销 |
| 双向链接 | `[[标题]]`、`[[标题\|别名]]`、`[[标题#小节]]`，自动解析并生成反向链接面板 |
| 嵌入引用 | 独占一行的 `![[标题]]` 会展开为内嵌卡片，支持两级嵌套并检测循环引用 |
| 关系图谱 | Canvas 手写力导向布局，按度数缩放节点，支持拖拽 / 缩放 / 点击跳转 |
| 全文检索 | SQLite FTS5 + trigram 分词，中文可做子串匹配；结果带关键词高亮 |
| 标签 | 正文写 `#标签` 自动归类，支持 `#工程/前端` 嵌套写法 |
| 目录树 | 任意层级嵌套、就地重命名、删除后笔记自动回到「未分类」 |
| 快速切换 | `Ctrl / Cmd + K` 按标题模糊跳转，标题不存在时一键创建 |
| 悬空链接 | 引用尚不存在的笔记时标记为悬空，一键补全 |
| 主题 | 浅色 / 深色双主题，首屏渲染前定主题，无闪烁 |
| PWA 可安装 / 离线 | Web 应用清单 + 手写 Service Worker：可安装为独立窗口应用；外壳与哈希资源缓存优先、笔记数据网络优先并回写，后端不可达时离线仍能打开界面并回看上次读过的内容 |

快捷键：`Ctrl+K` 快速切换 · `Ctrl+N` 新建笔记 · `Ctrl+S` 立即保存 · `Ctrl+E` 切换编辑/预览

---

## 快速开始

```bash
# 1. 安装依赖（后端 + 前端）
npm run setup

# 2. 初始化数据库
npm run db:migrate

# 3. 可选：写入一套互相关联的示例知识库
npm run db:seed

# 4. 开发模式（同时拉起后端 5177 与前端 5173）
npm run dev
```

打开 <http://localhost:5173> 即可使用。

### 生产模式（单进程）

```bash
npm run build     # 构建前端到 web/dist
npm start         # 后端同时托管 API 与前端静态资源
```

访问 <http://127.0.0.1:5177>。这条路径下前端与 API 同源，不涉及任何 CORS。

### 打包成 Windows 桌面应用

`desktop/` 是一个独立的 Electron 包，把后端直接跑在 Electron 主进程里（Electron 44 自带
Node 24，内置 `node:sqlite` 可用），因此不需要给用户装 Node，也不需要额外打包一份 node.exe。
窗口加载的是 `http://127.0.0.1:<临时端口>` —— 仍然是「后端托管前端」的单进程形态。

```bash
cd desktop
npm install
npm run start            # 开发态直接起桌面窗口
npm run dist             # 产出安装包 + 绿色版到 desktop/release/
```

`npm run dist` 会先把 `web/dist` 重新构建一遍，再交给 electron-builder，因此不必手动 build。

| 脚本 | 作用 |
| --- | --- |
| `start` | 开发态直接起桌面窗口（前端产物需已存在于 `web/dist`） |
| `build:web` | 只重建前端产物到 `web/dist` |
| `pack` | 只产出未压缩的免打包目录 `release/win-unpacked/`，用于快速验证 |
| `dist` | 重建前端 + 产出安装包与绿色版 |
| `dist:installer` / `dist:portable` | 只产出其中一种 |

| 产物 | 说明 |
| --- | --- |
| `Lattice-<版本>-setup.exe` | NSIS 安装程序，可选安装目录，带开始菜单与桌面快捷方式 |
| `Lattice-<版本>-portable.exe` | 免安装绿色版，双击即用 |

数据存放位置：

- 安装版：`%APPDATA%\Lattice\data\lattice.db`
- 绿色版：exe 同级的 `LatticeData\data\lattice.db`（拷走整个目录即可带走全部笔记；
  若所在目录不可写，自动回退到 `%APPDATA%`）
- 运行日志：数据目录下的 `logs/lattice.log`（超过 2MB 自动轮转为 `lattice.log.1`）

桌面端有一个可选环境变量 `LATTICE_LOG_LEVEL`（`debug` / `info` / `warn` / `error`，默认 `info`），
排查时用它提升日志详细度。它不属于 `server/.env` 的一部分 —— 桌面端全程不需要配置文件，
所有运行参数都由主进程在启动内嵌后端前注入。

首次启动若数据库不存在，会自动灌入一套互相关联的示例知识库（仅此一次，之后不再干预）。

**卸载不会删除笔记**：`deleteAppDataOnUninstall: false` 刻意保留数据目录，避免手滑卸载
把知识库一起删掉。绿色版直接删目录即可，删之前记得先把 `LatticeData\` 挪走。

> 打包刻意关闭了 asar：后端要保持 ESM 的 `import` 语义，运行时还要读取
> `migrations/*.sql`，以普通文件分发最确定。
>
> **国内环境注意**：`desktop/.npmrc` 固定了 Electron 的 npmmirror 镜像。首次安装时
> Electron 默认从 GitHub 拉二进制，**下载失败却不报错**，只留下一个空的 `dist/` 目录，
> 直到启动时才发现跑不起来。换机器时不要删掉这个文件。

### 配置

复制 `server/.env.example` 为 `server/.env` 后按需修改。所有配置在进程启动时集中校验，
任何非法值都会让进程立即退出，而不是等到某个请求才暴露。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `5177` | API 监听地址 |
| `DB_FILE` | `./data/lattice.db` | SQLite 文件路径 |
| `CORS_ORIGINS` | `http://localhost:5173,...` | 允许的前端来源，生产环境禁止写 `*` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AUTO_MIGRATE` | `true` | 启动时自动应用未执行的迁移 |
| `ATTACHMENTS_DIR` | 数据库同级 `data/attachments` | 附件（图片/PDF）落盘目录；整体拷走数据目录即带走附件 |
| `MAX_UPLOAD_MB` | `15` | 单个附件上传体积上限（base64 传输） |
| `WEB_DIST_DIR` | `../web/dist` | 前端产物目录；桌面端打包后指向解包目录 |
| `EXPORT_DIR` | 数据库同级 `data/export` | 静态站点导出根目录；每次导出在其下建 `site-<时间戳>` 子目录，整体拷走即可发布 |
| `VERSION_INTERVAL_MINUTES` | `5` | 版本快照的最小时间间隔（分钟）；间隔内的连续自动保存被节流，不重复留快照。`0` 表示每次实质改动都存 |
| `VERSION_RETENTION` | `50` | 每篇笔记保留的历史版本条数上限，超出即淘汰最旧的 |

---

## 技术选型与权衡

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 数据库驱动 | Node 内置 `node:sqlite` | 数据库层零原生依赖，免去 Windows 上编译 better-sqlite3 的麻烦 |
| 中文检索 | FTS5 `trigram` 分词器 | 默认的 `unicode61` 会把整串汉字当成一个词，搜「知识」匹配不到「知识管理」；trigram 按 3 字符滑窗建索引，天然支持中文子串匹配 |
| 短词检索 | `LIKE` 兜底 | trigram 需要至少 3 个字符，两字查询（如「笔记」）必须回退；FTS 空结果时也会用 LIKE 复核一遍，避免分词边界漏召回 |
| 图谱渲染 | 原生 Canvas，不用 d3 | 需求只有画点、画线、拖拽、缩放，一个图表库的体积与抽象成本高于收益 |
| Markdown 消毒 | 自研白名单消毒器 | 正文可能来自剪藏网页，直接 `innerHTML` 是一条真实的 XSS 路径。用 DOMParser 解析后按白名单裁剪，省掉一个依赖 |
| 附件上传 | base64 over JSON，不引入 multer | 延续「后端零多余依赖」的调性；附件以 UUID 文件名落盘，只接受位图与 PDF，刻意排除含脚本的 SVG（同源直开即 XSS 路径） |
| 静态站点导出 | 后端用 `marked` 预渲染成自包含 HTML | 导出页需脱离运行时把双链解析成相对 `.html` 链接、块级嵌入内联正文，与前端实时管线是「同源不同用」，故后端独立渲染。`marked` 是纯 JS、与前端同版本，是唯一新增后端运行时依赖。导出页覆写 `html/link/image` 钩子转义裸 HTML、丢弃 `javascript:` 地址，杜绝被发布站点携带可执行内容 |
| 实时协作 | 不实现 | 单机单用户场景没有协作需求，用自动保存 + 本地状态足够，不做过度设计 |
| 认证 | 不实现 | 单机版无需登录。数据表已预留 `user_id` 扩展位，后续升级多用户不必重构表结构 |
| 前端路由 | 不用 react-router | 只有「笔记 / 图谱」两个视图，内部状态即可，少一个依赖 |
| PWA | 手写清单 + Service Worker，不引入 `vite-plugin-pwa` / Workbox | 延续项目「能自己写清楚就不加依赖」的调性。SW 只在生产构建注册（开发期由 Vite 托管，缓存反而碍事），并在 Electron 桌面端跳过——它本就是原生安装、后端随进程常驻，再叠一层缓存只会给热更新添乱。API 走「网络优先 + 回写缓存」，保证在线永远取最新、离线才降级读旧数据 |

---

## 工程结构

```
lattice/
├── server/                          后端（Express 5 + node:sqlite）
│   ├── src/
│   │   ├── config/                  环境变量集中校验，启动即 fail fast
│   │   ├── db/
│   │   │   ├── index.js             连接池、WAL、外键、事务包装器
│   │   │   ├── migrate.js           迁移执行器（校验和漂移检测）
│   │   │   └── seed.js              幂等的示例数据（可编程调用 + CLI 入口）
│   │   ├── migrations/              版本化 SQL 迁移
│   │   ├── lib/                     错误体系、结构化日志、Markdown 语义解析
│   │   ├── middleware/              请求 ID、访问日志、CORS、安全头、校验、错误处理
│   │   ├── modules/                 按功能组织，每个模块四层
│   │   │   └── notes|folders|links|tags|search|graph|meta|health|attachments|versions|export/
│   │   │       ├── *.routes.js      路由 + zod 边界校验
│   │   │       ├── *.controller.js  只做请求/响应转换
│   │   │       ├── *.service.js     业务规则与事务编排
│   │   │       └── *.repository.js  只做 SQL
│   │   ├── app.js                   中间件装配（顺序即安全边界）
│   │   └── index.js                 启动、迁移、优雅停机
│   └── test/                        纯函数单元测试
├── web/                             前端（React 18 + Vite 5）
│   ├── public/theme-init.js         首屏定主题（必须是同源外链，见下方 CSP 说明）
│   ├── public/sw.js                 手写 Service Worker（PWA 离线缓存，见技术选型）
│   ├── public/manifest.webmanifest  PWA 应用清单（名称 / 图标 / standalone / 主题色）
│   └── src/
│       ├── api/                     类型化 HTTP 客户端 + 资源访问层
│       ├── hooks/                   知识库中心状态、防抖、轻提示
│       ├── lib/                     Markdown 管线、HTML 消毒、力导向布局、格式化
│       ├── components/              顶栏 / 侧栏 / 列表 / 编辑区 / 关系面板 / 图谱 / 切换器
│       └── styles.css               设计令牌 + 双主题
├── desktop/                         Windows 桌面壳（Electron 44）
│   ├── src/main.js                  应用生命周期、窗口、菜单、GPU/渲染崩溃自愈
│   ├── src/backend.js               在 Electron 主进程内嵌 Express 并托管前端
│   ├── src/menu.js                  中文应用菜单
│   ├── electron-builder.yml         安装包 / 绿色版打包配置
│   ├── .npmrc                       Electron 二进制走 npmmirror 镜像（勿删）
│   └── build/make-icon.py           图标生成脚本（换成品为 build/icon.ico）
├── docs/使用说明书.md               面向使用者的操作手册
└── scripts/                         零依赖开发启动器、接口冒烟测试
```

### 一个容易踩的坑：CSP 会拦掉自己的内联脚本

生产模式下后端会给 HTML 施加 `script-src 'self'` 的 CSP（`server/src/app.js`），
因此 `index.html` 里**不能**写内联 `<script>` —— 会被静默拦掉。首屏定主题那段逻辑
就必须放在 `web/public/theme-init.js` 这种同源外链文件里，并且不能加 `type="module"`
（module 脚本延迟执行，赶不上首次绘制，反闪烁会失效）。开发模式没有 CSP，看不到这个问题。

### 桌面端的环境适配：两级崩溃自愈

受限环境（虚拟机、远程桌面会话、带主动防御的安全软件）里 Chromium 的**子进程沙箱**
可能无法初始化：GPU 进程反复崩溃，最终以
`FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.`
直接终结整个应用 —— 用户看到的现象就是「双击了，什么都没发生」。
`desktop/src/main.js` 为此做了两级兜底：

1. **GPU 自愈**：同一次启动内 GPU 进程崩溃达 3 次即落下标记文件，下次启动自动追加
   `--disable-gpu-sandbox`。只作用于 GPU 进程，主进程与内嵌后端不受影响；
   驱动正常的机器永远不会触发。
2. **渲染崩溃提示**：界面进程连续崩溃 3 次后弹窗说明成因并给出日志路径，
   而不是留一片白屏让用户干等。

另外三个只在桌面端成立的约束：

- **窗口底色要跟随主题**：`BrowserWindow` 的 `backgroundColor` 在页面加载完成后按
  `document.documentElement.dataset.theme` 回写，否则深色主题下拖动窗口会闪白边。
- **外链必须外跳**：`will-navigate` / `setWindowOpenHandler` 把非本站 URL 交给系统浏览器，
  防止把应用窗口本身导航走。
- **环境变量必须早于动态 import**：`server/src/config` 在**首次 import 时**读取并冻结
  `process.env`，所以 `DB_FILE` / `WEB_DIST_DIR` / `PORT` 都必须在 `import` 之前设置好，
  顺序错了会静默用上默认值。

### 分层约定

一次「保存笔记」实际上要保证三件事同时成立：笔记本体落库、标签关联与正文一致、出链与正文一致。
三者必须原子完成，因此统一收敛在 `notes.service` 的一个事务里 —— 控制器不碰 SQL，
服务层不依赖 `req` / `res`，仓储层只负责查询。这样业务规则可以被后续的定时任务或脚本直接复用。

链接与标签都是**正文派生数据**，不是独立事实。因此每次保存都按其正文全量重建，
而不是做增量 diff —— 后者引入的一致性风险远高于它的性能收益。

### 错误契约

所有失败响应统一为：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数校验未通过",
    "details": [{ "in": "body", "field": "name", "message": "目录名不能为空" }],
    "requestId": "8f3a..."
  }
}
```

`requestId` 同时写在响应头和日志里，可直接串联排查。
5xx 一律不外泄堆栈与内部细节，只返回通用文案。

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` `/ready` | 存活 / 就绪探针 |
| `GET` | `/api/notes` | 列表，支持 `folderId`（`__none__` 表示未分类）、`tagId`、`sort`、`limit`、`offset` |
| `GET` | `/api/notes/index` | 全量轻量索引（供快速切换与双链解析） |
| `GET` | `/api/notes/:id` | 详情，含标签、出链、反向链接 |
| `POST` | `/api/notes` | 新建，可带客户端 UUID 以保证重试幂等 |
| `PATCH` | `/api/notes/:id` | 局部更新（`title` / `content` / `folderId` / `isPinned`） |
| `DELETE` | `/api/notes/:id` | 删除，幂等 |
| `GET` `POST` `PATCH` `DELETE` | `/api/folders` | 目录树与增删改 |
| `GET` `DELETE` | `/api/tags` | 标签列表（带引用数）与删除 |
| `GET` | `/api/search?q=` | 全文检索，响应 `meta.strategy` 说明用了 `fts` 还是 `like` |
| `GET` | `/api/graph` | 图谱节点、边、悬空引用与统计 |
| `GET` | `/api/meta/overview` | 知识库总览统计 |
| `GET` `POST` | `/api/attachments` | 附件列表（含引用计数与引用者）/ 上传（JSON 携带 base64） |
| `POST` | `/api/attachments/cleanup` | 清理未被任何笔记引用的孤儿附件（逐个删台账行 + 磁盘文件） |
| `DELETE` | `/api/attachments/:id` | 删除附件（移除台账行 + 磁盘文件，幂等） |
| `GET` | `/attachments/<file>` | 取回附件本体（同源静态托管，UUID 文件名可长期强缓存） |
| `POST` | `/api/export/static` | 导出整个知识库为自包含静态站点，落盘并返回预览入口与统计 |
| `GET` | `/export/<run>/…` | 只读托管每次导出的站点，供本地预览（HTML 不缓存） |
| `GET` | `/api/notes/:id/versions` | 某篇笔记的历史版本列表（时间倒序，不含正文，带字数与字符长度） |
| `GET` | `/api/notes/:id/versions/:versionId` | 读取单条历史的完整正文（校验归属，越权返回 404） |
| `POST` | `/api/notes/:id/versions/:versionId/restore` | 恢复该历史为当前内容；先把当前态强制快照，故恢复可再次撤销 |

---

## 数据模型

```
folders ──┬─< folders (parent_id, 自引用)
          └─< notes (folder_id, ON DELETE SET NULL)

notes ──┬─< note_tags >── tags
        ├─< links (source_note_id, ON DELETE CASCADE)
        └─< links (target_note_id, ON DELETE SET NULL → 变回悬空链接)
        └── notes_fts (FTS5 虚拟表，由触发器保持同步)
```

`links.target_note_id` 为 `NULL` 表示**悬空链接**：被 `[[引用]]` 但目标笔记还不存在。
删除被引用的笔记时，指向它的链接会自动退回悬空状态，而不是被整条抹掉 —— 这样引用关系不会凭空消失。

`attachments` 是一张独立台账表（`002_attachments`）：文件本体落在 `ATTACHMENTS_DIR`，表里记 `stored_name`（UUID 文件名）、原始名、MIME、大小。正文用标准 Markdown 图片语法 `![alt](/attachments/<stored_name>)` 引用它。**引用计数不落库**——列表面板在读取时扫描全部笔记正文统计每张图片被谁引用，避免多表漂移。删除笔记不会级联删文件（附件可能被多篇复用）；未被任何笔记引用的孤儿，通过面板「清理未引用」或 `/api/attachments/cleanup` 显式回收。

迁移文件记录 sha256 校验和，历史迁移被改动时会直接报错，强制「只新增、不改写」。

`note_versions`（`003_note_versions`）存的是「被覆盖前的旧状态」快照：`notes` 行始终是最新态，历史另表保存，删除笔记时随外键 `ON DELETE CASCADE` 一并清理。快照由 `notes.service.update` 在写库前于同一事务内触发，并按 `VERSION_INTERVAL_MINUTES` 节流、按 `VERSION_RETENTION` 淘汰最旧的，避免自动保存把历史刷成一片噪声。恢复某版本时先把当前态强制快照（令恢复可撤销），再写回并同步重建标签与双链等派生数据。

---

## 测试

```bash
npm test            # 后端单元测试（Markdown 语义解析，25 项）
npm run test:api    # 接口冒烟测试，需后端已启动（126 项）
npm run test:web    # 前端渲染冒烟测试，需后端已启动（47 项）
npm run verify      # 依次执行以上全部
```

三层测试各自负责不同的事：

1. **单元测试** —— 纯函数的边界行为，跑得最快，覆盖标签 / 双链 / 标题推断的各种边角情况
2. **接口冒烟** —— 用 `fetch` 打真实端点，验证状态码、错误契约、CORS 白名单、写操作幂等性
3. **前端渲染冒烟** —— 把真实的 React 组件树打包后在 jsdom 中挂载，连真实后端，验证
   「渲染 → 取数 → 点击 → 自动保存 → 切视图」这条完整链路，并断言控制台无未处理异常

前端测试会临时创建一篇样例笔记来验证嵌入渲染，**每次运行前先清理上次残留**，跑完自动删除，
因此不会污染你的真实数据。

---

## 已知限制与后续方向

当前实现刻意划定了边界，以下是明确未做的部分：

- **附件删除非级联**：删除笔记不自动删其图片（可能被多篇复用），需在「附件」面板手动删除或一键「清理未引用」；引用计数按正文实时扫描，不落库
- **版本历史是快照而非增量**：只保存被覆盖前的完整正文，按节流与限量保留，不是逐字符 diff，也不记录是谁改的（单机单用户）
- **无实时协作**：单机单用户，未引入 WebSocket / CRDT
- **图谱规模**：力导向是 O(n²)，数百到数千节点流畅；上万节点需要换 Barnes-Hut 近似
- **`node:sqlite` 的稳定性**：它仍被 Node 标记为实验特性（虽已可直接使用）。若追求绝对稳定，
  可换 `better-sqlite3`，接口几乎一一对应，迁移成本很低
- **离线是「越用越有缓存」**：PWA 缓存的是应用外壳与「上次联网读过的」数据，首次联网打开后离线才可读；未缓存过的新接口在离线时会如实触发前端的「连接中断」提示，不做后台写入队列
- **移动端**：窄屏已做响应式降级，并可作为 PWA 安装到桌面 / 主屏；但尚未经过真机触屏的深度适配

本轮规划的四项能力已全部落地：附件管理面板、静态站点导出、笔记版本历史、PWA（离线与可安装）。后续可按需推进：真机触屏深度适配、写入操作的离线队列、可选的多设备同步。
