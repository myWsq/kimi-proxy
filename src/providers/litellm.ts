import type { ProviderDef } from "./types.js";

/**
 * OpenAI-only 上游的统一接入点:经本机 LiteLLM proxy 做协议翻译。
 * LiteLLM 暴露 Anthropic Messages 端点(/v1/messages),把请求转成 OpenAI
 * chat/completions 打到真正的后端,再把响应翻译回 Anthropic SSE —— 所以本代理
 * 仍按「Anthropic 兼容上游」原样透传,UsageTap 照常解析 usage,核心逻辑无需改。
 *
 * baseUrl 不带 /anthropic:客户端打 /anthropic/v1/messages,剥掉 /anthropic 前缀后为
 * /v1/messages,拼到 baseUrl 即命中 http://127.0.0.1:4000/v1/messages。
 * 鉴权:本代理对上游同时下发 Authorization: Bearer 与 x-api-key(见 proxy.ts
 * buildUpstreamHeaders),值均为 account.apiKey —— 需等于 LiteLLM 的 master_key
 * 或某个 virtual key。LiteLLM 的 /v1/messages 认 x-api-key。
 * model 在 config 的 providers.litellm.model 指定,须等于 LiteLLM config 里的 model_name。
 *
 * 暂无 usage 查询接口,故省略 quota:poller 跳过轮询,账号默认可选,仅靠运行时 429/5xx 冷却。
 * 若要把多个 OpenAI 后端各自作为独立路由/优先级单元,复制本模块改 id 注册多个
 * (如 litellm-deepseek / litellm-gpt4),baseUrl 同指 LiteLLM,model 各配各的。
 */
export const litellm: ProviderDef = {
  id: "litellm",
  baseUrl: "http://127.0.0.1:4000",
  // 每个账号的 apiKey 是真正上游(如 JD)的 key,经 body 透传给 LiteLLM。
  injectKeyInBody: true,
};
