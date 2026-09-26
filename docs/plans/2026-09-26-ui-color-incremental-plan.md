# Lattice UI 与色彩增量计划

## 目标

把现有 Markdown 知识库工作台调整为更安静、清晰、耐看的工具界面：内容区优先，外壳层级明确，交互状态有足够对比，浅色与深色主题保持同一套语义。

## 已完成：P0 视觉基础

- 将主色从偏蓝的单一方案调整为青绿色强调色，降低长时间使用的视觉疲劳。
- 统一浅色/深色主题的背景、边框、文字、状态色和图谱颜色令牌。
- 明确外壳层、内容层、浮层的明度关系，减少边框依赖。
- 收紧圆角和阴影，减少后台卡片感。
- 增强活动笔记的左侧强调条、选中背景和列表 hover 反馈。
- 增加 `prefers-reduced-motion` 处理。

## P1：结构与密度

1. 统一 Ribbon、Tab、Sidebar、List、Editor 的边界与滚动职责。
2. 清理 TopBar 与 Obsidian shell 的重复样式，保留旧 shell 作为回滚路径。
3. 统一按钮、选择器、分段控件、标签的高度和文字基线。
4. 为空状态、加载状态、错误状态建立同一套间距与语义色规则。

验收：窗口缩放到 1280、1024、768 宽度时，内容不溢出，主操作仍可见。

## P2：交互与可访问性

1. 检查 Ribbon、Tab、列表卡片、设置弹窗的键盘焦点顺序。
2. 补齐图标按钮的可见 tooltip 和可读 `aria-label`。
3. 校验浅色/深色主题文字对比度，尤其是 tertiary 文本、标签和状态栏。
4. 为右键菜单、快速切换器和设置弹窗补充 Escape 关闭后的焦点回还。

验收：不使用鼠标可以打开笔记、切换视图、保存、关闭浮层；焦点环不被裁切。

## P3：内容体验

1. 进一步优化编辑器标题、正文、预览的阅读宽度和留白。
2. 将保存状态、统计信息、连接状态压缩为可扫描的信息带。
3. 为搜索结果、无笔记、无匹配、后端断开提供明确的下一步动作。
4. 复核图谱视图在浅色与深色主题中的节点、连线和标签层级。

验收：新用户无需说明即可完成“筛选目录 -> 打开笔记 -> 编辑 -> 保存”的主路径。

## 验证顺序

1. `npm run build`
2. `npm run test:web`
3. `npm run test`
4. 在桌面端验证 1280x800、1440x900 和窄窗口布局。
5. 核对浅色/深色截图，确认无文本溢出、重叠和低对比度控件。

## 回滚边界

本轮只新增末尾视觉覆盖规则与计划文档。若需要回滚，可移除 `styles.css` 中标记为 `2026 UI refresh` 的区块，不影响业务逻辑和现有 shell 结构。

## Execution Status

- P0 visual foundation: complete
- P1 layout, density, scroll ownership, and responsive shell: complete
- P2 focus management, modal scroll lock, keyboard entry points, and control semantics: complete
- P3 reading width, content typography, empty states, and status hierarchy: complete

The current visual direction is glass blue: cool white background, pale blue grid, translucent surfaces, blue focus states, and matching dark theme tokens.
