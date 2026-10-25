# AI 金标集 Eval（W9 · 地基 ⑧）

本目录是 AI 质量回归的评估挂钩：题集与基线入仓，脚本确定性可复算，门禁进 CI。
设计与验收依据：`doc/AI/地基/Lattice-AI地基架构方案.md` §F2 / §11，`doc/AI/执行/AI升级执行方案.md` W9。

## 文件

| 文件 | 作用 |
|---|---|
| `golden-set.json` | 金标集 16 题（5 类）。评分：mustInclude 锚点命中率给部分分（0~1），forbid 任一命中直接 0 分。锚点是「好答案必然包含/必然不含」的宽松判据，用于捕捉质量回退，不是精确评分。 |
| `baseline.json` | **入仓基线**：锚点满分参照（确定性，可复算），`goldenSetHash` 把基线与题集钉死。由 `build-baseline.mjs` 生成，不手改。 |
| `metrics-report.mjs` | 评分器：`answers.json`（`[{id, answer}]`）→ 聚合报告（mean/forbiddenHits/byCategory…）。只读本地文件，永不外联。 |
| `build-baseline.mjs` | 基线生成入口（`npm run eval:golden:baseline`）。题集变更后必须重跑并提交新基线。 |
| `regression-gate.mjs` | CI 门禁一：金标集结构健全 + 基线哈希/聚合值可复算一致。漂移即红。 |
| `golden-regression.mjs` | 两份报告互比的阈值回归（mean 降幅 ≤0.05、分类降幅 ≤0.10、forbidden/missing 不新增）。 |
| `quality-gate.mjs` | 检索召回 / 引用准确 / 写入成功的阈值门禁（离线结果集输入）。 |
| `scan-secrets.mjs` | CI 门禁二：全仓密钥字面量扫描（地基方案 §11.1 红线的机器执行）。 |

## 两条流水线，别混用

**CI 红线（无模型、无密钥，纯确定性）**

```
node src-tauri/eval/regression-gate.mjs   # 题集结构 + 基线一致性
node src-tauri/eval/scan-secrets.mjs      # 密钥字面量 = 0
```

本地等价入口：`npm run eval:gate`（已并入 `npm run verify`）。基线是「锚点满分」，
**不要**拿真实跑分报告与它比——真实分恒低于满分，比较无意义。

**真实跑分回归（本机配好 provider 后，改动上线前后各跑一次）**

```
node src-tauri/eval/metrics-report.mjs answers-before.json > src-tauri/eval/reports/before.json
node src-tauri/eval/metrics-report.mjs answers-after.json  > src-tauri/eval/reports/after.json
node src-tauri/eval/golden-regression.mjs src-tauri/eval/reports/before.json src-tauri/eval/reports/after.json
```

`reports/` 已 gitignore：answers 与报告含模型输出，只留本地。

## 题集变更流程

1. 改 `golden-set.json`（增删题、调锚点）；
2. `npm run eval:golden:baseline` 重新生成 `baseline.json`；
3. 两份文件同一提交入仓——否则 `regression-gate.mjs` 哈希校验变红。

## 密钥扫描约定

- 密钥只走 env（`LATTICE_PROVIDER__<ID>__API_KEY`）或密钥服务；仓库任何文件不出现可用凭据字面量。
- 测试/夹具需要凭据形态样本时用运行时拼接（如 `'sk-' + 'aA1'.repeat(8)`），不写完整字面量。
- `masked:*`、`${env}`、`demo-*`、`*-secret` 等自声明假样本与打码串不算命中；个别确需保留的行加行内标记 `lattice:allow-secret`。
