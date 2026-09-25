/**
 * 示例知识库种子数据。
 * 幂等：库里已有笔记时默认直接跳过，避免覆盖你的真实数据。
 *
 * 用法：
 *   编程式：import { seedSampleVault } from './seed.js'; seedSampleVault();
 *   命令行：npm run db:seed            已有数据则跳过
 *          npm run db:seed -- --force 清空后重建示例库
 *
 * 注意：本模块不负责开关数据库连接，调用方需保证已完成 openDatabase() 与
 * runMigrations()。CLI 入口在 server/scripts/seed.js。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getDb, openDatabase, withTransaction } from './index.js';
import { runMigrations } from './migrate.js';
import * as foldersService from '../modules/folders/folders.service.js';
import * as notesService from '../modules/notes/notes.service.js';
import * as notesRepository from '../modules/notes/notes.repository.js';

export const SEED = [
  {
    folder: '开始使用',
    title: '欢迎使用格物',
    content: `# 欢迎使用格物

格物是一个**本地优先**的双链笔记知识库。所有数据都在你自己的机器上。

## 三个核心动作

1. 用 \`[[双链]]\` 把笔记连起来，例如指向 [[双向链接是什么]] 和 [[关系图谱怎么看]]
2. 用 \`#标签\` 做横向归类，比如 #入门 #方法论
3. 按 \`Ctrl + K\` 打开快速切换器，按标题跳转任意笔记

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| Ctrl / Cmd + K | 快速切换笔记 |
| Ctrl / Cmd + N | 新建笔记 |
| Ctrl / Cmd + S | 立即保存 |
| Ctrl / Cmd + E | 切换编辑 / 预览 |

> 提示：正文里的双链和标签会在保存时自动解析，不需要任何手工维护。

继续阅读：[[双向链接是什么]] → [[关系图谱怎么看]]`,
  },
  {
    folder: '开始使用',
    title: '双向链接是什么',
    content: `# 双向链接是什么

传统笔记是一棵树，你只能沿着目录往下找。双链笔记是一张网——你从任意一个节点都能沿着关联走。

## 语法

- \`[[目标笔记]]\` 建立一条出链
- \`[[目标笔记|显示别名]]\` 给链接换个显示名
- \`[[目标笔记#某小节]]\` 精确指向标题
- \`![[目标笔记]]\` 嵌入引用

## 关键概念：反向链接

当 A 里写了 \`[[B]]\`，B 的底部就会自动出现「A 引用了 B」。

**反向链接是双链笔记的灵魂**，因为它让你在写 B 的时候就能看见所有关联上下文。

试试看：这篇笔记引用了 [[欢迎使用格物]]，所以在那篇笔记的反链面板里能看到本页。

标签：#方法论 #入门`,
  },
  {
    folder: '开始使用',
    title: '关系图谱怎么看',
    content: `# 关系图谱怎么看

图谱把整个知识库渲染成一张力导向网络：

- **节点大小** = 连接数（度数）。连得越多，说明这个概念越核心。
- **连线** = 一条已解析的双向链接。
- **悬空链接**（指向尚不存在的笔记）会提示你补全知识缺口。

## 怎么用

1. 找出「孤岛节点」——度数很低但你觉得重要的，说明文档之间缺少关联
2. 找出「枢纽节点」——度数最高的那几个，通常是你的核心方法论
3. 点击任意节点直接跳转到对应笔记

相关：[[双向链接是什么]]、[[欢迎使用格物]]

标签：#方法论 #图谱`,
  },
  {
    folder: '工程笔记',
    title: '架构分层说明',
    content: `# 架构分层说明

本项目的后端按「按功能组织 + 三层架构」落地。

## 三层职责

1. **控制器** controller —— 解析请求、调用服务、组织响应，不写业务逻辑
2. **服务层** service —— 承载业务规则与事务编排，不依赖 req / res
3. **仓储层** repository —— 只负责 SQL 与外部调用

## 为什么不让控制器直接写 SQL

因为那样业务规则会散落在 HTTP 层，无法被后台任务、定时脚本复用，也无法脱离 HTTP 单独测试。

## 一个具体的例子

保存一篇笔记要同时完成三件事：笔记本体落库、标签关联重建、出链重建。
这三步必须在同一个事务里完成，因此统一收敛在 \`notes.service.update()\` 中。

标签：#架构 #工程`,
  },
  {
    folder: '工程笔记',
    title: '全文检索实现',
    content: `# 全文检索实现

SQLite 自带 FTS5，但对中文有个坑。

## 坑在哪

默认的 \`unicode61\` 分词器会把一整串汉字当作**一个词**，
于是搜「知识」匹配不到「知识管理」。

## 解法：trigram 分词器

\`\`\`sql
CREATE VIRTUAL TABLE notes_fts USING fts5 (
  note_id UNINDEXED, title, content, tokenize = 'trigram'
);
\`\`\`

trigram 按 3 字符滑窗建索引，天然支持中文子串匹配。

## 代价

- 索引体积比 unicode61 大
- 检索词短于 3 个字符时无法命中，必须回退 \`LIKE\`

因此服务层做了一个两段式策略：长度 ≥ 3 走 FTS，否则走 LIKE；FTS 空结果时再用 LIKE 兜底复核。

标签：#工程 #检索`,
  },
  {
    folder: null,
    title: '未归档的想法',
    content: `# 未归档的想法

这篇笔记刻意放在根级、不带目录，用来验证「未分类」筛选。

脑海里飘着的一些念头：

- 给笔记加版本历史（每次保存留一份快照）
- 支持导出成静态站点
- 移动端 PWA

关联：[[架构分层说明]]

标签：#想法`,
  },
];

/** 清空全部业务数据。外键 CASCADE 会连带清掉 links 与 note_tags。 */
function resetVault() {
  withTransaction(() => {
    const db = getDb();
    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM folders');
    db.exec('DELETE FROM tags');
    // 触发器已同步清理 FTS，这里再兜一次底，防止历史脏数据残留
    db.exec('DELETE FROM notes_fts');
  });
}

/**
 * 把示例知识库写入当前已打开的数据库。
 * @param {{ force?: boolean }} [options] force 为 true 时先清空现有业务数据再重建
 * @returns {{ seeded: boolean, reason?: 'not-empty', created: number, folders: number, removed: number }}
 */
export function seedSampleVault({ force = false } = {}) {
  const existing = notesRepository.statistics().noteCount;

  if (existing > 0 && !force) {
    return { seeded: false, reason: 'not-empty', created: 0, folders: 0, removed: 0 };
  }

  const removed = existing > 0 ? existing : 0;
  if (removed > 0) resetVault();

  const folderIds = new Map();
  for (const item of SEED) {
    if (item.folder && !folderIds.has(item.folder)) {
      folderIds.set(item.folder, foldersService.create({ name: item.folder }).id);
    }
  }

  // 第一轮先建正文，第二轮补链接由保存流程自动完成
  const created = SEED.map((item) =>
    notesService.create({
      title: item.title,
      content: item.content,
      folderId: item.folder ? folderIds.get(item.folder) : null,
    }),
  );

  // 置顶欢迎笔记，让首屏有内容
  notesService.update(created[0].id, { isPinned: true });

  return { seeded: true, created: created.length, folders: folderIds.size, removed };
}

/** 直接作为脚本运行时的入口 */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const FORCE = process.argv.includes('--force');
  openDatabase();
  runMigrations();

  const result = seedSampleVault({ force: FORCE });

  if (!result.seeded) {
    console.log('库里已有笔记，跳过种子数据。如需重建请执行：npm run db:seed -- --force');
  } else {
    if (result.removed > 0) console.log(`已清空原有 ${result.removed} 篇笔记，开始重建示例知识库。`);
    console.log(`已写入示例知识库：${result.created} 篇笔记、${result.folders} 个目录。`);
  }

  closeDatabase();
}
