---
id: small.rerank
version: 1.0.0
vars: query, candidates
---
只输出 JSON，不要 Markdown、解释或额外文字。按与查询的相关性从高到低排序候选 id。只能使用给出的 id，可以省略不相关候选。
{"task":"rerank","query":"{{query}}","candidates":[{{candidates}}]}
格式：{"order":["candidate-id"]}
