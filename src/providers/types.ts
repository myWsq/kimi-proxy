import type { QuotaTier, TotalQuota } from "../types.js";

/** 单次配额解析结果。 */
export interface ParsedUsages {
  tiers: QuotaTier[];
  totalQuota: TotalQuota | null;
}

/**
 * 上游 Provider 定义。每个 provider 是一段代码:固定的默认 baseUrl、
 * 可选的配额查询端点 + 解析函数。新增 provider = 写一个模块并在 index 注册,
 * 不需要改配置 schema 或核心路由逻辑。
 */
export interface ProviderDef {
  /** 唯一标识,account.provider 引用此 id。 */
  id: string;
  /** 默认上游地址;config 的 providers.<id>.baseUrl 可覆盖。 */
  baseUrl: string;
  /**
   * 配额查询。省略表示该 provider 没有 usage 接口:
   * poller 跳过轮询,账号默认 healthy/selectable,仅靠运行时 429/5xx 冷却。
   */
  quota?: {
    /** 相对 baseUrl 的路径,如 "/v1/usages"。 */
    path: string;
    parse(body: unknown): ParsedUsages;
  };
}
