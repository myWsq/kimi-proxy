import type { ProviderDef } from "./types.js";

/**
 * 小米 MiMo Token Plan(订阅制，Anthropic 兼容端点）。
 * 上游路径与 kimi/glm 一致：客户端打 /anthropic/v1/messages，本代理剥掉 /anthropic
 * 前缀后拼到 baseUrl（baseUrl 自身已含 /anthropic），最终命中 .../anthropic/v1/messages。
 * 鉴权走 Authorization: Bearer（MiMo 官方文档确认该端点同时支持 Bearer 与 api-key）。
 *
 * 暂未确认有可用的 usage 查询接口，故省略 quota：poller 跳过轮询，账号默认可选，
 * 仅靠运行时 429/5xx 冷却。若后续发现 usages 端点，按 kimi.ts 补 { path, parse } 即可。
 * baseUrl 默认走 CN 区，config 的 providers.mimo.baseUrl 可改成 sgp 海外区。
 */
export const mimo: ProviderDef = {
  id: "mimo",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
};
