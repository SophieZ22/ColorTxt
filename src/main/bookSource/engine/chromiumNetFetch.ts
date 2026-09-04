import { createHash } from "node:crypto";
import { session, type Session } from "electron";
import { decodeHttpResponseBody } from "../../detectTextEncoding";
import { cookieHeaderForUrl, setCookieFromResponse } from "./cookieManager";
import {
  DEFAULT_BOOK_SOURCE_USER_AGENT,
  getWebViewUserAgent,
} from "./bookSourceUserAgent";
import {
  getBookSourceDispatcher,
  getDefaultBookSourceProxy,
  parseLegadoProxy,
} from "./httpProxy";

const MAX_BYTES = 8 * 1024 * 1024;

export type ChromiumNetFetchResult = {
  url: string;
  body: string;
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string>;
};

type SessionEntry = {
  ses: Session;
  proxyReady: Promise<void>;
};

const sessionByProxyKey = new Map<string, SessionEntry>();

function proxyCacheKey(proxy?: string | null): string {
  const text = String(proxy ?? "").trim() || getDefaultBookSourceProxy() || "";
  return text || "__direct__";
}

/**
 * 书源备用 session（undici 失败时）：Chromium 网络栈 + 忽略坏证书；按代理分区。
 * 不用 defaultSession，避免 setCertificateVerifyProc 影响应用其它窗口。
 * 关闭 HTTP 磁盘缓存。
 */
function getBookSourceNetSession(proxy?: string | null): SessionEntry {
  const key = proxyCacheKey(proxy);
  const existing = sessionByProxyKey.get(key);
  if (existing) return existing;

  const partition = `persist:colortxt-bs-net-v2-${createHash("md5")
    .update(key)
    .digest("hex")
    .slice(0, 12)}`;
  const ses = session.fromPartition(partition, { cache: false });
  // 对齐 Legado SSLHelper.unsafe* / undici rejectUnauthorized:false
  ses.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });

  const parsed = parseLegadoProxy(
    key === "__direct__" ? "" : key,
  );
  const proxyReady = parsed
    ? ses.setProxy({ proxyRules: parsed.uri }).then(() => undefined)
    : ses.setProxy({ mode: "direct" }).then(() => undefined);

  const entry: SessionEntry = { ses, proxyReady };
  sessionByProxyKey.set(key, entry);
  return entry;
}

function collectResponseHeaders(res: Response): Record<string, string> {
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  return outHeaders;
}

/**
 * 书源常带 OkHttp 风格头（如部分书源 `"Keep-Alive":""`）。
 * undici 校验 Keep-Alive 会抛 `invalid keep-alive header`（UND_ERR_INVALID_ARG）。
 * 对齐 Legado/OkHttp：**只**丢掉 hop-by-hop 的 Keep-Alive；其它空值头须保留
 *（部分带签名头的 API 书源等把 `AUTHORIZATION=` 空串算进 `sign`，丢掉会导致 401）。
 */
export function sanitizeBookSourceRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    if (/^keep-alive$/i.test(key)) continue;
    out[key] = String(rawVal ?? "");
  }
  return out;
}

function applySetCookieFromResponse(url: string, res: Response): void {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    setCookieFromResponse(url, setCookie);
    return;
  }
  const sc = res.headers.get("set-cookie");
  if (sc) setCookieFromResponse(url, sc);
}

async function decodeFetchResult(
  url: string,
  res: Response,
  charset?: string,
): Promise<ChromiumNetFetchResult> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`HTTP 响应过大 (${buf.length} > ${MAX_BYTES})`);
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  const body = decodeHttpResponseBody(buf, {
    charset,
    contentType,
  });
  applySetCookieFromResponse(url, res);
  return {
    url: res.url || url,
    body,
    statusCode: res.status,
    statusMessage: res.statusText,
    headers: collectResponseHeaders(res),
  };
}

/** undici：对齐 Legado OkHttp，不受 Chromium 客户端拦截（ERR_BLOCKED_BY_CLIENT）影响 */
async function fetchViaUndici(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer | Uint8Array | null;
  charset?: string;
  timeoutMs?: number;
  proxy?: string | null;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}): Promise<ChromiumNetFetchResult> {
  const method = opts.method.toUpperCase();
  const init: RequestInit & { dispatcher?: unknown } = {
    method,
    headers: opts.headers,
    redirect: opts.redirect ?? "follow",
    signal: combineAbortSignals(
      AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      opts.signal,
    ),
    dispatcher: getBookSourceDispatcher(opts.proxy),
  };
  if (method !== "GET" && method !== "HEAD" && opts.body != null) {
    init.body = (
      Buffer.isBuffer(opts.body)
        ? new Uint8Array(opts.body)
        : opts.body instanceof Uint8Array
          ? opts.body
          : opts.body
    ) as BodyInit;
  }
  const res = await fetch(opts.url, init);
  return decodeFetchResult(opts.url, res, opts.charset);
}

/**
 * 书源 HTTP：默认 undici（对齐 Legado OkHttp）。
 * 同一域名下 Chromium TLS 指纹可能落到另一反代节点，发现列表/「N小时前」会与 Legado 不一致
 * （如部分站点）。显式 `webView:true` / `java.webView` 仍走隐藏窗。
 * undici 失败时再回退 Chromium `session.fetch`（部分站点只认浏览器指纹）。
 */
export async function fetchViaChromiumNet(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array | null;
  charset?: string;
  timeoutMs?: number;
  proxy?: string | null;
  /** 未带 Cookie 头时是否附加 CookieJar（对齐 enabledCookieJar） */
  useCookieJar?: boolean;
  redirect?: RequestRedirect;
  /** 调用方取消（与超时信号合并） */
  signal?: AbortSignal;
}): Promise<ChromiumNetFetchResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = sanitizeBookSourceRequestHeaders({
    ...(opts.headers ?? {}),
  });
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = getWebViewUserAgent() || DEFAULT_BOOK_SOURCE_USER_AGENT;
  }
  if (
    opts.useCookieJar &&
    !headers.Cookie?.trim() &&
    !headers.cookie?.trim()
  ) {
    const ck = cookieHeaderForUrl(opts.url);
    if (ck) headers.Cookie = ck;
  }

  try {
    return await fetchViaUndici({
      url: opts.url,
      method,
      headers,
      body: opts.body,
      charset: opts.charset,
      timeoutMs: opts.timeoutMs,
      proxy: opts.proxy,
      redirect: opts.redirect,
      signal: opts.signal,
    });
  } catch (undiciErr) {
    if (opts.signal?.aborted) throw undiciErr;
    try {
      return await fetchViaChromiumSession({
        url: opts.url,
        method,
        headers,
        body: opts.body,
        charset: opts.charset,
        timeoutMs: opts.timeoutMs,
        proxy: opts.proxy,
        redirect: opts.redirect,
        signal: opts.signal,
      });
    } catch {
      throw undiciErr;
    }
  }
}

/** 超时与外部取消合并；已中止则立即返回该信号 */
function combineAbortSignals(
  timeout: AbortSignal,
  external?: AbortSignal,
): AbortSignal {
  if (!external) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeout, external]);
  }
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (timeout.aborted || external.aborted) {
    ac.abort();
    return ac.signal;
  }
  timeout.addEventListener("abort", abort, { once: true });
  external.addEventListener("abort", abort, { once: true });
  return ac.signal;
}

/** Electron session.fetch：浏览器 TLS；关闭磁盘缓存 */
async function fetchViaChromiumSession(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer | Uint8Array | null;
  charset?: string;
  timeoutMs?: number;
  proxy?: string | null;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}): Promise<ChromiumNetFetchResult> {
  const method = opts.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: opts.headers,
    redirect: opts.redirect ?? "follow",
    signal: combineAbortSignals(
      AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      opts.signal,
    ),
    referrerPolicy: "unsafe-url",
    credentials: "omit",
    cache: "no-store",
  };
  if (method !== "GET" && method !== "HEAD" && opts.body != null) {
    init.body = (
      Buffer.isBuffer(opts.body)
        ? new Uint8Array(opts.body)
        : opts.body instanceof Uint8Array
          ? opts.body
          : opts.body
    ) as BodyInit;
  }

  const { ses, proxyReady } = getBookSourceNetSession(opts.proxy);
  await proxyReady;
  const res = await ses.fetch(opts.url, init);
  return decodeFetchResult(opts.url, res, opts.charset);
}

// sophie
export type ChromiumBinaryFetchResult = {
  url: string;
  body: Buffer;
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string>;
};

/**
 * 二进制资源直接走 Electron Chromium session.fetch。
 *
 * 用于图片等不能经过文本解码的资源，同时绕过部分站点
 * 对 Node/undici TLS 指纹的限制。
 */
export async function fetchBinaryViaChromiumSession(opts: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  proxy?: string | null;
  useCookieJar?: boolean;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}): Promise<ChromiumBinaryFetchResult> {
  const headers = sanitizeBookSourceRequestHeaders({
    ...(opts.headers ?? {}),
  });

  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] =
      getWebViewUserAgent() || DEFAULT_BOOK_SOURCE_USER_AGENT;
  }

  if (
    opts.useCookieJar &&
    !headers.Cookie?.trim() &&
    !headers.cookie?.trim()
  ) {
    const cookie = cookieHeaderForUrl(opts.url);

    if (cookie) {
      headers.Cookie = cookie;
    }
  }

  const init: RequestInit = {
    method: "GET",
    headers,
    redirect: opts.redirect ?? "follow",

    // 非常重要：
    // 显式 Cookie 由 ColorTxt CookieJar 控制，
    // 不让 Chromium 自己的 session Cookie 覆盖。
    credentials: "omit",

    cache: "no-store",

    referrerPolicy: "unsafe-url",

    signal: combineAbortSignals(
      AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      opts.signal,
    ),
  };

  const { ses, proxyReady } = getBookSourceNetSession(opts.proxy);

  await proxyReady;

  const res = await ses.fetch(opts.url, init);

  const body = Buffer.from(await res.arrayBuffer());

  if (body.length > MAX_BYTES) {
    throw new Error(
      `HTTP 二进制响应过大 (${body.length} > ${MAX_BYTES})`,
    );
  }

  applySetCookieFromResponse(opts.url, res);

  return {
    url: res.url || opts.url,
    body,
    statusCode: res.status,
    statusMessage: res.statusText,
    headers: collectResponseHeaders(res),
  };
}