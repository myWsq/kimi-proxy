import type { ProviderDef } from "./types.js";

/**
 * StarrySky(x001.ai 中转,Anthropic 兼容端点)。
 * 上游 messages 端点为 https://x001.ai/v1/messages,故 baseUrl 取站点根:
 * 本代理剥掉 /anthropic 前缀后拼 /v1/messages,最终命中 .../v1/messages。
 * 用户给的 "https://x001.ai/v1" 里的 /v1 已包含在代理转发的路径里,baseUrl 不能再带。
 *
 * 注意:x001.ai 是 OpenAI 风格中转,/v1/models 里只有 glm-5.2 支持 anthropic 端点
 * 类型(kimi-k2.6 / deepseek-v4-flash 仅 openai,走本 Anthropic 协议代理不通)。
 * 故 config 的 providers.starrysky.model 必须用支持 anthropic 的模型(glm-5.2)。
 * 鉴权走 Authorization: Bearer(与 kimi/glm/mimo 一致)。
 *
 * 暂未发现可用的 usage 查询接口,故省略 quota:poller 跳过轮询,账号默认可选,
 * 仅靠运行时 429/5xx 冷却。响应 usage 为原生 Anthropic 字段,沿用现有 UsageTap。
 */
export const starrysky: ProviderDef = {
  id: "starrysky",
  baseUrl: "https://x001.ai",
};
