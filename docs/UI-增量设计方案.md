# 格物 Lattice · 界面外壳增量设计方案

> 依据：4 张 Obsidian 1.13.7 界面截图（右键菜单 / Ribbon + 侧栏 / 主区空状态 / 设置弹窗）
> 设计基线：`web/src/styles.css`（现有设计令牌）、`web/src/App.jsx`（现有外壳结构）
> 目标形态：Obsidian 式外壳 = **4 个持久 chrome 区 + 2 个浮层层**

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 缺口性质 | **结构性缺口，不是样式缺口。** 现有 1 个持久区（TopBar）+ 1 个浮层（QuickSwitcher）；目标需要 4 + 2 |
| 拆分方式 | 6 个阶段，每阶段独立可发布、可单独回滚 |
| 高风险点 | 只有 1 个：P3「移除 TopBar」 |
| 数据模型 | 全程不改。仅在 P1 增加 2 个后端能力 |
| 新增依赖 | **0 个。** 菜单、标签页、设置全部自研；不给浮层引入库 |
| 图标 | 现有图标是散落各文件的内联 SVG，先收成注册表再谈新增 |

### 六阶段一览

| 阶段 | 交付 | 对应截图 | 风险 |
| --- | --- | --- | --- |
| P0 | 设计令牌补齐 + 图标注册表 | 全部（不可见） | 无 |
| P1 | Menu 原语 + 右键上下文菜单 | 截图① | 低（纯新增） |
| P2 | Ribbon + 侧栏面板化 | 截图② | 中（双轨期） |
| P3 | Tab 栏 + 空状态 | 截图③ | **高（承诺点）** |
| P4 | 状态栏 + 连接状态降级 | 截图③ | 低 |
| P5 | 设置弹窗 | 截图④ | 中 |

---

## 1. 截图解码：Obsidian 外壳是六层

| 截图 | 区域 | 交互本质 | Lattice 现有对应物 | 缺口 |
| --- | --- | --- | --- | --- |
| ① | 右键上下文菜单 | 浮层 L1：情境操作 | 无 | **全新** |
| ② | Ribbon 图标栏 + 侧栏头部 | 持久 chrome：面板模型 | TopBar 的视图分段 + `Sidebar.jsx` | 需重组 |
| ③ | Tab 栏 / 空状态 / 状态栏 | 持久 chrome：**文档模型** | `NoteListPane` 只有「列表」，没有「已打开」概念 | **需新状态** |
| ④ | 设置弹窗 | 浮层 L2：模态 | 无 | **全新** |

### 关键洞察

真正缺的不是样式，是**空间结构**。现有布局是「一条顶栏 + 三栏」，动作入口全部横排在顶栏上；Obsidian 是「一条 44px 图标竖栏 + 可折叠侧栏 + 主区自带 Tab 栏 + 底部状态栏」，动作入口按**归属**分散到各自的容器头部。

这带来一个直接影响：**不能靠改 CSS 完成，必须先把「容器」建出来，再把动作搬进去。**

### 截图里可直接复用的既有资产

| 已有资产 | 位置 | 复用到 |
| --- | --- | --- |
| `.modal-backdrop` / `.switcher` | `styles.css:1561` / `QuickSwitcher.jsx` | P1 抽成 `ui/Modal.jsx`，P5 直接复用 |
| `.toast` / `toast-host` | `useToast.jsx` | 撤销删除、设置保存反馈 |
| `.tree` / `.tree__caret` | `FolderTree.jsx` | P1 右键菜单挂载点、P2 面板内容 |
| `.kbd` | `styles.css` | P3 空状态快捷键提示、P5 快捷键速查表 |
| `.empty-state` | `styles.css` | P3 主区空状态（截图③ 中心那三行） |
| `.notecard` / `.tag` / `.segmented` | `styles.css` | P2 面板与 P5 设置控件 |
| `overview` 统计数据 | `useVault` | P4 状态栏左端计数 |

---

## 2. 设计系统补齐（P0 的具体内容）

### 2.1 尺寸令牌

```css
/* 外壳 */
--ribbon-w: 44px;
--sidebar-w: 236px;        /* 已有，保留默认值 */
--sidebar-w-min: 180px;
--sidebar-w-max: 420px;
--tabbar-h: 38px;
--statusbar-h: 26px;

/* 控件 */
--control-h: 30px;         /* 统一表单/按钮高度 */
--control-h-sm: 26px;
--menu-item-h: 30px;
--menu-w: 224px;
--toggle-w: 34px;
--toggle-h: 20px;
```

> `--topbar-height: 58px` 在 P3 之后不再被引用，P3 一并删除。

### 2.2 层级令牌（z-index 收口）

现状：`.modal-backdrop { z-index: 50 }`、`.toast-host { z-index: 80 }` —— 两个裸值，新增菜单时无处安放。

```css
--z-sticky: 10;      /* 面板内的粘性头 */
--z-rail: 20;        /* ribbon / tabbar / statusbar */
--z-resize: 30;      /* 分栏拖拽热区 */
--z-popover: 100;    /* 右键菜单、下拉、气泡 */
--z-modal: 200;      /* 设置、快速切换 */
--z-toast: 300;      /* 提示 */
--z-tooltip: 400;    /* 永远最上 */
```

迁移：`50 → var(--z-modal)`，`80 → var(--z-toast)`。

> 菜单必须低于弹窗。否则在设置弹窗里点开一个下拉，会被弹窗自己盖住。

### 2.3 动效令牌

```css
--dur-instant: 0ms;    /* 右键菜单：出现不要动画 */
--dur-fast: 90ms;      /* hover / 按下 */
--dur-base: 160ms;     /* 浮层进出 */
--dur-slow: 240ms;     /* 侧栏展开收起 */
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
```

> 右键菜单首次出现必须 `0ms`。加淡入会让菜单「慢半拍」贴不上鼠标，这是右键菜单体验最关键的一个细节。

### 2.4 焦点与无障碍基线

```css
--focus-ring: 0 0 0 2px var(--bg-panel), 0 0 0 4px var(--accent);
```

- 统一使用 `:focus-visible`，**禁止全局 `outline: none`**。
- 菜单：`role="menu"` / `menuitem` / `separator`；↑↓ 移动、Home/End 跳首尾、→ 进子菜单、← 返回上级、Esc 关闭并把焦点交还给触发元素、字母首字定位。
- 侧栏树：`role="tree"` / `treeitem`，←→ 折叠展开（现有 caret 已有点击逻辑，补键盘）。
- 图标按钮最小 24×24 可点区，Ribbon 用 32×32。
- 尊重 `prefers-reduced-motion: reduce`，把 `--dur-*` 全部降到 0。

### 2.5 表面层级三条规则

1. **chrome 层**（ribbon / sidebar / tabbar / statusbar）用 `--bg-subtle`；
2. **内容层**用 `--bg-panel`，是全窗口最亮、最靠前的持久表面；
3. **浮层**用 `--bg-panel`，配 `--shadow-md`（菜单）/ `--shadow-lg`（弹窗）。

效果：即使完全去掉边框，也能从明度上分清「外壳 / 内容 / 浮层」三层。

### 2.6 图标注册表

现状：内联 `<svg>` 散在 `TopBar.jsx` / `FolderTree.jsx` / `EditorPane.jsx` 等处，同一个「文件夹」图标存在多份路径副本。

新建 `web/src/ui/Icon.jsx`：

```jsx
<Icon name="folder" size={16} />
```

纯路径注册表，无依赖，`currentColor` 着色，内置约 24 个图标（覆盖截图①菜单里的全部：note / folder / canvas / database / copy / move / search / bookmark / path / reveal / rename / trash / chevron-right / settings …）。

---

## 3. 组件清单与规格

### 3.1 浮层原语

| 组件 | 文件 | 规格 |
| --- | --- | --- |
| `Menu` | `ui/Menu.jsx` | 宽 224（min 200 / max 320）；item 高 30、左右 padding 10；图标 16 + 间距 10；分隔线上下外边距 6px（对应截图① 的分组节奏）；圆角 `--radius`；阴影 `--shadow-md` |
| `MenuItem` danger 变体 | 同上 | 文字 `--danger`，hover 背景 `--danger-soft`（截图① 的「删除」） |
| `ContextMenu` | `ui/ContextMenu.jsx` | 同一时刻只存在一个；`contextmenu` 事件 + `preventDefault`；视口碰撞自动翻转；贴边时 `max-height` + 内部滚动；主菜单与子菜单间隔 2px（防鼠标穿越死区导致关闭） |
| `Modal` | `ui/Modal.jsx` | 从 `QuickSwitcher.jsx` 抽出；复用现有 `.modal-backdrop`；补 focus trap、Esc 关闭、点遮罩关闭、`aria-modal="true"` |
| `Switch` / `Select` | `ui/` | 为 P5 准备的受控控件；Switch 34×20 |

#### 截图① 菜单项 → Lattice v1 逐条对照（**能力驱动，不列空功能**）

| Obsidian 项 | Lattice v1 | 依赖 |
| --- | --- | --- |
| 新建笔记 | ✅ 新建笔记 | 现有 `createNote` |
| 新建文件夹 | ✅ 新建文件夹 | 现有 `createFolder` |
| 新建白板 | ❌ 不列 | 无此概念 |
| 新建数据库 | ❌ 不列 | 无此概念 |
| 创建副本 | ✅ 创建副本 | **需后端新增 `duplicate`** |
| 将文件夹移动到… | ✅ 移动到… | 复用 `moveNote`，补目录子菜单 |
| 在文件夹中查找 | ✅ 在此目录中搜索 | 复用 `filter` + `query` |
| 收藏 | ✅ 收藏 / 取消收藏 | 复用 `togglePin` |
| 复制路径 | ✅ 复制路径 / 复制双链 | **需后端返回路径** |
| 在系统资源管理器中显示 | ⚠️ 仅桌面端 | **需给桌面壳补 preload IPC 桥** |
| 重命名 | ✅ 重命名 | 复用现有 |
| 删除 | ✅ 删除（danger） | 见 §5 决策点 1 |

> **跨层发现**：`desktop/src/` 目前**没有 preload、没有任何 `ipcMain` 注册**（只有 `menu.js` 的应用菜单模板）。所以「在系统资源管理器中显示」不是加一行代码，而是要给桌面端补一层 `contextBridge` 通信 —— 这是 P1 唯一的跨层依赖，也是唯一会碰 `desktop/` 的改动。

### 3.2 外壳组件

| 组件 | 文件 | 规格要点 |
| --- | --- | --- |
| `Ribbon` | `shell/Ribbon.jsx` | 44px 宽；按钮 32×32、图标 20px；激活态左侧 2px accent 竖条；上半为「面板类」（文件 / 搜索 / 收藏 / 标签 / 图谱），下半为「工具类」（设置、帮助），中间 `flex: 1` 弹性；设置项打开 P5 |
| `PanelHeader` | `shell/PanelHeader.jsx` | 侧栏顶部整条（截图②）：左侧面板切换 icon 组，右侧动作组（新建笔记 / 新建文件夹 / 排序 / 全部折叠 / ⋮） |
| `TabBar` | `shell/TabBar.jsx` | 高 38；tab 宽 100–240、文本溢出省略号；非活动透明、hover `--bg-hover`、活动 `--bg-panel` 且**与内容区连通**（去掉活动 tab 下边框）；关闭按钮 hover 才出现，脏数据时显示实心圆点、hover 变 ×；中键点击关闭；右端 ‹ › 与 ⋮（**⋮ 内容 = 当前笔记操作，复用 P1 的 Menu**） |
| `StatusBar` | `shell/StatusBar.jsx` | 高 26、字号 12、`--bg-subtle`；左端：库名 + 笔记/出链计数（`overview` 现成）；右端：保存态 + 连接态 |
| 主区空状态 | 复用 `.empty-state` | 居中三行文本按钮（截图③）：新建笔记 / 打开笔记 / 关闭标签页，快捷键用现有 `.kbd` |

### 3.3 状态与数据新增

| 名称 | 位置 | 职责 |
| --- | --- | --- |
| `useTabs` | `hooks/useTabs.js` | `openIds[]` / `activeId` / `open` / `close` / `reorder`；关闭脏数据复用现有 `confirmNavigation`；持久化到 localStorage，启动按 id 恢复、失效 id 丢弃 |
| `useLayoutPrefs` | `hooks/useLayoutPrefs.js` | 侧栏宽度、折叠节点集合、Ribbon 可见性 |
| `useSettings` | `hooks/useSettings.js` | 外观 / 编辑器 / 文件与链接，供 P5 使用 |
| `POST /api/notes/:id/duplicate` | `server/` | 复制笔记，含标签与双链的全量重建 |
| `GET /api/notes/:id/path` | 可并入现有 note 响应 | 「复制路径」用 |

> 所有写接口保持既有幂等约定（客户端 UUID / 整体替换 / 幂等 DELETE）—— 这是客户端 5xx 自动重试的前提，不要为新接口破例。

---

## 4. 增量路线图

### P0 — 基础层（不可见）

- **目标**：把 P1~P5 要用的令牌一次性补上，避免后续每阶段都回头改一遍 CSS 变量。
- **交付**：`styles.css` 新增尺寸 / 层级 / 动效 / 焦点令牌；`ui/Icon.jsx`；把现有 `50` / `80` 两个裸 z-index 换成令牌；`TopBar.jsx` / `FolderTree.jsx` 的内联 SVG 迁入注册表。
- **不做**：不动任何布局，不产生视觉差异。
- **验收**：`npm run verify` 全绿；前后截图无 diff。
- **回滚**：直接 revert。

### P1 — 浮层：Menu + 右键菜单（截图①）

- **目标**：交付最像 Obsidian、且**零布局风险**的一块。
- **交付**：`ui/Menu.jsx`、`ui/ContextMenu.jsx`、`ui/Modal.jsx`（从 QuickSwitcher 抽出）；侧栏树 / 笔记列表 / 编辑器的右键菜单；后端 `duplicate` + `path`；桌面端 preload IPC（仅「在资源管理器中显示」一项）。
- **不做**：不动顶栏，不动三栏宽度。
- **验收**：菜单键盘全通路可用；在窗口右下角右键时菜单向左上翻转；Esc 关闭后焦点回到原触发元素；新增 jsdom 用例覆盖「菜单渲染 + 键盘选择 + danger 项」。
- **回滚**：删除三个新文件即可，存量改动只有 Modal 抽取。

### P2 — 面板骨架：Ribbon + 侧栏面板化（截图②）

- **目标**：引入 chrome 列模型。
- **交付**：`shell/Ribbon.jsx`、`shell/PanelHeader.jsx`；侧栏面板模型（文件 / 搜索 / 收藏 / 标签四个面板，内容复用现有 `FolderTree` 与 `TagCloud`，新增搜索面板）；TopBar 瘦身（视图分段与「新建笔记」下移到 Ribbon 与面板头，仅保留检索框 + 主题 + 连接态）。
- **双轨策略**：`App.jsx` 增加 `shell: 'topbar' | 'obsidian'` 开关，默认仍是 `topbar`；两条路径都渲染通过后再切默认值。**`TopBar.jsx` 本阶段不删。**
- **不做**：不做 Tab 栏。
- **验收**：开关拨到任一值界面都完整可用；四个面板来回切换不丢筛选状态。
- **回滚**：开关拨回 `topbar`。

### P3 — 主区：Tab 栏 + 空状态（截图③）★ 承诺点

- **目标**：完成外壳替换。
- **交付**：`hooks/useTabs.js`、`shell/TabBar.jsx`、主区空状态；移除 TopBar 的检索框（检索改为侧栏「搜索」面板为主要入口，Ctrl+Shift+F 弹层为快捷入口，复用 QuickSwitcher 的浮层模式）；删除 `--topbar-height`。
- **风险收敛设计**：多标签意味着「同时打开多篇笔记」，而 `useVault` 目前只有一个 `activeNote`。
  **本方案的收敛做法：`useTabs` 只维护「打开了哪些 id」，正文仍由 EditorPane 单一实例承载** —— 即「多标签 = 快速切换」，而不是「多实例编辑器」。
  好处：P3 完全不用动 `useVault` 的数据流，也不需要处理多份未保存状态。真正的多实例编辑器留到以后单独评估。
- **验收**：新建 / 关闭 / 切换 / 脏数据关闭确认全部正常；重启后标签恢复；`npm run verify` 全绿。
- **回滚**：`TopBar.jsx` 与其样式建议保留到 P4 结束再删，作为 P3 的保险。

### P4 — 状态栏 + 连接状态降级（截图③ 底部）

- **目标**：把散落的全局提示收进 chrome。
- **交付**：`shell/StatusBar.jsx`；`.banner--global` 的整条红横幅降级为状态栏上的琥珀色状态点 + 首次失败弹一次 toast；保存态从编辑器内部状态条上移到状态栏（编辑器内保留精简版）。
- **不做**：不做设置。
- **验收**：手动停掉后端，界面不再出现整条红横幅，状态栏出现琥珀点，后端恢复后自动转好。
- **回滚**：独立文件，直接 revert。

### P5 — 设置弹窗（截图④）

- **目标**：给 P0~P4 引入的所有偏好一个家。
- **交付**：复用 `ui/Modal.jsx`；新增 `ui/Switch.jsx`、`ui/Select.jsx`、`settings/SettingsModal.jsx`；分节导航（关于 / 外观 / 编辑器 / 文件与链接 / 快捷键），左侧搜索框实时过滤设置项。
- **只做已存在能力对应的开关**，不为「像 Obsidian」造空设置：主题、界面字号、内容最大宽度、自动保存间隔、新笔记落点、双链格式、快捷键速查表。
- 「关于」页放版本号 + 更新日志入口；桌面端可后续接 `electron-updater`，本阶段只做静态展示。
- **验收**：所有设置在重启后保持；快捷键速查表与实际快捷键逐条一致（并与 `README.md` 对齐）。
- **回滚**：移除入口按钮即下线。

---

## 5. 需要拍板的 5 个决策点

1. **删除语义**。截图① 里删除是红色危险项，而当前 `deleteNote` 是硬删。
   *建议*：改为「回收站 + toast 撤销」，而不是弹二次确认框 —— 确认框会打断批量整理，撤销更贴近文件管理器的心理模型。代价是后端要加 `deleted_at` 软删字段。
2. **白板 / 数据库**。Obsidian 菜单里有，Lattice 没有。
   *建议*：**不列**。菜单项由能力驱动，列表里出现点不动的功能，比少一项更伤。
3. **设置存哪**。localStorage（简单、离线、换机器就丢）还是后端 settings 表（跟着库走）。
   *建议*：后者。Lattice 是「库」模型，偏好应该跟着库走。
4. **图谱的位置**。Obsidian 把图谱做成一种独立 tab 类型（与笔记并列），Lattice 现在是顶栏分段互斥视图。
   *建议*：P3 引入 tab 后，图谱也变成一个 tab。
5. **窄屏策略**。现有 CSS 有响应式规则，但 `44 + 236 + 主区` 在 900px 以下会挤。
   *建议*：P2 里加「侧栏抽屉化」；否则就明确放弃窄屏，不要留半吊子状态。

---

## 6. 不做的事（防止跑偏）

- 不引入浮层库（Radix / HeadlessUI / Floating UI）—— 现有「零原生依赖」是核心收益，菜单与弹窗自研成本可控。
- 不引入图标库 —— 图标注册表手写路径即可。
- 不做多实例编辑器（见 P3 的收敛设计）。
- 不做白板、数据库、同步、发布。
- 不在 P1 / P2 顺手改视觉风格 —— 令牌已定，风格调整单独走一轮。
- 不碰 `.workbuddy/` 目录。

---

## 7. 每阶段通用验收清单

- [ ] `npm run verify` 全绿（单测 + 接口冒烟 + 前端渲染冒烟）
- [ ] 亮色 / 暗色两个主题都过一遍
- [ ] 键盘全通路：Tab 能走完所有交互元素，Esc 能退出所有浮层
- [ ] 新增交互元素都有 `aria-label` 或可见文字
- [ ] 对比度 ≥ 4.5:1（菜单文字、状态栏文字、危险项）
- [ ] 桌面端打包后复验一次（两份 `.ico`、`asar: false`、`listen(0)` 临时端口均未被破坏）
