// 服务商目录：供“添加模型”弹窗与模型列表展示品牌 Logo、默认接口地址和常用模型建议。
const LOGO = (name) => `/provider-logos/${name}.svg`;

export const CUSTOM_SERVICE = '自定义 (OpenAI Compatible)';

export const PROVIDERS = [
  { key: 'custom', label: '自定义模型', description: 'OpenAI Compatible', logo: LOGO('custom'), endpoint: '', models: [] },
  { key: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API', logo: LOGO('deepseek'), endpoint: 'https://api.deepseek.com/chat/completions', models: ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { key: 'volcengine', label: '火山引擎', description: '火山方舟', logo: LOGO('volcengine'), endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', models: ['doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-turbo-260915'], keyUrl: 'https://console.volcengine.com/ark' },
  { key: 'minimax-cn', label: 'MiniMax CN', description: 'MiniMax 国内', logo: LOGO('minimax'), endpoint: 'https://api.minimax.cn/v1/chat/completions', models: ['MiniMax-M3'], keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
  { key: 'minimax-global', label: 'MiniMax Global', description: 'MiniMax Global', logo: LOGO('minimax'), endpoint: 'https://api.minimax.io/v1/chat/completions', models: ['MiniMax-M3'], keyUrl: 'https://platform.minimax.io/console/access' },
  { key: 'bigmodel', label: 'Bigmodel', description: '智谱 BigModel', logo: LOGO('bigmodel'), endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-FlashX'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { key: 'aliyun', label: '阿里云', description: '百炼兼容接口', logo: LOGO('aliyun'), endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: ['Qwen3.8-Max', 'Qwen3.8-Plus', 'Qwen3.8-Flash'], keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key' },
  { key: 'mimo', label: 'Xiaomi MIMO', description: 'Xiaomi MIMO', logo: LOGO('mimo'), endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', models: [], keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys' },
  { key: 'siliconflow', label: '硅基流动', description: 'SiliconFlow', logo: LOGO('siliconflow'), endpoint: 'https://api.siliconflow.cn/v1/chat/completions', models: ['DeepSeek-V4-Flash', 'Qwen3.8-Flash'], keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { key: 'zai', label: 'Z.ai', description: 'Z.ai', logo: LOGO('zai'), endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', models: ['GLM-5.3', 'GLM-5.2'], keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { key: 'openrouter', label: 'OpenRouter', description: 'OpenRouter', logo: LOGO('openrouter'), endpoint: 'https://openrouter.ai/api/v1/chat/completions', models: [], keyUrl: 'https://openrouter.ai/keys' },
  { key: 'kimi-cn', label: 'Kimi CN', description: 'Moonshot 国内', logo: LOGO('kimi'), endpoint: 'https://api.moonshot.cn/v1/chat/completions', models: ['Kimi-K3', 'Kimi-K2.8-Preview'], keyUrl: 'https://platform.kimi.com/console/api-keys' },
  { key: 'kimi-global', label: 'Kimi Global', description: 'Moonshot Global', logo: LOGO('kimi'), endpoint: 'https://api.moonshot.ai/v1/chat/completions', models: ['Kimi-K3', 'Kimi-K2.8-Preview'], keyUrl: 'https://platform.kimi.ai/console/api-keys' },
  { key: 'byteplus', label: 'BytePlus', description: 'BytePlus', logo: LOGO('byteplus'), endpoint: 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', models: [], keyUrl: 'https://ai.byteplus.com/ark/region:ap-southeast-1/apikey' },
  { key: 'aws', label: 'AWS', description: 'Amazon Bedrock', logo: LOGO('aws'), endpoint: '', models: [], keyUrl: 'https://console.aws.amazon.com/bedrock/home', hint: 'Bedrock 官方 OpenAI 兼容端点：https://bedrock-runtime.{区域}.amazonaws.com/openai/v1/chat/completions（认证用 Bedrock API Key；该端点不支持列出模型）。' },
  { key: 'tencent', label: '腾讯', description: '腾讯 MaaS（TokenHub）', logo: LOGO('tencentcloud'), endpoint: 'https://tokenhub.tencentmaas.com/v1/chat/completions', models: ['glm-5.3-flashx'], keyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey' },
  { key: 'model-force', label: '模力方舟', description: 'Gitee AI 模型服务', logo: LOGO('modelforce'), endpoint: 'https://ai.gitee.com/v1/chat/completions', models: [], keyUrl: 'https://ai.gitee.com/docs/account/access-token' },
  { key: 'ppio', label: 'PPIO', description: 'PPIO 派欧云', logo: LOGO('ppio'), endpoint: 'https://api.ppio.com/openai/v1/chat/completions', models: [], keyUrl: 'https://ppio.com/console' },
];

// 模型列表按已保存的 service 名称就近匹配品牌 Logo；匹配不到时回退为自定义图标。
const SERVICE_MATCHERS = [
  ['deepseek', 'deepseek'],
  ['火山', 'volcengine'],
  ['minimax', 'minimax-cn'],
  ['bigmodel', 'bigmodel'],
  ['智谱', 'bigmodel'],
  ['阿里', 'aliyun'],
  ['百炼', 'aliyun'],
  ['dashscope', 'aliyun'],
  ['mimo', 'mimo'],
  ['小米', 'mimo'],
  ['硅基', 'siliconflow'],
  ['siliconflow', 'siliconflow'],
  ['z.ai', 'zai'],
  ['openrouter', 'openrouter'],
  ['kimi', 'kimi-cn'],
  ['moonshot', 'kimi-cn'],
  ['byteplus', 'byteplus'],
  ['aws', 'aws'],
  ['bedrock', 'aws'],
  ['tokenhub', 'tencent'],
  ['tencentmaas', 'tencent'],
  ['腾讯', 'tencent'],
  ['混元', 'tencent'],
  ['混元', 'tencent'],
  ['模力', 'model-force'],
  ['ppio', 'ppio'],
];

export function findProviderByService(service) {
  const value = (service ?? '').trim().toLowerCase();
  if (!value || value.includes('自定义') || value.includes('openai compatible')) {
    return PROVIDERS[0];
  }
  for (const [needle, key] of SERVICE_MATCHERS) {
    if (value.includes(needle)) return PROVIDERS.find((provider) => provider.key === key);
  }
  return PROVIDERS[0];
}
