const BASE_URL = process.env.GRIZZLY_API_BASE || "https://api.grizzlysms.com/stubs/handler_api.php";
const API_KEY = process.env.GRIZZLY_API_KEY || "";
const COUNTRY_ID = process.env.GRIZZLY_COUNTRY_ID || "14";
const CONFIGURED_SERVICE_CODE = process.env.GRIZZLY_SERVICE_CODE || "";
const MAX_PRICE = process.env.GRIZZLY_MAX_PRICE || "";

export interface NumberOrder {
  id: string;
  number: string;
  cost: string;
  status: string;
  providerService: string;
}

export interface SmsResult {
  code?: string;
  status: string;
}

export class GrizzlyError extends Error {
  code: string;

  constructor(message: string, code = "api_error") {
    super(message);
    this.name = "GrizzlyError";
    this.code = code;
  }
}

const ERROR_CODES = new Set([
  "BAD_KEY",
  "BAD_ACTION",
  "BAD_SERVICE",
  "BAD_STATUS",
  "NO_ACTIVATION",
  "NO_BALANCE",
  "NO_NUMBERS",
  "SERVICE_UNAVAILABLE_REGION",
  "WRONG_MAX_PRICE",
  "ERROR_SQL",
]);

function normalizeErrorCode(value: string) {
  return value.trim().toLowerCase();
}

async function api(action: string, params: Record<string, string> = {}): Promise<string> {
  if (!API_KEY) {
    throw new GrizzlyError("Grizzly SMS 尚未配置 API Key", "missing_api_key");
  }

  const url = new URL(BASE_URL);
  url.search = new URLSearchParams({ api_key: API_KEY, action, ...params }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json, text/plain" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "网络请求失败";
    throw new GrizzlyError(`请求 Grizzly SMS 失败：${message}`, "timeout");
  }

  const body = (await response.text()).trim();
  const errorCode = body.split(":", 1)[0]?.trim().toUpperCase();
  if (ERROR_CODES.has(errorCode)) {
    throw new GrizzlyError(body, normalizeErrorCode(errorCode));
  }
  if (!response.ok) {
    throw new GrizzlyError(body || `Grizzly SMS HTTP ${response.status}`, "api_error");
  }
  return body;
}

let cachedServiceCode: string | null = null;

function serviceRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
  if (!value || typeof value !== "object") return [];
  const wrapped = value as { services?: unknown };
  if (wrapped.services) return serviceRows(wrapped.services);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if (item && typeof item === "object") return [{ code: key, ...(item as Record<string, unknown>) }];
    return [{ code: key, name: item }];
  });
}

async function resolveSoulAppServiceCode(): Promise<string> {
  if (CONFIGURED_SERVICE_CODE) return CONFIGURED_SERVICE_CODE;
  if (cachedServiceCode) return cachedServiceCode;

  const body = await api("getServicesList");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GrizzlyError("Grizzly SMS 服务列表格式异常", "service_list_error");
  }

  const hit = serviceRows(parsed).find((item) => {
    const text = [item.name, item.title, item.service, item.slug, item.code, item.serviceCode]
      .filter(Boolean)
      .join(" ")
      .replace(/[\s_-]+/g, "")
      .toLowerCase();
    return text.includes("soulapp");
  });
  const code = hit?.code ?? hit?.serviceCode ?? hit?.service ?? hit?.id;
  if (!code) {
    throw new GrizzlyError(
      "未能自动找到 SoulAPP 服务代码，请在 Vercel 设置 GRIZZLY_SERVICE_CODE",
      "missing_service_code"
    );
  }
  cachedServiceCode = String(code);
  return cachedServiceCode;
}

export async function getNumber(): Promise<NumberOrder> {
  const service = await resolveSoulAppServiceCode();
  const params: Record<string, string> = { service, country: COUNTRY_ID };
  if (MAX_PRICE) params.maxPrice = MAX_PRICE;

  const body = await api("getNumberV2", params);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    const match = body.match(/^ACCESS_NUMBER:([^:]+):(.+)$/);
    if (!match) throw new GrizzlyError(`Grizzly SMS 返回了未知下单结果：${body}`, "invalid_response");
    return {
      id: match[1],
      number: match[2],
      cost: "0",
      status: "ready",
      providerService: service,
    };
  }

  const id = data.activationId ?? data.activation_id ?? data.id;
  const number = data.phoneNumber ?? data.phone_number ?? data.number;
  if (id == null || !number) {
    throw new GrizzlyError("Grizzly SMS 未返回香港号码，请检查余额、库存和服务配置", "invalid_response");
  }
  return {
    id: String(id),
    number: String(number),
    cost: String(data.activationCost ?? data.activation_cost ?? data.cost ?? "0"),
    status: "ready",
    providerService: service,
  };
}

export async function getSms(id: string): Promise<SmsResult> {
  const body = await api("getStatusV2", { id });
  if (body === "STATUS_WAIT_CODE" || body.startsWith("STATUS_WAIT_")) {
    return { status: "waiting_code" };
  }
  if (body === "STATUS_CANCEL") return { status: "cancelled" };
  if (body.startsWith("STATUS_OK:")) return { status: "sms_received", code: body.slice(10) };

  try {
    const data = JSON.parse(body) as { sms?: { code?: string | number } | null };
    const code = data.sms?.code;
    return code == null || code === ""
      ? { status: "waiting_code" }
      : { status: "sms_received", code: String(code) };
  } catch {
    throw new GrizzlyError(`Grizzly SMS 返回了未知查询结果：${body}`, "invalid_response");
  }
}

async function setStatus(id: string, status: "6" | "8") {
  const body = await api("setStatus", { id, status });
  if (["ACCESS_ACTIVATION", "ACCESS_CANCEL", "STATUS_CANCEL"].includes(body)) return { status: body };
  throw new GrizzlyError(`Grizzly SMS 无法更新订单状态：${body}`, "status_update_failed");
}

export function cancelOrder(id: string) {
  return setStatus(id, "8");
}

export function rejectOrder(id: string) {
  return setStatus(id, "8");
}

export function markOrderUsed(id: string) {
  return setStatus(id, "6");
}

export async function getBalance(): Promise<{ balance: number | null }> {
  const body = await api("getBalance");
  const match = body.match(/^ACCESS_BALANCE:(.+)$/);
  return { balance: match ? Number(match[1]) : null };
}

export function isGrizzlyApplication(value: string) {
  return value.startsWith("grizzly:");
}

export function grizzlyApplication(serviceCode: string) {
  return `grizzly:${serviceCode}`;
}

export function getConfig() {
  return {
    countryId: COUNTRY_ID,
    service: "SoulAPP",
    serviceCode: CONFIGURED_SERVICE_CODE || null,
    maxPrice: MAX_PRICE || null,
    baseUrl: BASE_URL,
  };
}
