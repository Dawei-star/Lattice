---
id: small.intent
version: 1.0.0
vars: message, mode, hasAttachments
---
只输出 JSON，不要 Markdown、解释或额外文字。
将用户请求分类为一个或多个意图。intents 只能使用 writing、qa、search、agent。modelTier 只能使用 fast、standard、reasoning。
{"task":"intent","message":"{{message}}","mode":"{{mode}}","hasAttachments":{{hasAttachments}}}
格式：{"intents":["qa"],"confidence":0.0,"modelTier":"fast","requiresClarification":false}
