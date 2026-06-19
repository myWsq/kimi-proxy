import type { ProviderDef } from "./types.js";

/**
 * 智谱 GLM Coding(Anthropic 兼容端点)。暂无可用的 usage 查询接口,
 * 故省略 quota:poller 跳过轮询,账号默认可选,仅靠运行时 429/5xx 冷却。
 * baseUrl 为占位,按上游实际 Anthropic 兼容地址校正。
 */
export const glm: ProviderDef = {
  id: "glm",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
};
