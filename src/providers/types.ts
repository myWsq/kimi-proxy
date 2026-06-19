import type { Dispatcher } from "undici";
import type { QuotaTier, TotalQuota } from "../types.js";

/** 单次配额解析结果。 */
export interface ParsedUsages {
  tiers: QuotaTier[];
  totalQuota: TotalQuota | null;
}

/** 自定义配额抓取拿到的账号上下文(凭证 + 出站 dispatcher)。 */
export interface QuotaContext {
  name: string;
  /** 推理 key(默认 Bearer 抓取用)。 */
  apiKey: string;
  /** 管理类 OpenAPI 的 AccessKey(如方舟用量查询的 V4 签名),与推理 key 不同。 */
  accessKey?: string;
  secretKey?: string;
  region?: string;
  dispatcher?: Dispatcher;
}

/**
 * 上游 Provider 定义。每个 provider 是一段代码:固定的默认 baseUrl、
 * 可选的配额查询(简单 Bearer GET 或完全自定义抓取)。新增 provider = 写一个
 * 模块并在 index 注册,不需要改配置 schema 或核心路由逻辑。
 */
export interface ProviderDef {
  /** 唯一标识,account.provider 引用此 id。 */
  id: string;
  /** 默认上游地址;config 的 providers.<id>.baseUrl 可覆盖。 */
  baseUrl: string;
  /**
   * 配额查询。省略表示该 provider 没有 usage 接口:poller 跳过轮询,账号默认
   * healthy/selectable,仅靠运行时 429/5xx 冷却。两种模式:
   * - 简单模式:{ path, parse } —— Bearer apiKey GET baseUrl+path,再 parse(kimi)
   * - 自定义模式:{ fetch } —— 完全自己抓取+鉴权+解析(如方舟 V4 签名),
   *   返回 null 表示"未配置凭证,本轮按无 quota 处理"
   */
  quota?: {
    path?: string;
    parse?(body: unknown): ParsedUsages;
    fetch?(ctx: QuotaContext): Promise<ParsedUsages | null>;
  };
}
