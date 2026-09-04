// sophie
import { nativeImage } from "electron";
import { cookieHeaderForUrl } from "./cookieManager";
import { resolveSourceRequestHeaders } from "./sourceRequestHeaders";
import { fetchBinaryViaChromiumSession } from "./chromiumNetFetch";
import { recognizeInlineCharacter } from "./inlineImageOcr";

import type {
  BookSourceRecord,
  SearchBookItem,
  Book,
  BookChapter,
  BookInfoSeed,
} from "@shared/bookSource/types";
import { splitBookMetaTags } from "@shared/bookSource/bookMetaTags";
import {
  coerceBook,
  stripNumericIdPrefix,
  toEngineBook,
} from "@shared/bookSource/bookModel";
import { normalizeBookSourceBaseUrl, normalizeHttpUrlPath, resolveAbsoluteUrl } from "@shared/bookSource/url";
import { wordCountFormat } from "@shared/bookSource/wordCountFormat";
import { formatLegadoBookAuthor, formatLegadoBookName } from "@shared/bookSource/formatBookAuthor";
import {
  splitUrlAndRuleVariables,
  extractUrlFetchOptionsSuffix,
  containsCompositeEvalRule,
  parseLegadoUrlSuffixJson,
  isPlainRuleObject,
  readJsonField,
  readJsonNestedValue,
} from "./legadoCompositeRule";
import { resolveBookCoverDisplayUrl, resolveCoverSourceUrl } from "./coverImage";
import {
  formatLegadoBookIntro,
  formatLegadoLastChapterDisplay,
  ensureLegadoIntroLeadingTitle,
  stripEmbeddedAuthorFromDetailName,
  formatLegadoChapterContent,
  unescapeLegadoHtmlEntities,
  resolveBookInfoField,
  bookInfoSelectorNeedsCompositeResolver,
  stripLegadoKindLabelNoise,
} from "./bookInfoRules";
import { applyRuleRegex, splitRuleRegexSuffix, trimLegadoAsciiWhitespace, loadCheerioHtml } from "./legadoDefaultRule";
import { AnalyzeRule } from "./analyzeRule";
import { isJsoupElementLike } from "./legadoJsoupShim";
import {
  AnalyzeUrl,
  ajaxAllStrResponses,
  splitUrlFetchOptions,
  type StrResponse,
} from "./analyzeUrl";
import { createJsExtensionHost } from "./jsExtensions";
import { evalJsAsync } from "./rhinoRuntime";
import { runLoginCheckJs, awaitLoginForSearchPage, isVerificationCancelled } from "./loginCheck";
import { ensureBookSourceJsLib } from "./sharedJsScope";
import { appendBookSourceErrorLog } from "./bookSourceErrorLog";
import { timeFormat } from "./legadoJavaApi";
import { createBookVariableSync } from "./legadoRuleEntity";
import { getBookCustomVariable } from "../store/bookSourceStore";

function applyPersistedBookVariable(
  book: Record<string, unknown>,
  bookPageUrl: string,
): void {
  const persisted = getBookCustomVariable(bookPageUrl);
  if (persisted) {
    book.variable = persisted;
    return;
  }
  const raw = book.variable;
  const isEmptyObj =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw as Record<string, unknown>).length === 0;
  if (raw == null || raw === "" || isEmptyObj) {
    book.variable = null;
  }
}

/**
 * 对齐 Legado WebBook：getStrResponse 后跑 loginCheckJs（搜索/发现/详情/目录/正文均如此）。
 * 部分源用其识别反爬页（如含 `fffffffffffffffffff`）并 webView 刷新 Cookie。
 */
async function fetchWithLoginCheck(
  analyzeUrl: AnalyzeUrl,
  source: BookSourceRecord,
  key: string,
  logs: string[],
): Promise<StrResponse> {
  let res = await analyzeUrl.getStrResponse();
  if (!source.loginCheckJs?.trim()) return res;
  return runLoginCheckJs(analyzeUrl, source, res, key, logs);
}

function runJsLib(
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
): void {
  ensureBookSourceJsLib(source, host);
}

/** 详情页常见 Open Graph 小说 meta（书源未配 kind 或选择器未命中时兜底） */
const OG_NOVEL_KIND_RULES = [
  '[property="og:novel:category"]@content',
  '[property="og:novel:status"]@content',
] as const;

/** HTML 详情页才有 OG；JSON API 勿扫选择器 */
function contentAllowsOgMetaFallback(content: unknown): boolean {
  if (content != null && typeof content === "object" && !Array.isArray(content)) {
    return false;
  }
  if (typeof content === "string") {
    const t = content.trim();
    if (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    ) {
      return false;
    }
  }
  return true;
}

async function resolveOgMetaContent(
  ar: AnalyzeRule,
  property: string,
  mContent?: unknown,
): Promise<string> {
  const content = mContent ?? ar.currentContent;
  if (!contentAllowsOgMetaFallback(content)) return "";
  const list = await ar.getStringList(`[property="${property}"]@content`, mContent);
  for (const s of list) {
    const t = String(s ?? "").trim();
    if (t && !looksLikeUnresolvedKindRule(t)) return t;
  }
  return "";
}

async function resolveOgNovelKindParts(
  ar: AnalyzeRule,
  mContent?: unknown,
): Promise<string[]> {
  const content = mContent ?? ar.currentContent;
  if (!contentAllowsOgMetaFallback(content)) return [];
  const out: string[] = [];
  for (const rule of OG_NOVEL_KIND_RULES) {
    const list = await ar.getStringList(rule, mContent);
    for (const s of list) {
      const t = stripLegadoKindLabelNoise(s);
      if (t && !looksLikeUnresolvedKindRule(t)) out.push(t);
    }
  }
  return out;
}

/** 未解析的选择器/JsonPath 残留，不可展示为分类 tag */
function looksLikeUnresolvedKindRule(tag: string): boolean {
  const t = tag.trim();
  if (!t) return false;
  if (/^\$\.?\.?[\w[*]/.test(t) || /\{\{/.test(t)) return true;
  if (/\[property\s*=/i.test(t) || /@content\b/i.test(t)) return true;
  if (/^\[.+\]@/.test(t) || /^@@?css:/i.test(t) || /^@xpath:/i.test(t)) {
    return true;
  }
  return false;
}

/** 发现/搜索列表 kind：过滤评分、日期等 HTML 综合信息噪声（保留「都市」等分类） */
function shouldKeepExploreKindTag(tag: string): boolean {
  const t = tag.trim();
  if (!t) return false;
  if (/^\d+(\.\d+)?分$/.test(t)) return false;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(t)) return false;
  return true;
}

function isJsonExploreListItem(content: unknown): content is Record<string, unknown> {
  return isPlainRuleObject(content) && !isJsoupElementLike(content);
}

function isLikelyExploreAuthorName(author: string, bookName: string): boolean {
  const t = author.trim();
  if (!t) return false;
  if (bookName && t.includes(bookName)) return false;
  if (
    t.includes("综合信息") ||
    t.includes("简介") ||
    t.includes("作 者") ||
    t.includes("作者：")
  ) {
    return false;
  }
  if (/[\/\r\n]/.test(t)) return false;
  if (t.length > 24) return false;
  return true;
}

function cleanupExploreAuthorCandidate(raw: string, bookName: string): string {
  let t = formatLegadoBookAuthor(raw).trim();
  if (!t) return "";
  const direct = t.match(/作\s*者[:：]\s*([^\s/|｜]+)/);
  if (direct?.[1]) return direct[1].trim();
  if (bookName && t.includes(bookName)) {
    t = t.replace(bookName, " ").trim();
  }
  if (/[\/|｜]/.test(t)) {
    const left = t.split(/[\/|｜]/)[0]?.trim() ?? "";
    if (left) {
      const tokens = left.split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1] ?? "";
      if (last) return last.trim();
    }
  }
  if (t.includes("综合信息")) {
    t = t.replace(/综合信息[\s\S]*$/u, "").trim();
  }
  const m = t.match(/([^\s/|｜]{1,24})$/u);
  return m?.[1]?.trim() ?? "";
}

async function resolveExploreListAuthor(
  ar: AnalyzeRule,
  rule: string | undefined | null,
  el: unknown,
  bookName: string,
): Promise<string> {
  const primary = rule?.trim() ?? "";
  let author = "";
  if (primary) {
    author = cleanupExploreAuthorCandidate(await ar.getString(primary, el), bookName);
    if (isLikelyExploreAuthorName(author, bookName)) return author;
  }

  const fallbacks = isJsonExploreListItem(el)
    ? ["$.authorName", "$.AuthorName", "$.data.authorName", "authorName", "AuthorName"]
    : [
        "a[id][target]@text",
        "tag.li.1@tag.a.1@text",
        "tag.li.1@text##.+综合信息：\\s*([^\\/]+).*##$1",
      ];
  for (const fb of fallbacks) {
    if (fb === primary) continue;
    author = cleanupExploreAuthorCandidate(await ar.getString(fb, el), bookName);
    if (isLikelyExploreAuthorName(author, bookName)) return author;
  }
  return "";
}

/** API 列表项 kind 仅含 sysTags 时补上 expand.typeName（对齐 Legado 主分类 tag） */
function prependJsonExploreTypeName(
  parts: string[],
  content: unknown,
): string[] {
  if (!isJsonExploreListItem(content)) return parts;
  const expand = content.expand;
  if (expand == null || typeof expand !== "object" || Array.isArray(expand)) {
    return parts;
  }
  const typeName = String((expand as Record<string, unknown>).typeName ?? "").trim();
  if (!typeName) return parts;
  if (!parts.length) return [typeName];
  if (parts.includes(typeName)) return parts;
  return [typeName, ...parts];
}

/** ruleBookInfo / ruleSearch.kind：含 {{java.*}}、{{$..path}} 等复合表达式时走详情专用解析 */
async function resolveBookInfoKindParts(
  ar: AnalyzeRule,
  rule: string | undefined | null,
  mContent?: unknown,
): Promise<string[]> {
  const trimmed = rule?.trim();
  const saved = ar.currentContent;
  if (mContent !== undefined) {
    ar.setContent(mContent, ar.currentBaseUrl);
  }
  const finalizeKindParts = (parts: string[]) =>
    prependJsonExploreTypeName(
      parts
        .map(stripLegadoKindLabelNoise)
        .filter((t) => t && !looksLikeUnresolvedKindRule(t) && shouldKeepExploreKindTag(t)),
      mContent ?? saved,
    );
  try {
    if (!trimmed) {
      return finalizeKindParts(await resolveOgNovelKindParts(ar, mContent ?? saved));
    }
    const { baseRule } = splitRuleRegexSuffix(trimmed);

    let parts: string[] = [];
    if (!bookInfoSelectorNeedsCompositeResolver(baseRule)) {
      // 直接按完整规则解析：避免 `&& ... ##` 在 AnalyzeRule 已处理后再次套 regex
      // 导致分类 tag（如「都市」）被二次替换清空。
      parts = finalizeKindParts(await ar.getStringList(trimmed, mContent ?? saved));
    } else {
      const useBookInfoResolver =
        (containsCompositeEvalRule(trimmed) &&
          !/^@js:/i.test(trimmed) &&
          !/^<js>/i.test(trimmed)) ||
        trimmed.includes("@get:");
      if (useBookInfoResolver) {
        const raw = (await resolveBookInfoField(ar, trimmed)).trim();
        parts = raw ? finalizeKindParts(splitBookMetaTags(raw)) : [];
      } else {
        parts = finalizeKindParts(await ar.getStringList(trimmed, mContent ?? saved));
      }
    }
    if (parts.length) return parts;
    // 规则未命中时再试 og:novel（镜像站书源常漏配 kind）
    return finalizeKindParts(await resolveOgNovelKindParts(ar, mContent ?? saved));
  } finally {
    if (mContent !== undefined) {
      ar.setContent(saved, ar.currentBaseUrl);
    }
  }
}

function warnSuspiciousKindTags(
  kindParts: string[],
  logs: string[],
  sourceName: string,
): void {
  for (const tag of kindParts) {
    const t = tag.trim();
    if (looksLikeUnresolvedKindRule(t)) {
      logs.push(`[${sourceName}] 分类标签未正确解析: ${t}`);
    }
  }
}

function isJsonSearchBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function isJsonIntroRule(rule: string): boolean {
  const t = rule.trim();
  return (
    t.startsWith("$.") ||
    t.startsWith("$[") ||
    t.startsWith("$..") ||
    /^@json:/i.test(t)
  );
}

/** 搜索页补拉简介上限，避免对 API 书源触发过多详情请求 */
const SEARCH_INTRO_FILL_MAX = 24;

/** JSON 搜索列表无 intro 规则时，按 ruleBookInfo 逐条补拉详情简介（如 SF/安轻 API 书源） */
async function fillSearchIntrosFromBookInfo(
  source: BookSourceRecord,
  items: SearchBookItem[],
  listRule: BookListRuleBlock,
  searchBody: unknown,
  host: ReturnType<typeof createJsExtensionHost>,
  logs: string[],
): Promise<void> {
  if (listRule.intro?.trim()) return;
  const infoIntroRule = source.ruleBookInfo?.intro?.trim();
  if (!infoIntroRule || !isJsonIntroRule(infoIntroRule)) return;
  if (!isJsonSearchBody(searchBody)) return;

  const pending = items
    .filter((item) => !item.intro?.trim() && /^https?:\/\//i.test(item.bookUrl))
    .slice(0, SEARCH_INTRO_FILL_MAX);
  if (!pending.length) return;

  const silentHost = createJsExtensionHost(source, []);

  for (const item of pending) {
    const urlStr = ensureBookUrlWithHeaders(item.bookUrl, host);
    try {
      const res = await new AnalyzeUrl({
        mUrl: urlStr,
        baseUrl: source.bookSourceUrl,
        source,
        host: silentHost,
      }).getStrResponse();
      const body = res.body?.trim() ?? "";
      if (!body) continue;

      const detailAr = new AnalyzeRule(source, logs, host)
        .setContent(body, item.bookUrl)
        .setBook({ name: item.name, author: item.author, bookUrl: item.bookUrl });
      const introRaw = trimLegadoAsciiWhitespace(
        await resolveBookInfoField(detailAr, infoIntroRule),
      );
      const intro = formatLegadoBookIntro(introRaw);
      if (intro) item.intro = intro;
    } catch {
      /* 补拉失败静默跳过，不影响搜索主流程 */
    }
  }
}

/** 简介规则误取到分类 tag 时，回退到 .book-intro / .introduce */
function isLegadoGetIntroRule(rule: string | undefined): boolean {
  return Boolean(rule?.trim() && /@get:\{?\s*intro\s*\}?/i.test(rule));
}

async function resolveBookIntroText(
  ar: AnalyzeRule,
  introRule: string | undefined,
  kindParts: string[],
): Promise<string> {
  let introRaw = trimLegadoAsciiWhitespace(
    await resolveBookInfoField(ar, introRule),
  );
  if (!introRaw && introRule?.includes(".introduce")) {
    introRaw = trimLegadoAsciiWhitespace(
      await ar.getPlainString(".introduce@html"),
    );
  }
  let intro = formatLegadoBookIntro(introRaw);
  if (!intro || !kindParts.length || isLegadoGetIntroRule(introRule)) return intro;
  const lines = intro.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return intro;
  const kindSet = new Set(kindParts.map((k) => k.trim()).filter(Boolean));
  if (!lines.every((l) => kindSet.has(l))) return intro;
  for (const altRule of [
    ".book-info@.book-intro@html",
    ".introduce@html",
  ]) {
    const altRaw = (await ar.getPlainString(altRule)).trim();
    if (!altRaw) continue;
    const alt = formatLegadoBookIntro(altRaw);
    if (alt) return alt;
  }
  return intro;
}

export async function searchBook(
  source: BookSourceRecord,
  key: string,
  page = 1,
  logs: string[] = [],
): Promise<SearchBookItem[]> {
  const searchUrl = source.searchUrl?.trim();
  if (!searchUrl) throw new Error("搜索 url 不能为空");
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const ruleVariables: Record<string, string> = {};
  const analyzeUrl = new AnalyzeUrl({
    mUrl: searchUrl,
    key,
    page,
    baseUrl: source.bookSourceUrl,
    source,
    host,
    logs,
    ruleVariables,
  });
  let res: StrResponse;
  try {
    if (source.loginCheckJs?.trim()) {
      res = await fetchWithLoginCheck(analyzeUrl, source, key, logs);
    } else {
      res = await analyzeUrl.getStrResponse();
      res = await awaitLoginForSearchPage(source, res, analyzeUrl, logs);
    }
  } catch (e) {
    if (isVerificationCancelled(e)) {
      logs.push("用户取消登录，跳过该书源");
      return [];
    }
    throw e;
  }
  if (!res.body?.trim()) {
    logs.push(
      `[search] 接口返回空响应 (HTTP ${res.statusCode ?? "?"})。` +
        "番茄等源需有效 X-Gorgon 签名；若 Legado 可用而此处不行，可能是接口校验升级或需填写登录 Token",
    );
    return [];
  }
  // Legado：isRedirect = res.raw.priorResponse?.isRedirect；无 priorResponse 时用最终 URL 与请求 URL 比较
  const isRedirect = Boolean(
    res.url?.trim() &&
      analyzeUrl.url?.trim() &&
      normalizeHttpUrlPath(res.url) !== normalizeHttpUrlPath(analyzeUrl.url),
  );
  return await analyzeBookList(
    source,
    res.body,
    res.url,
    analyzeUrl.url,
    analyzeUrl.ruleUrl,
    ruleVariables,
    logs,
    host,
    "search",
    res.statusCode,
    isRedirect,
  ).catch((e) => {
    if (isVerificationCancelled(e)) {
      logs.push("用户取消登录，跳过该书源");
      return [];
    }
    appendBookSourceErrorLog(logs, e, {
      phase: "搜索列表解析",
      sourceName: source.bookSourceName,
      sourceUrl: source.bookSourceUrl,
      url: analyzeUrl.url,
      extra: `关键词: ${key}，页码: ${page}`,
    });
    throw e;
  });
}

export async function exploreBook(
  source: BookSourceRecord,
  exploreCategoryUrl: string,
  page = 1,
  logs: string[] = [],
): Promise<SearchBookItem[]> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const ruleVariables: Record<string, string> = {};
  const analyzeUrl = new AnalyzeUrl({
    mUrl: exploreCategoryUrl,
    page,
    baseUrl: source.bookSourceUrl,
    source,
    host,
    logs,
    ruleVariables,
  });
  let res: StrResponse;
  try {
    // 对齐 Legado exploreBookAwait：仅 loginCheckJs；无检查脚本时不弹登录启发式
    // （否则站点导航 `class="login-info"` 等会误判登录墙，如部分站点发现分类）
    if (source.loginCheckJs?.trim()) {
      res = await fetchWithLoginCheck(analyzeUrl, source, "", logs);
    } else {
      res = await analyzeUrl.getStrResponse();
    }
  } catch (e) {
    if (isVerificationCancelled(e)) {
      logs.push("用户取消登录，跳过该书源");
      return [];
    }
    throw e;
  }
  const isRedirect = Boolean(
    res.url?.trim() &&
      analyzeUrl.url?.trim() &&
      normalizeHttpUrlPath(res.url) !== normalizeHttpUrlPath(analyzeUrl.url),
  );
  return analyzeBookList(
    source,
    res.body,
    res.url,
    analyzeUrl.url,
    analyzeUrl.ruleUrl,
    ruleVariables,
    logs,
    host,
    "explore",
    res.statusCode,
    isRedirect,
  ).catch((e) => {
    if (isVerificationCancelled(e)) {
      logs.push("用户取消登录，跳过该书源");
      return [];
    }
    appendBookSourceErrorLog(logs, e, {
      phase: "发现列表解析",
      sourceName: source.bookSourceName,
      sourceUrl: source.bookSourceUrl,
      url: exploreCategoryUrl,
      extra: `页码: ${page}`,
    });
    throw e;
  });
}

type BookListRuleBlock = NonNullable<BookSourceRecord["ruleSearch"]>;

async function analyzeBookList(
  source: BookSourceRecord,
  body: string,
  baseUrl: string,
  requestUrl: string,
  ruleUrl: string,
  ruleVariables: Record<string, string>,
  logs: string[],
  host: ReturnType<typeof createJsExtensionHost>,
  mode: "search" | "explore" = "search",
  statusCode?: number,
  isRedirect = false,
): Promise<SearchBookItem[]> {
  let rule: BookListRuleBlock;
  if (mode === "explore") {
    const exploreRule = source.ruleExplore;
    rule =
      exploreRule?.bookList?.trim()
        ? exploreRule
        : (source.ruleSearch ?? {});
  } else {
    rule = source.ruleSearch ?? {};
  }
  if (!rule?.bookList) return [];
  const ar = new AnalyzeRule(source, logs, host)
    .setContent(body, baseUrl)
    .setRequestContext(ruleUrl, requestUrl || baseUrl)
    .setRuleData({ variable: ruleVariables });
  if (source.bookUrlPattern?.trim()) {
    try {
      // 对齐 Legado BookList：仅搜索走 bookUrlPattern→详情；发现分类 URL 常与详情同形，勿误判
      if (mode === "search" && new RegExp(source.bookUrlPattern).test(baseUrl)) {
        logs.push("链接为详情页，按 ruleBookInfo 解析");
        const item = await parseInfoSearchItem(
          source,
          ar,
          body,
          baseUrl,
          requestUrl,
          ruleUrl,
          logs,
          isRedirect,
        );
        return item ? [item] : [];
      }
    } catch {
      /* ignore invalid pattern */
    }
  }
  let bookListRule = rule.bookList;
  let reverse = false;
  if (bookListRule.startsWith("-")) {
    reverse = true;
    bookListRule = bookListRule.slice(1);
  }
  if (bookListRule.startsWith("+")) {
    bookListRule = bookListRule.slice(1);
  }
  const elements = await ar.getElements(bookListRule, body);
  if (elements.length === 0) {
    const httpHint =
      statusCode != null && statusCode !== 200
        ? `，HTTP ${statusCode}`
        : "";
    logs.push(
      `[${mode}] bookList 未解析到书籍条目（请求 ${requestUrl || baseUrl}${httpHint}）`,
    );
  }
  const items: SearchBookItem[] = [];
  if (elements.length === 0 && !source.bookUrlPattern?.trim()) {
    logs.push("列表为空，按详情页解析（ruleBookInfo）");
    const item = await parseInfoSearchItem(
      source,
      ar,
      body,
      baseUrl,
      requestUrl,
      ruleUrl,
      logs,
      isRedirect,
    );
    if (item) items.push(item);
    return items;
  }
  for (const el of elements) {
    const item = await parseSearchItem(
      source,
      ar,
      el,
      baseUrl,
      requestUrl,
      items.length,
      rule,
      logs,
    );
    if (item) items.push(item);
  }
  if (reverse) items.reverse();
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const k = `${item.name}::${item.author}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await fillSearchIntrosFromBookInfo(source, deduped, rule, body, host, logs);
  return deduped;
}

/**
 * 列表为空或链接即详情页时，按 ruleBookInfo 解析（对齐 Legado BookList.getInfoItem）。
 * `isRedirect`：重定向时用最终 `baseUrl`；否则用 `getAbsoluteURL(analyzeUrl.url, ruleUrl)`
 *（`ruleUrl` 可含 POST UrlOption，勿剥成无选项的裸路径）。
 */
async function parseInfoSearchItem(
  source: BookSourceRecord,
  ar: AnalyzeRule,
  body: unknown,
  baseUrl: string,
  requestUrl: string,
  ruleUrl: string,
  logs: string[],
  isRedirect = false,
): Promise<SearchBookItem | null> {
  const rule = source.ruleBookInfo ?? {};
  ar.setContent(body, baseUrl).setRedirectUrl(baseUrl);
  if (rule.init?.trim()) {
    const initEl = await ar.getElement(rule.init);
    if (initEl != null) ar.setContent(initEl, baseUrl);
  }
  const nameRaw = (await resolveBookInfoField(ar, rule.name)).trim();
  const name = formatLegadoBookName(nameRaw);
  if (!name || isLikelyBadDetailName(name)) return null;
  const authorRaw = (await resolveBookInfoField(ar, rule.author)).trim();
  const author =
    authorRaw && !isLikelyBadDetailName(authorRaw)
      ? formatLegadoBookAuthor(authorRaw) || "未知"
      : "未知";
  const displayName = stripEmbeddedAuthorFromDetailName(name, author);
  // Legado: if (isRedirect) baseUrl else NetworkUtils.getAbsoluteURL(analyzeUrl.url, analyzeUrl.ruleUrl)
  const bookUrl = isRedirect
    ? baseUrl
    : resolveAbsoluteUrl(
        requestUrl || normalizeBookSourceBaseUrl(source.bookSourceUrl),
        ruleUrl,
      ) || baseUrl;
  const kindParts = await resolveBookInfoKindParts(ar, rule.kind);
  const kind = kindParts.length ? kindParts.join(",") : undefined;
  const rawWordCount = await resolveBookInfoField(ar, rule.wordCount);
  const wordCount = wordCountFormat(rawWordCount) || undefined;
  const introRaw = await resolveBookInfoField(ar, rule.intro);
  const intro = formatLegadoBookIntro(introRaw) || undefined;
  const rawCover = await resolveBookInfoField(ar, rule.coverUrl);
  const coverFetchRaw =
    rawCover.trim() ||
    (await resolveOgMetaContent(ar, "og:image")) ||
    "";
  const coverSourceUrl =
    resolveCoverSourceUrl(source, coverFetchRaw, baseUrl, logs) ?? undefined;
  const coverUrl =
    (coverSourceUrl
      ? await resolveBookCoverDisplayUrl(source, coverFetchRaw, baseUrl, logs)
      : undefined) ?? undefined;
  const lastChapter =
    formatLegadoLastChapterDisplay(await resolveBookInfoField(ar, rule.lastChapter)) ||
    undefined;
  const infoHtml = typeof body === "string" && body.trim() ? body : undefined;
  // 对齐 Legado getInfoItem → BookInfo：tocUrl 用 res.url 作 redirectUrl（可含重定向后的书籍页）
  ar.setRedirectUrl(baseUrl);
  ar.setBook({
    name: displayName,
    author,
    bookUrl,
    tocUrl: "",
    kind: kind ?? "",
  });
  let tocUrl = "";
  if (rule.tocUrl?.trim()) {
    const rawToc = (await resolveBookInfoField(ar, rule.tocUrl)).trim();
    if (rawToc && !/^@js:/i.test(rawToc) && !/^<js>/i.test(rawToc)) {
      if (/,\s*\{/.test(rawToc)) {
        tocUrl = ar.resolveAbsoluteRuleUrl(rawToc);
      } else {
        const first =
          rawToc
            .split(/[\r\n]+/)
            .map((s) => s.trim())
            .find(Boolean) ?? "";
        tocUrl = first ? ar.resolveAbsoluteRuleUrl(first) : "";
      }
    }
  }
  if (!tocUrl.trim()) tocUrl = baseUrl;
  // 仍是搜索址时，尝试从详情 HTML 章节链接推断书籍目录页
  if (infoHtml && isLikelySearchArticleUrl(tocUrl)) {
    const inferred = inferBookDirUrlFromDetailHtml(infoHtml, baseUrl || bookUrl);
    if (inferred) tocUrl = inferred;
  }
  return {
    id: `${source.bookSourceUrl}::${bookUrl}::info`,
    name: displayName,
    author,
    kind,
    wordCount,
    lastChapter,
    intro,
    coverUrl,
    coverSourceUrl,
    bookUrl,
    origin: source.bookSourceUrl,
    originName: source.bookSourceName,
    infoHtml,
    infoUrl: baseUrl || undefined,
    tocUrl: tocUrl || undefined,
  };
}

/**
 * 对齐 Legado `BookList.getSearchItem` 字段顺序：
 * name → author → kind → wordCount → lastChapter → intro → coverUrl → bookUrl
 *（kind 须在 bookUrl 之前写入 AnalyzeRule.book，供 `{{book.kind}}` 使用）
 */
async function parseSearchItem(
  source: BookSourceRecord,
  ar: AnalyzeRule,
  el: unknown,
  baseUrl: string,
  requestUrl: string,
  index: number,
  rule: BookListRuleBlock,
  logs: string[],
): Promise<SearchBookItem | null> {
  const savedContent = ar.currentContent;
  const savedBaseUrl = ar.currentBaseUrl;
  ar.setContent(el, baseUrl);
  try {
    const name = await ar.getString(rule.name, el);
    if (!name) return null;
    const author =
      (await resolveExploreListAuthor(ar, rule.author, el, name)) || "未知";

    const kindParts = await resolveBookInfoKindParts(ar, rule.kind, el);
    warnSuspiciousKindTags(kindParts, logs, source.bookSourceName);
    const kind = kindParts.length ? kindParts.join(",") : undefined;

    // 先绑定 name/author/kind，再解析后续依赖 book.* 的字段（对齐 Legado setRuleData）
    ar.setBook({ name, author, kind: kind ?? "" });

    const rawWordCount = await ar.getString(rule.wordCount, el);
    const wordCount = wordCountFormat(rawWordCount) || undefined;
    const lastChapter =
      formatLegadoLastChapterDisplay(await ar.getString(rule.lastChapter, el)) ||
      undefined;

    const introRaw = trimLegadoAsciiWhitespace(await ar.getString(rule.intro, el));
    const intro = introRaw ? formatLegadoBookIntro(introRaw) || undefined : undefined;

    // 列表不预拉封面（搜索/发现条目多）；由渲染侧 useBookshelfCoverUrls 懒解析
    const rawCover = await ar.getUrl(rule.coverUrl ?? "", el);
    const coverSourceUrl =
      resolveCoverSourceUrl(source, rawCover, baseUrl, logs) ?? undefined;
    const coverUrl = coverSourceUrl;

    const hasBookUrlRule = Boolean(rule.bookUrl?.trim());
    let bookUrl = await ar.getUrl(rule.bookUrl ?? "", el);
    if (!bookUrl) {
      if (hasBookUrlRule) {
        logs.push(
          `[${source.bookSourceName}] 「${name}」详情 URL 规则解析失败（请查看 JS 错误）`,
        );
        return null;
      }
      bookUrl = requestUrl || baseUrl;
    }
    if (hasBookUrlRule && (bookUrl.includes("@js:") || bookUrl.includes("<js>"))) {
      logs.push(
        `[${source.bookSourceName}] 「${name}」详情 URL 未正确执行 JS 规则，已跳过`,
      );
      return null;
    }

    ar.setBook({ name, author, kind: kind ?? "", bookUrl });

    // @put（如 bookUrl 前的 id）须随条目带走，勿只留在书源级 cache（会被下一条覆盖）
    const putVars = ar.getStoredVariables();
    const variable = Object.keys(putVars).length ? { ...putVars } : undefined;

    return {
      id: `${source.bookSourceUrl}::${bookUrl}::${index}`,
      name,
      author,
      kind,
      wordCount,
      lastChapter,
      intro,
      coverUrl,
      coverSourceUrl,
      bookUrl,
      origin: source.bookSourceUrl,
      originName: source.bookSourceName,
      variable,
    };
  } finally {
    ar.setContent(savedContent, savedBaseUrl);
  }
}

export type { Book, BookChapter };

function ensureBookUrlWithHeaders(
  bookUrl: string,
  host: ReturnType<typeof createJsExtensionHost>,
): string {
  if (extractUrlFetchOptionsSuffix(bookUrl)) {
    const { url: path } = splitUrlAndRuleVariables(bookUrl);
    const suffix = extractUrlFetchOptionsSuffix(bookUrl);
    return `${normalizeHttpUrlPath(path)}${suffix}`;
  }
  const get = host.javaBindings.get as ((k: string) => string) | undefined;
  const stored = get?.("headers")?.trim() ?? "";
  if (!stored) return normalizeHttpUrlPath(bookUrl);
  const { url: path } = splitUrlAndRuleVariables(bookUrl);
  const raw = stored.startsWith("{") ? stored : `{${stored}}`;
  const opts = parseLegadoUrlSuffixJson(raw);
  const tail = opts.headers
    ? JSON.stringify({ headers: opts.headers })
    : raw;
  return `${normalizeHttpUrlPath(path)},${tail}`;
}

/** 从 UrlOption POST body 取出 bookId */
function extractJsonBookIdFromUrlOption(url: string): string {
  const suffix = extractUrlFetchOptionsSuffix(url);
  if (!suffix.startsWith(",")) return "";
  const opts = parseLegadoUrlSuffixJson(suffix.slice(1).trim());
  const body = opts.body?.trim() ?? "";
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { bookId?: unknown };
    const id = parsed.bookId;
    if (id != null && String(id).trim()) return String(id).trim();
  } catch {
    /* body 可能仍带未展开模板 */
  }
  return body.match(/"bookId"\s*:\s*"(\d+)"/)?.[1] ?? "";
}

/**
 * 部分书源：`Params="bid="+hash` 再拼进 `…&bid="+Params`，query 实为 `bid=bid=hash`。
 * 裸捕获 `bid=([^&]+)` 会得到 `bid=hash`，再拼章节 URL 变成 `bid=bid=hash` → 接口「无此书」。
 */
function normalizeStoredBidValue(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  while (/^(?:bid|id|bookid|book_id)=/i.test(s)) {
    s = s.replace(/^(?:bid|id|bookid|book_id)=/i, "").trim();
  }
  return s;
}

/**
 * 从详情/目录 URL 推断 bid；已有本书/规则链上的 bid 则不覆盖（仅规范化错误前缀）。
 * 勿把书源 cache 里其它书的 @put bid 当成「已有」（书架直开正文会串书 id）。
 */
function ensureBidVariable(
  ar: AnalyzeRule,
  variables: Record<string, string>,
  book?: { variable?: unknown } | null,
  ...urls: string[]
): void {
  const syncBid = (bid: string) => {
    ar.putStored("bid", bid);
    variables.bid = bid;
    if (!book) return;
    const raw = book.variable;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      (raw as Record<string, string>).bid = bid;
      return;
    }
    if (raw == null || raw === "") {
      book.variable = { bid };
    }
  };

  const bidFromVariable = (raw: unknown): string => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return String((raw as Record<string, string>).bid ?? "").trim();
    }
    if (typeof raw === "string" && raw.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return String(parsed.bid ?? "").trim();
      } catch {
        return "";
      }
    }
    return "";
  };

  const existingRaw =
    bidFromVariable(book?.variable) ||
    String(variables.bid ?? "").trim() ||
    String(ar.getStoredVariables().bid ?? "").trim();
  if (existingRaw) {
    const normalized = normalizeStoredBidValue(existingRaw);
    if (normalized) syncBid(normalized);
    return;
  }
  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!url) continue;
    const pathId = url.match(/\/chapters\/([^/?#,]+)/i)?.[1];
    const queryId =
      url.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      url.match(/[?&]bookId=([^&]+)/i)?.[1] ??
      url.match(/[?&](?:id|bid|bookid)=([^&]+)/i)?.[1];
    const bid = normalizeStoredBidValue(pathId || queryId || "");
    if (!bid) continue;
    syncBid(bid);
    return;
  }
}

/**
 * 仅当 book.kind 为空时从 tocUrl/bookUrl 兜底（正常路径靠详情/列表已干净的 kind）。
 */
export function resolveBookKindForChapterRules(
  kind: string | undefined,
  tocUrl: string,
  bookUrl: string,
): string {
  const fromKind = kind?.trim();
  if (fromKind) return stripNumericIdPrefix(fromKind);
  const fromToc =
    tocUrl.match(/[?&]bookId=([^&]+)/i)?.[1] ??
    tocUrl.match(/[?&]book_id=([^&]+)/i)?.[1];
  if (fromToc?.trim()) {
    return stripNumericIdPrefix(decodeURIComponent(fromToc.trim()));
  }
  const fromBookUrl =
    bookUrl.match(/[?&](?:bookId|book_id|resourceId)=([^&]+)/i)?.[1];
  if (fromBookUrl?.trim()) {
    return stripNumericIdPrefix(decodeURIComponent(fromBookUrl.trim()));
  }
  return "";
}

/**
 * 目录阶段未带 kind 时，章节 URL 里 BookID 可能为空或带 90000001_。
 * 拉取正文前用短 id 回填。
 */
export function repairChapterUrlBookId(chapterUrl: string, bookId: string): string {
  const id = stripNumericIdPrefix(bookId);
  if (!id || !/ads-read/i.test(chapterUrl)) return chapterUrl;
  // 仅接受纯数字 bookId（kind 标签如「9.5分」不能写入 BookID）
  if (!/^\d+$/.test(id)) return chapterUrl;
  const comma = chapterUrl.search(/,\s*\{/);
  if (comma < 0) return chapterUrl;
  const urlPart = chapterUrl.slice(0, comma);
  const optRaw = chapterUrl.slice(comma + 1).replace(/^\s*/, "");
  let opts: Record<string, unknown>;
  try {
    opts = JSON.parse(optRaw) as Record<string, unknown>;
  } catch {
    return chapterUrl;
  }
  const body = opts.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const bodyObj = body as Record<string, unknown>;
    const batch = bodyObj.ContentAnchorBatch;
    if (!Array.isArray(batch)) return chapterUrl;
    let changed = false;
    const nextBatch = batch.map((item) => {
      if (!item || typeof item !== "object") return item;
      const row = { ...(item as Record<string, unknown>) };
      const cur = row.BookID;
      const curStr = cur == null ? "" : String(cur);
      if (!curStr || curStr.includes("_") || !/^\d+$/.test(curStr)) {
        changed = true;
        row.BookID = id;
      }
      return row;
    });
    if (!changed) return chapterUrl;
    return `${urlPart},${JSON.stringify({
      ...opts,
      body: { ...bodyObj, ContentAnchorBatch: nextBatch },
    })}`;
  }
  if (typeof body !== "string" || !body.includes("BookID")) return chapterUrl;
  const nextBody = body.replace(
    /"BookID"\s*:\s*(?:""|null|"[^"]*")/,
    `"BookID":"${id}"`,
  );
  if (nextBody === body) return chapterUrl;
  return `${urlPart},${JSON.stringify({ ...opts, body: nextBody })}`;
}

/** 修正已缓存章节 URL 中的 `bid=bid=hash`（query 与 form body） */
export function repairDuplicateBidInChapterUrl(chapterUrl: string): string {
  const stripDupBid = (s: string) =>
    s.replace(/([?&]bid=)(?:bid=)+/gi, "$1").replace(
      /(^|&)bid=(?:bid=)+/gi,
      "$1bid=",
    );
  const comma = chapterUrl.search(/,\s*\{/);
  if (comma < 0) return stripDupBid(chapterUrl);
  const urlPart = stripDupBid(chapterUrl.slice(0, comma));
  const optRaw = chapterUrl.slice(comma + 1).replace(/^\s*/, "");
  try {
    const opts = JSON.parse(optRaw) as Record<string, unknown>;
    if (typeof opts.body === "string" && /bid=bid=/i.test(opts.body)) {
      opts.body = stripDupBid(opts.body);
      return `${urlPart},${JSON.stringify(opts)}`;
    }
  } catch {
    /* keep */
  }
  return urlPart === chapterUrl.slice(0, comma)
    ? chapterUrl
    : `${urlPart},${optRaw}`;
}

function syncLegadoHeadersForRules(
  ar: AnalyzeRule,
  host: ReturnType<typeof createJsExtensionHost>,
  bookUrl: string,
  variables: Record<string, string>,
): void {
  let wrapped = "";
  const split = splitUrlFetchOptions(bookUrl);
  if (split.options.headers && Object.keys(split.options.headers).length > 0) {
    wrapped = JSON.stringify({ headers: split.options.headers });
  } else if (variables.headers) {
    try {
      const parsed = JSON.parse(variables.headers) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "headers" in (parsed as Record<string, unknown>)
      ) {
        wrapped = variables.headers;
      } else {
        wrapped = JSON.stringify({ headers: parsed });
      }
    } catch {
      wrapped = variables.headers;
    }
  }
  if (!wrapped) {
    const get = host.javaBindings.get as ((k: string) => string) | undefined;
    const fromStore = get?.("headers") ?? "";
    if (fromStore) wrapped = fromStore;
  }
  if (!wrapped) return;
  ar.putStored("headers", wrapped);
  const put = host.javaBindings.put as ((k: string, v: unknown) => string) | undefined;
  put?.("headers", wrapped);
  variables.headers = wrapped;
}

/** API 书源：updateTime 规则为空时从 update_time 或 lastChapter 拼接段提取 */
function resolveBookUpdateTimeFallback(
  ar: AnalyzeRule,
  lastChapterRaw: string,
): string {
  const content = ar.currentContent;
  if (isPlainRuleObject(content)) {
    const raw = readJsonField(content, "update_time").trim();
    const ts = Number(raw);
    if (Number.isFinite(ts) && ts > 0) {
      return timeFormat(ts > 1e12 ? ts : ts * 1000);
    }
  }
  const m = lastChapterRaw.match(
    /[·•]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
  );
  if (m?.[1]) return m[1].replace(/-/g, "/");
  const fromIntro = lastChapterRaw.match(
    /更新时间[：:]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
  );
  if (fromIntro?.[1]) return fromIntro[1].replace(/-/g, "/");
  return "";
}

function isLikelyBadDetailName(parsed: string): boolean {
  const p = parsed.trim().toLowerCase();
  if (!p) return true;
  return /404|not\s*found|403|500|502|503|bad gateway|error|禁止|拒绝|异常/.test(p);
}

/** 对齐 Legado：已有搜索书名/作者时，未配 canReName 则详情不覆盖 */
function bookInfoHasName(name: string | undefined | null): boolean {
  return Boolean(name?.trim());
}

function bookInfoHasAuthor(author: string | undefined | null): boolean {
  const a = author?.trim() ?? "";
  return Boolean(a) && a !== "未知";
}

function bookInfoLooksEmpty(body: string): boolean {
  const t = body.trim();
  if (!t.startsWith("{")) return !t;
  try {
    const j = JSON.parse(t) as {
      data?: { bookInfo?: { resourceName?: string; author?: string; summary?: string } };
    };
    const info = j.data?.bookInfo;
    if (!info) return true;
    return !String(info.resourceName ?? "").trim() && !String(info.author ?? "").trim();
  } catch {
    return false;
  }
}

function bookInfoInitFailed(body: string, initRule?: string | null): boolean {
  const t = body.trim();
  if (!t) return true;
  if (t.startsWith("<") && /404|not\s*found|error/i.test(t.slice(0, 800))) return true;
  const init = initRule?.trim() ?? "";
  if (!init) return false;
  // JS init（如 `<js>…</js>`）由 init 规则处理，不能按 JSONPath 校验
  if (/^<js>/i.test(init) || /^@js:/i.test(init)) {
    // data:;base64 + UrlOption.type 会先得到 hex 正文，交由 init JS hexDecode，不能当失败
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return false;
    // SPA hash 书链（如 example.com/#!/…）请求不到片段，只会拿到站点 HTML；
    // init 常只用 java.get('bid') 拼 tocUrl，不依赖正文 → 勿当失败
    if (!t.startsWith("{") && !t.startsWith("[")) {
      if (!t) return true;
      if (t.startsWith("<") && /404|not\s*found|error/i.test(t.slice(0, 800))) {
        return true;
      }
      return false;
    }
    try {
      const data = JSON.parse(t) as Record<string, unknown>;
      const meta = data.meta as Record<string, unknown> | undefined;
      if (meta?.status != null && Number(meta.status) !== 200) return true;
      const code = data.code;
      if (code != null && Number(code) !== 0 && Number(code) !== 200) return true;
      return false;
    } catch {
      return true;
    }
  }
  if (!t.startsWith("{")) return false;
  try {
    const data = JSON.parse(t) as Record<string, unknown>;
    if (init.startsWith("$.") || init.startsWith("$[")) {
      const nested = readJsonNestedValue(data, init);
      return nested == null || nested === "" || typeof nested !== "object";
    }
    const path = init.replace(/^\$\.?/, "").split(".").filter(Boolean);
    let cur: unknown = data;
    for (const key of path) {
      if (cur == null || typeof cur !== "object") return true;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur == null || typeof cur !== "object";
  } catch {
    return true;
  }
}

function tryParseJsonBookInfoContent(body: string): unknown {
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return body;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return body;
  }
}

/**
 * ruleBookInfo.init 可能返回 JSON 子对象（如 data.book），不可 String() 成 [object Object]。
 * 对齐 Legado BookInfo：先 `setContent(body)`（字符串），再跑 init——部分书源 jsLib
 * 的 `isHtmlString(result)` / `isJsonString(result)` 假定 result 是字符串，
 * 若预解析成对象会抛 `str.startsWith is not a function`，init 整段失败。
 */
async function applyBookInfoInitContent(
  ar: AnalyzeRule,
  initRule: string | undefined | null,
  body: string,
  base: string,
): Promise<void> {
  const init = initRule?.trim() ?? "";
  if (!init) {
    ar.setContent(tryParseJsonBookInfoContent(body), base);
    return;
  }

  // Legado：init 入参为原始响应字符串
  ar.setContent(body, base);
  let initEl = await ar.getElement(init, body);
  if (initEl == null || initEl === "") {
    const parsed = tryParseJsonBookInfoContent(body);
    if (isPlainRuleObject(parsed)) {
      const nested = readJsonNestedValue(parsed, init);
      if (nested != null && nested !== "") initEl = nested;
    }
  }
  if (initEl == null || initEl === "") {
    // init 失败：仍用解析后的 JSON 供后续字段规则（对齐「正文仍是响应体」）
    ar.setContent(tryParseJsonBookInfoContent(body), base);
    return;
  }

  if (typeof initEl === "object") {
    ar.setContent(initEl, base);
    return;
  }

  const text = typeof initEl === "string" ? initEl : String(initEl);
  ar.setContent(tryParseJsonBookInfoContent(text), base);
}

/** 从详情/目录 URL 推断 @get:{id}（如 list/@get:{id}.html） */
function seedBookIdFromUrl(bookUrl: string): string {
  const path =
    bookUrl.match(/\/(?:book|list)\/(\d+)(?:\.html)?/i)?.[1] ??
    bookUrl.match(/[?&](?:bookId|book_id|bid|id)=(\d+)/i)?.[1];
  return path ?? "";
}

export async function getBookInfo(
  source: BookSourceRecord,
  bookUrl: string,
  name: string,
  author: string,
  logs: string[] = [],
  seed: BookInfoSeed = {},
  /** 对齐 Legado-E WebBook.getBookInfoAwait；与 ruleBookInfo.canReName 同时为真才允许覆盖已有书名/作者 */
  canReName = true,
): Promise<Book> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const resolvedBookUrl = ensureBookUrlWithHeaders(bookUrl, host);
  const { url: bookPageUrl, variables } = splitUrlAndRuleVariables(resolvedBookUrl);
  const listIntro = seed.intro?.trim() ?? "";
  if (listIntro) variables.intro = listIntro;
  // 搜索 @put 优先；缺 id 时从 book/3604583.html 回填（勿用书源 cache 里「最后一条」的 id）
  if (seed.variable) {
    for (const [k, v] of Object.entries(seed.variable)) {
      if (v != null && String(v).trim()) variables[k] = String(v).trim();
    }
  }
  if (!variables.id?.trim()) {
    const fromUrl = seedBookIdFromUrl(bookPageUrl || bookUrl);
    if (fromUrl) variables.id = fromUrl;
  }
  const book: Book = {
    name,
    author,
    bookUrl: resolvedBookUrl,
    tocUrl: seed.tocUrl?.trim() || "",
    intro: listIntro,
    kind: seed.kind?.trim() ?? "",
    coverUrl: seed.coverUrl?.trim() ?? "",
    wordCount: seed.wordCount?.trim() ?? "",
    lastChapter: seed.lastChapter?.trim() ?? "",
    variable: { ...variables },
    infoHtml: seed.infoHtml,
  };
  const ar = new AnalyzeRule(source, logs, host)
    .setBook(toEngineBook(book))
    .setRuleData({ variable: { ...variables } });
  syncLegadoHeadersForRules(ar, host, resolvedBookUrl, variables);
  ar.setRuleData({ variable: { ...variables } });

  // Legado WebBook.getBookInfoAwait：有 infoHtml 则免二次请求；
  // redirectUrl 优先用搜索响应最终 URL（getInfoItem 的 res.url），以便 refreshBookUrl 得到书籍页。
  const cachedInfoHtml = seed.infoHtml?.trim() ?? "";
  let body: string;
  let redirectUrl: string;
  const bookInfoBaseUrl = resolvedBookUrl;
  if (cachedInfoHtml) {
    body = cachedInfoHtml;
    redirectUrl = seed.infoUrl?.trim() || resolvedBookUrl;
    logs.push("使用搜索缓存的 infoHtml 解析详情");
  } else {
    const analyzeUrl = new AnalyzeUrl({
      mUrl: resolvedBookUrl,
      baseUrl: source.bookSourceUrl,
      source,
      host,
      logs,
      ruleVariables: variables,
    });
    let res = await fetchWithLoginCheck(analyzeUrl, source, "", logs);
    // resourceId 为 90000001_数字 时 bookInfo 常空，去掉前缀重试
    if (
      /[?&]resourceId=\d+_\d+/i.test(resolvedBookUrl) &&
      bookInfoLooksEmpty(res.body)
    ) {
      const stripped = resolvedBookUrl.replace(/([?&]resourceId=)\d+_/i, "$1");
      if (stripped !== resolvedBookUrl) {
        logs.push(`详情 resourceId 含前缀且响应空，重试: ${stripped.slice(0, 120)}`);
        const retryUrl = new AnalyzeUrl({
          mUrl: stripped,
          baseUrl: source.bookSourceUrl,
          source,
          host,
          logs,
          ruleVariables: variables,
        });
        res = await fetchWithLoginCheck(retryUrl, source, "", logs);
        // 后续 tocUrl 拼 $..resourceID 须用短 id
        book.bookUrl = stripped;
      }
    }
    body = res.body;
    redirectUrl = res.url;
  }
  const rule = source.ruleBookInfo ?? {};
  const detailInitFailed = bookInfoInitFailed(body, rule.init);
  if (detailInitFailed) {
    logs.push(`详情页响应异常（可能缺少签名 headers），URL: ${redirectUrl}`);
  }
  ar.setRedirectUrl(redirectUrl);
  await applyBookInfoInitContent(ar, rule.init, body, bookInfoBaseUrl);
  // Legado-E：mCanReName = canReName && !infoRule.canReName.isNullOrBlank()
  const mCanReName = canReName && Boolean(rule.canReName?.trim());
  const parsedName = formatLegadoBookName(
    (await resolveBookInfoField(ar, rule.name)).trim(),
  );
  const parsedAuthor = formatLegadoBookAuthor(
    (await resolveBookInfoField(ar, rule.author)).trim(),
  );
  let detailName = book.name?.trim() || name?.trim() || "";
  if (parsedName && (mCanReName || !bookInfoHasName(detailName))) {
    detailName = parsedName;
  }
  let detailAuthor = book.author?.trim() || author?.trim() || "";
  if (parsedAuthor && (mCanReName || !bookInfoHasAuthor(detailAuthor))) {
    detailAuthor = parsedAuthor;
  }
  detailAuthor = formatLegadoBookAuthor(detailAuthor) || "未知";
  detailName = stripEmbeddedAuthorFromDetailName(detailName, detailAuthor);
  const kindParts = await resolveBookInfoKindParts(ar, rule.kind);
  const parsedKind = kindParts.length ? kindParts.join(",") : "";
  // 详情落地一次规范化 kind
  const kind = stripNumericIdPrefix(parsedKind || book.kind || "");
  book.kind = kind;
  book.name = detailName;
  book.author = detailAuthor;
  ar.setBook(toEngineBook(book));
  const rawWordCount = await resolveBookInfoField(ar, rule.wordCount);
  const wordCount =
    wordCountFormat(rawWordCount) || book.wordCount || undefined;
  const lastChapterRaw = (await resolveBookInfoField(ar, rule.lastChapter)).trim();
  const parsedLastChapter = formatLegadoLastChapterDisplay(lastChapterRaw) || "";
  const lastChapter = parsedLastChapter || book.lastChapter || undefined;
  const parsedIntro = await resolveBookIntroText(ar, rule.intro, kindParts);
  let intro = parsedIntro || listIntro || book.intro;
  intro = ensureLegadoIntroLeadingTitle(intro, detailName);
  const rawCover = await resolveBookInfoField(ar, rule.coverUrl);
  const ogCover = rawCover.trim()
    ? ""
    : await resolveOgMetaContent(ar, "og:image");
  const coverFetchRaw = rawCover.trim() || ogCover || book.coverUrl || "";
  const coverSourceUrl =
    resolveCoverSourceUrl(source, rawCover, redirectUrl, logs) ||
    resolveCoverSourceUrl(source, ogCover, redirectUrl, logs) ||
    resolveCoverSourceUrl(source, book.coverUrl, redirectUrl, logs) ||
    undefined;
  const resolvedCover =
    (coverSourceUrl
      ? await resolveBookCoverDisplayUrl(source, coverFetchRaw, redirectUrl, logs)
      : undefined) ?? "";
  const coverUrl = resolvedCover || book.coverUrl;
  let updateTime = (await resolveBookInfoField(ar, rule.updateTime)).trim();
  const kindDate = kindParts.find((t) => /^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(t));
  if (!updateTime && kindDate) updateTime = kindDate.replace(/T.*/, "").replace(/-/g, "/");
  if (!updateTime) {
    const m = kind.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}/);
    if (m) updateTime = m[0].replace(/-/g, "/");
  }
  if (!updateTime) updateTime = resolveBookUpdateTimeFallback(ar, lastChapterRaw);
  if (!updateTime && intro) {
    const m = intro.match(
      /更新时间[：:]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
    );
    if (m?.[1]) updateTime = m[1].replace(/-/g, "/");
  }
  // Legado BookInfo：tocUrl 用 getString(..., isUrl=true) → 多 URL 时取首条
  let tocUrl = "";
  if (rule.tocUrl?.trim()) {
    const rawToc = (await resolveBookInfoField(ar, rule.tocUrl)).trim();
    if (rawToc) {
      if (/,\s*\{/.test(rawToc)) {
        tocUrl = ar.resolveAbsoluteRuleUrl(rawToc);
      } else {
        const first =
          rawToc
            .split(/[\r\n]+/)
            .map((s) => s.trim())
            .find(Boolean) ?? "";
        tocUrl = first ? ar.resolveAbsoluteRuleUrl(first) : "";
      }
    }
  }
  if (tocUrl && /[?&]bid=$/i.test(tocUrl)) {
    const bidFromBookUrl =
      bookPageUrl.match(/[?&]bid=([^&]+)/i)?.[1] ??
      bookUrl.match(/[?&]bid=([^&]+)/i)?.[1];
    if (bidFromBookUrl) {
      tocUrl = tocUrl.replace(/([?&]bid=)$/i, `$1${bidFromBookUrl}`);
    }
  }
  if (tocUrl && /[?&]bookId=$/i.test(tocUrl)) {
    const bookIdFromUrl =
      bookPageUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      bookUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      resolvedBookUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      bookPageUrl.match(/[?&]bookid=(\d+)/i)?.[1] ??
      bookUrl.match(/[?&]bookid=(\d+)/i)?.[1] ??
      resolvedBookUrl.match(/[?&]bookid=(\d+)/i)?.[1];
    if (bookIdFromUrl) {
      tocUrl = tocUrl.replace(/([?&]bookId=)$/i, `$1${bookIdFromUrl}`);
    }
  }
  // POST body 里 `"bookId":""`（UrlOption）：从详情 URL 选项回填
  if (tocUrl && /"bookId"\s*:\s*""/.test(tocUrl)) {
    const bookId =
      extractJsonBookIdFromUrlOption(resolvedBookUrl) ||
      extractJsonBookIdFromUrlOption(bookUrl) ||
      (typeof ar.currentContent === "object" &&
      ar.currentContent &&
      "bookId" in (ar.currentContent as object)
        ? String((ar.currentContent as { bookId?: unknown }).bookId ?? "")
        : "");
    if (bookId) {
      tocUrl = tocUrl.replace(/"bookId"\s*:\s*""/g, `"bookId":"${bookId}"`);
    }
  }
  if (/^@js:/i.test(tocUrl) || /^<js>/i.test(tocUrl)) {
    logs.push("目录 URL 规则未正确执行 JS，请检查 ruleBookInfo.tocUrl");
    tocUrl = "";
  }
  if (/\[object\s+Object\]/i.test(tocUrl)) {
    tocUrl = "";
  }
  if (tocUrl && !/^https?:\/\//i.test(tocUrl) && !tocUrl.startsWith("data:")) {
    tocUrl = resolveAbsoluteUrl(
      normalizeBookSourceBaseUrl(redirectUrl || bookInfoBaseUrl),
      tocUrl,
    );
  }
  // Legado BookInfo：tocUrl 空则用 baseUrl（book.bookUrl）；同页则缓存 tocHtml
  if (!tocUrl.trim()) {
    tocUrl = String(book.bookUrl || bookInfoBaseUrl);
  }
  // POST 搜索未重定向时 refreshBookUrl 仍落在搜索页：从详情 HTML 推断真实目录页
  if (body.trim() && isLikelySearchArticleUrl(tocUrl)) {
    const inferred = inferBookDirUrlFromDetailHtml(
      body,
      redirectUrl || bookInfoBaseUrl || tocUrl,
    );
    if (inferred) {
      tocUrl = inferred;
      logs.push(`目录 URL 由详情页推断: ${inferred}`);
    }
  }
  // 搜索阶段已解析出更优 tocUrl 时保留（避免 infoHtml 重析又写回搜索页）
  const seedToc = seed.tocUrl?.trim() ?? "";
  if (
    seedToc &&
    !isLikelySearchArticleUrl(seedToc) &&
    isLikelySearchArticleUrl(tocUrl)
  ) {
    tocUrl = seedToc;
  }
  let tocHtml: string | undefined;
  if (
    (tocUrl === String(book.bookUrl || bookInfoBaseUrl) ||
      (cachedInfoHtml && isLikelySearchArticleUrl(String(book.bookUrl || "")))) &&
    body.trim()
  ) {
    // 目录与详情同页（含搜索响应即详情）：缓存 HTML 供 getChapterList
    tocHtml = body;
  }
  ensureBidVariable(ar, variables, book, resolvedBookUrl, bookUrl, bookPageUrl);
  const mergedVariable = {
    ...book.variable,
    ...ar.getStoredVariables(),
    ...variables,
  };
  const detail: Book = {
    name: detailName,
    author: detailAuthor,
    intro,
    coverUrl,
    coverSourceUrl,
    kind,
    wordCount,
    lastChapter,
    updateTime: updateTime || undefined,
    tocUrl: tocUrl ? ensureBookUrlWithHeaders(tocUrl, host) : tocUrl,
    bookUrl: String(book.bookUrl || resolvedBookUrl),
    origin: seed.origin,
    originName: seed.originName,
    variable: Object.keys(mergedVariable).length ? mergedVariable : undefined,
    infoHtml: cachedInfoHtml || undefined,
    infoUrl: seed.infoUrl?.trim() || redirectUrl || undefined,
    tocHtml,
  };
  // list/.html 等无效目录址：回退详情页（再由调用方决定是否可用）
  if (
    !detail.tocUrl?.trim() ||
    /\/list\/\.html/i.test(detail.tocUrl) ||
    /\/list\/(?:\?|$)/i.test(detail.tocUrl)
  ) {
    detail.tocUrl = ensureBookUrlWithHeaders(String(book.bookUrl || resolvedBookUrl), host);
    if (body.trim()) detail.tocHtml = body;
  }
  return detail;
}

function dedupeChapters(chapters: BookChapter[]): BookChapter[] {
  const seen = new Set<string>();
  const out: BookChapter[] = [];
  for (const ch of chapters) {
    const key = `${ch.url}\0${ch.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ch);
  }
  return out;
}

async function applyTocFormatJs(
  chapters: BookChapter[],
  formatJs: string,
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
): Promise<void> {
  const gIntRef = { value: 0 };
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const script = `
var index = ${i + 1};
var title = ${JSON.stringify(chapter.title)};
var gInt = ${gIntRef.value};
${formatJs.trim()}
`;
    try {
      const out = await evalJsAsync(script, {
        source,
        host,
        chapter,
        result: chapter.title,
        baseUrl: source.bookSourceUrl,
      });
      if (out != null && String(out).trim()) {
        chapter.title = String(out).trim();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.log(`格式化标题出错: ${msg}`);
    }
  }
}

function parseTocListRule(chapterListRule: string): {
  listRule: string;
  reversePrefix: boolean;
} {
  let listRule = chapterListRule;
  let reversePrefix = false;
  if (listRule.startsWith("-")) {
    reversePrefix = true;
    listRule = listRule.slice(1);
  } else if (listRule.startsWith("+")) {
    listRule = listRule.slice(1);
  }
  return { listRule, reversePrefix };
}

/**
 * 对齐 Legado `BookChapterList` 的 `-`/`+` 前缀语义（彩读约定目录数组「最新在前」）：
 * - 无 `-`：页面多为正序（旧→新），反转一次 → 最新在前
 * - 有 `-`：页面已是倒序（新→旧），不再反转
 * （Legado 存正序阅读：无 `-` 时反转两次回到页面序；彩读 UI 正序再反转一次展示，效果一致。）
 */
function applyTocReversePrefix(
  chapters: BookChapter[],
  reversePrefix: boolean,
): BookChapter[] {
  if (!reversePrefix) {
    chapters.reverse();
  }
  return chapters;
}

/** 去掉 Legado UrlOption（`,` + JSON）再比路径 */
function stripLegadoUrlOption(u: string): string {
  const t = u.trim();
  if (!t) return "";
  const m = t.match(/^([^,]+?)(?=,\s*\{|$)/);
  return (m?.[1] ?? t).trim();
}

/** 正文翻页：宽松同页判断（去 UrlOption / hash / 尾斜杠 / 大小写） */
function isSameContentPageUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    const t = stripLegadoUrlOption(u);
    if (!t) return "";
    try {
      const url = new URL(t);
      url.hash = "";
      const path = url.pathname.replace(/\/+$/, "") || "/";
      return `${url.protocol}//${url.host}${path}${url.search}`.toLowerCase();
    } catch {
      return t.replace(/\/+$/, "").toLowerCase();
    }
  };
  return Boolean(a && b && norm(a) === norm(b));
}

/** 对齐 Legado `NetworkUtils.getAbsoluteURL`（正文下一页边界比较用） */
function legadoGetAbsoluteURL(baseURL: string, relativePath: string): string {
  const base = stripLegadoUrlOption(baseURL);
  const rel = stripLegadoUrlOption(relativePath);
  if (!rel) return "";
  if (!base) return rel;
  if (/^https?:\/\//i.test(rel) || rel.startsWith("data:")) return rel;
  if (/^javascript:/i.test(rel)) return "";
  return resolveAbsoluteUrl(base, rel);
}

/**
 * 对齐 Legado BookContent：
 * `getAbsoluteURL(redirectUrl, next) == getAbsoluteURL(redirectUrl, nextChapterUrl)` 则停止翻页。
 * 额外：若下一页已是目录中其它章节 URL，也停止（部分站「下一页」实为下一章，且偶发与 toc 字符串不完全一致）。
 */
function isContentNextChapterBoundary(
  redirectUrl: string,
  nextUrl: string,
  nextChapterUrl: string | undefined,
  chapterUrls: string[] | undefined,
  currentChapterUrl: string,
): boolean {
  const absNext = legadoGetAbsoluteURL(redirectUrl, nextUrl);
  if (!absNext) return false;

  const samePage = (a: string, b: string) => {
    if (!a || !b) return false;
    if (a === b) return true;
    return isSameContentPageUrl(a, b);
  };

  if (nextChapterUrl?.trim()) {
    const absNextCh = legadoGetAbsoluteURL(redirectUrl, nextChapterUrl);
    if (samePage(absNext, absNextCh)) return true;
    if (samePage(absNext, nextChapterUrl.trim())) return true;
    if (samePage(nextUrl.trim(), absNextCh)) return true;
  }

  const currentAbs = legadoGetAbsoluteURL(redirectUrl, currentChapterUrl);
  for (const u of chapterUrls ?? []) {
    const abs = legadoGetAbsoluteURL(redirectUrl, u);
    if (!abs || samePage(abs, currentAbs) || samePage(abs, currentChapterUrl)) {
      continue;
    }
    if (samePage(absNext, abs)) return true;
  }
  return false;
}

/** 去重 nextContentUrl（页头/页脚各一个下一页链接时 getUrlList 会返回两条相同 URL） */
function dedupeContentNextUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const t = u.trim();
    if (!t) continue;
    if (out.some((prev) => prev === t || isSameContentPageUrl(prev, t))) {
      continue;
    }
    out.push(t);
  }
  return out;
}

/** 去掉已是下一章/目录其它章的下一页；去重后再交给串行或并发翻页 */
function filterContentNextUrls(
  urls: string[],
  redirectUrl: string,
  nextChapterUrl: string | undefined,
  chapterUrls: string[] | undefined,
  currentChapterUrl: string,
  logs: string[],
): string[] {
  const deduped = dedupeContentNextUrls(urls);
  if (deduped.length < urls.length) {
    logs.push(
      `正文下一页 URL 去重: ${urls.length} → ${deduped.length}`,
    );
  }
  const kept: string[] = [];
  for (const u of deduped) {
    if (
      isContentNextChapterBoundary(
        redirectUrl,
        u,
        nextChapterUrl,
        chapterUrls,
        currentChapterUrl,
      )
    ) {
      logs.push(`正文下一页已是章节边界，停止翻页: ${u.slice(0, 120)}`);
      continue;
    }
    kept.push(u);
  }
  return kept;
}

export function isSameBookPageUrl(a: string, b: string): boolean {
  const pa = (a.split(",")[0] ?? a).trim();
  const pb = (b.split(",")[0] ?? b).trim();
  if (!pa || !pb) return false;
  if (pa === pb) return true;
  return isSameContentPageUrl(pa, pb);
}

async function applyContentReplaceRegex(
  ar: AnalyzeRule,
  content: string,
  replaceRegex: string,
): Promise<string> {
  const normalized = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join("\n");
  const lines = replaceRegex
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hashLineMode =
    lines.length > 0 && lines.every((l) => l.includes("##"));
  if (hashLineMode) {
    let out = normalized;
    for (const line of lines) {
      if (line.startsWith("##")) {
        const { regex } = splitRuleRegexSuffix(line);
        if (regex?.pattern) {
          out = applyContentRuleRegex(out, {
            pattern: expandContentRegexPlaceholders(ar, regex.pattern),
            replacement: expandContentRegexPlaceholders(
              ar,
              regex.replacement ?? "",
            ),
            replaceFirst: regex.replaceFirst,
          });
        }
        continue;
      }
      const segs = line.split("##");
      if (segs.length >= 2 && segs[0]) {
        try {
          const pat = expandContentRegexPlaceholders(ar, segs[0]!);
          const repl = expandContentRegexPlaceholders(ar, segs[1] ?? "");
          out = out.replace(new RegExp(pat, "g"), repl);
        } catch {
          /* ignore invalid regex */
        }
      }
    }
    return out;
  }
  return ar.getString(replaceRegex, normalized);
}

/** 正文 replaceRegex 行内 {{title}} / {{chapter.title}} 等占位 */
function expandContentRegexPlaceholders(ar: AnalyzeRule, text: string): string {
  return text
    .replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) =>
      ar.expandLegadoTemplateKey(String(expr)),
    )
    .replace(/@get:\{([^}]+)\}/gi, (_, key: string) =>
      ar.getStored(String(key).trim()),
    );
}

/** 正文 replaceRegex：对齐 Legado，`.` 默认不匹配换行；显式 `(?s)` 等走 compileLegadoRegex */
function applyContentRuleRegex(
  value: string,
  regex: { pattern: string; replacement: string; replaceFirst?: boolean },
): string {
  if (!regex.pattern) return value;
  return applyRuleRegex(value, regex);
}

async function fetchContentPage(
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
  logs: string[],
  rule: NonNullable<BookSourceRecord["ruleContent"]>,
  body: string,
  pageUrl: string,
  redirectUrl: string,
  book: Record<string, unknown>,
  chapter: Record<string, unknown>,
  variables: Record<string, string>,
  nextChapterUrl?: string,
  getNextPageUrl = true,
): Promise<{ content: string; nextUrls: string[] }> {
  const contentBaseUrl = String(chapter.url ?? pageUrl);
  const ar = new AnalyzeRule(source, logs, host)
    .setContent(body, contentBaseUrl)
    .setRedirectUrl(redirectUrl)
    // 勿用 ruleVariables 覆盖 book.variable（Legado 为字符串，部分书源靠 += 累加正文）
    .setBook({ ...book })
    .setChapter(chapter)
    .setRuleData({ variable: { ...variables } })
    .setNextChapterUrl(nextChapterUrl);
  let content = await ar.getString(rule.content, body);

  // sophie
  if (/<img\b/i.test(content)) {
    content = await replaceInlineCharacterImages(
      content,
      contentBaseUrl,
      source,
      host,
      logs,
    );
  }


  if (/<[a-z][\s\S]*>/i.test(content)) {
    content = formatLegadoChapterContent(content);
    if (content.includes("&")) {
      content = unescapeLegadoHtmlEntities(content);
    }
  }
  let nextUrls: string[] = [];
  if (getNextPageUrl && rule.nextContentUrl?.trim()) {
    nextUrls = await ar.getUrlList(rule.nextContentUrl, body);
  }
  return { content, nextUrls };
}

// sophie{
async function replaceInlineCharacterImages(
  html: string,
  baseUrl: string,
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
  logs: string[],
): Promise<string> {
  const imgRegex =
    /<img\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;

  const matches = [...html.matchAll(imgRegex)];

  if (matches.length === 0) {
    return html;
  }

  let result = html;

  for (const match of matches) {
    const fullTag = match[0];
    const rawSrc = match[1];

    if (!rawSrc) continue;

    if (!result.includes(fullTag)) continue;

    try {
      const imageUrl = new URL(rawSrc, baseUrl).toString();

      console.log("[inline-img] found:", imageUrl);

      // 1. 读取当前书源配置的 header + 登录 header
      const headers = await resolveSourceRequestHeaders(source, {
        baseUrl: normalizeBookSourceBaseUrl(baseUrl),
        host,
        logs,
      });

      // 2. 图片请求补 Referer
      //
      // 对图片防盗链站点，这个非常重要。
      // Referer 应该是当前章节页面，而不是图片 URL。
      if (!headers["Referer"] && !headers["referer"]) {
        headers["Referer"] = baseUrl;
      }

      // 3. 没有 User-Agent 时补浏览器 UA
      if (!headers["User-Agent"] && !headers["user-agent"]) {
        headers["User-Agent"] =
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36";
      }

      // 4. 图片 Accept
      if (!headers["Accept"] && !headers["accept"]) {
        headers["Accept"] =
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
      }

      // 5. 如果书源启用了 CookieJar，把已有 cookie 一起带过去
      if (source.enabledCookieJar) {
        const cookie = cookieHeaderForUrl(imageUrl);

        if (cookie) {
          headers["Cookie"] = headers["Cookie"]
            ? `${headers["Cookie"]}; ${cookie}`
            : cookie;
        }
      }

      console.log("[inline-img] request:", {
        url: imageUrl,
        referer: headers["Referer"] ?? headers["referer"],
        hasCookie: Boolean(headers["Cookie"] ?? headers["cookie"]),
      });

      const response = await fetchBinaryViaChromiumSession({
        url: imageUrl,
        headers,
        useCookieJar: source.enabledCookieJar,
        redirect: "follow",
        timeoutMs: 15_000,
      });

      console.log("[inline-img] response:", {
        status: response.statusCode,
        contentType:
          response.headers["content-type"] ??
          response.headers["Content-Type"],
        bytes: response.body.length,
        finalUrl: response.url,
      });

      if (
        response.statusCode < 200 ||
        response.statusCode >= 300
      ) {
        console.warn(
          "[inline-img] download failed:",
          response.statusCode,
          imageUrl,
        );

        continue;
      }

      const buffer = response.body;

      if (buffer.length < 16) {
        console.warn("[inline-img] image too small:", imageUrl);
        continue;
      }

      // 7. Electron 解码图片
      const image = nativeImage.createFromBuffer(buffer);

      if (image.isEmpty()) {
        console.warn("[inline-img] invalid image:", imageUrl);
        continue;
      }

      const { width, height } = image.getSize();

      const area = width * height;
      const ratio = height > 0 ? width / height : 999;

      // 先保持之前的候选字图片判断
      const isPossibleCharacter =
        width > 0 &&
        height > 0 &&
        width <= 80 &&
        height <= 80 &&
        area <= 4096 &&
        ratio >= 0.3 &&
        ratio <= 3;

      console.log("[inline-img]", {
        url: imageUrl,
        width,
        height,
        area,
        ratio: Number(ratio.toFixed(2)),
        bytes: buffer.length,
        possibleCharacter: isPossibleCharacter,
      });
      
      // ocr
      if (isPossibleCharacter) {
        const character =
          await recognizeInlineCharacter(
            imageUrl,
            image,
          );

        if (character) {
          console.log(
            "[inline-img] OCR replace:",
            imageUrl,
            "success",
          );

          const beforeReplace = result;

          result = result.replaceAll(
            fullTag,
            character,
          );

          console.log(
            "[inline-img] replacement succeeded:",
            result !== beforeReplace,
          );

        } else {
          console.warn(
            "[inline-img] OCR failed, keep original:",
            imageUrl,
          );

          /*
          * 测试阶段 OCR 失败什么都不改。
          *
          * 不再 normalized。
          */
        }
      }

    } catch (error) {
      console.warn(
        "[inline-img] process failed:",
        rawSrc,
        error,
      );

      logs.push(
        `[inline-img] 图片处理失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}
// sophie}

export async function getChapterList(
  source: BookSourceRecord,
  bookInput: Book,
  logs: string[] = [],
): Promise<BookChapter[]> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const rule = source.ruleToc ?? {};
  const bookUrl = bookInput.bookUrl?.trim() || "";
  const tocUrl = (bookInput.tocUrl || bookUrl).trim();
  const resolvedBookUrl = ensureBookUrlWithHeaders(bookUrl, host);
  let resolvedTocUrl = ensureBookUrlWithHeaders(tocUrl, host);
  const { url: bookPageUrl, variables } = splitUrlAndRuleVariables(resolvedBookUrl);
  const { url: fetchTocUrl, variables: tocVars } =
    splitUrlAndRuleVariables(resolvedTocUrl);
  Object.assign(variables, tocVars);
  let kind = stripNumericIdPrefix(bookInput.kind);
  if (!kind) {
    kind = resolveBookKindForChapterRules("", fetchTocUrl, bookPageUrl);
  }
  const book = toEngineBook(
    coerceBook({
      ...bookInput,
      kind,
      bookUrl: bookPageUrl,
      tocUrl: fetchTocUrl,
    }),
  );
  applyPersistedBookVariable(book, bookPageUrl);
  const ar = new AnalyzeRule(source, logs, host)
    .setBook(book)
    .setRuleData({ variable: { ...variables } });
  syncLegadoHeadersForRules(ar, host, resolvedBookUrl, variables);
  syncLegadoHeadersForRules(ar, host, resolvedTocUrl, variables);
  ar.setRuleData({ variable: { ...variables } });
  ensureBidVariable(
    ar,
    variables,
    book,
    bookPageUrl,
    fetchTocUrl,
    resolvedBookUrl,
  );
  ar.setRuleData({ variable: { ...variables } });
  if (rule.preUpdateJs?.trim()) {
    // 对齐 Legado WebBook.runPreUpdateJs：AnalyzeRule(book, source, preUpdateJs=true)
    const mergeBookInfo = (detail: Book) => {
      book.tocUrl = detail.tocUrl?.trim() || book.tocUrl;
      book.bookUrl = detail.bookUrl?.trim() || book.bookUrl;
      if (detail.name?.trim()) book.name = detail.name;
      if (detail.author?.trim()) book.author = detail.author;
      if (detail.kind?.trim()) book.kind = stripNumericIdPrefix(detail.kind);
      if (detail.intro != null) book.intro = detail.intro;
      if (detail.coverUrl?.trim()) book.coverUrl = detail.coverUrl;
      if (detail.wordCount?.trim()) book.wordCount = detail.wordCount;
      if (detail.lastChapter?.trim()) book.lastChapter = detail.lastChapter;
      if (detail.updateTime?.trim()) book.updateTime = detail.updateTime;
      if (typeof book.variable === "string") {
        const after = getBookCustomVariable(bookPageUrl);
        if (after) book.variable = after;
      } else {
        const vars =
          book.variable &&
          typeof book.variable === "object" &&
          !Array.isArray(book.variable)
            ? (book.variable as Record<string, string>)
            : {};
        if (detail.variable) Object.assign(vars, detail.variable);
        book.variable = vars;
        Object.assign(variables, vars);
      }
      ar.setBook(book).setRuleData({ variable: { ...variables } });
    };
    const java = {
      ...ar.buildRuleJava(),
      /** Legado AnalyzeRule.refreshTocUrl：重新拉详情写回 tocUrl */
      refreshTocUrl: async () => {
        const detail = await getBookInfo(
          source,
          String(book.bookUrl || bookPageUrl),
          String(book.name || bookInput.name || ""),
          String(book.author || bookInput.author || ""),
          logs,
          {
            kind: String(book.kind || bookInput.kind || ""),
            intro: String(book.intro || bookInput.intro || ""),
            coverUrl: String(book.coverUrl || bookInput.coverUrl || ""),
            wordCount: String(book.wordCount || bookInput.wordCount || ""),
            lastChapter: String(book.lastChapter || bookInput.lastChapter || ""),
          },
          false,
        );
        mergeBookInfo(detail);
      },
      /** Legado AnalyzeRule.reGetBook：精确搜索后刷新详情 */
      reGetBook: async () => {
        const name = String(book.name || bookInput.name || "").trim();
        const author = String(book.author || bookInput.author || "").trim();
        const authorNorm = formatLegadoBookAuthor(author);
        const items = await searchBook(source, name, 1, logs);
        const hit = items.find(
          (i) =>
            i.name === name && formatLegadoBookAuthor(i.author) === authorNorm,
        );
        if (!hit?.bookUrl?.trim()) {
          throw new Error(`未搜索到 ${name}(${author}) 书籍`);
        }
        book.bookUrl = hit.bookUrl.trim();
        if (hit.kind?.trim()) book.kind = stripNumericIdPrefix(hit.kind);
        const detail = await getBookInfo(
          source,
          hit.bookUrl,
          hit.name || name,
          hit.author || author,
          logs,
          {
            kind: hit.kind,
            intro: hit.intro,
            coverUrl: hit.coverUrl,
            wordCount: hit.wordCount,
            lastChapter: hit.lastChapter,
          },
          false,
        );
        mergeBookInfo(detail);
      },
    };
    try {
      await evalJsAsync(rule.preUpdateJs, {
        source,
        book,
        result: String(book.tocUrl || fetchTocUrl),
        baseUrl: source.bookSourceUrl,
        host,
        java,
        bookVariableSync: createBookVariableSync(bookPageUrl),
      });
    } catch (e) {
      appendBookSourceErrorLog(logs, e, {
        phase: "目录 preUpdateJs",
        sourceName: source.bookSourceName,
        sourceUrl: source.bookSourceUrl,
        url: String(book.tocUrl || fetchTocUrl),
      });
      throw e;
    }
    // refreshTocUrl / reGetBook 可能改写 tocUrl、bookUrl
    resolvedTocUrl = ensureBookUrlWithHeaders(
      String(book.tocUrl || book.bookUrl || tocUrl),
      host,
    );
    const refreshed = splitUrlAndRuleVariables(resolvedTocUrl);
    Object.assign(variables, refreshed.variables);
    book.tocUrl = refreshed.url;
    if (book.bookUrl) {
      const refreshedBook = splitUrlAndRuleVariables(
        ensureBookUrlWithHeaders(String(book.bookUrl), host),
      );
      book.bookUrl = refreshedBook.url;
      Object.assign(variables, refreshedBook.variables);
    }
    ar.setBook(book).setRuleData({ variable: { ...variables } });
  }

  // Legado：bookUrl == tocUrl 且有 tocHtml 时直接解析，免再请求（搜索响应即详情时常见）
  const tocHtmlCached = bookInput.tocHtml?.trim() ?? "";
  const bookUrlForTocCmp = String(bookInput.bookUrl || "").trim();
  const tocUrlForTocCmp = String(bookInput.tocUrl || bookInput.bookUrl || "").trim();
  if (tocHtmlCached && bookUrlForTocCmp && bookUrlForTocCmp === tocUrlForTocCmp) {
    const chapters: BookChapter[] = [];
    const { listRule, reversePrefix } = parseTocListRule(rule.chapterList ?? "");
    const base = tocUrlForTocCmp;
    const arToc = new AnalyzeRule(source, logs, host)
      .setContent(tocHtmlCached, base)
      .setRedirectUrl(base)
      .setBook(book)
      .setRuleData({ variable: { ...variables } });
    const list = await arToc.getElements(listRule, tocHtmlCached);
    for (const el of list) {
      arToc.setContent(el, base);
      const chapterCtx = { title: "", url: "", tag: "" };
      arToc.setChapter(chapterCtx);
      const title = await arToc.getString(rule.chapterName, el);
      let url = rule.chapterUrl
        ? await arToc.getUrl(rule.chapterUrl, el)
        : "";
      const updateTag = rule.updateTime
        ? await arToc.getString(rule.updateTime, el)
        : "";
      if (updateTag && !chapterCtx.tag) chapterCtx.tag = updateTag;
      const isVolume = await resolveChapterIsVolume(arToc, rule.isVolume, el);
      if (!title) continue;
      if (!url) {
        if (isVolume) url = `${title}${chapters.length}`;
        else url = base;
      }
      if (!url && !isVolume) continue;
      const tag = String(chapterCtx.tag || updateTag || "").trim();
      chapters.push({
        title,
        url: url || base,
        isVolume,
        isVip: isTruthy(await arToc.getString(rule.isVip, el)),
        isPay: isTruthy(await arToc.getString(rule.isPay, el)),
        ...(tag ? { tag } : {}),
      });
    }
    // 须与下方联网拉目录同一套 `-` 语义（修前误写成 reversePrefix 才 reverse）
    applyTocReversePrefix(chapters, reversePrefix);
    let out = dedupeChapters(chapters);
    if (rule.formatJs?.trim()) {
      await applyTocFormatJs(out, rule.formatJs, source, host);
    }
    if (!out.length) {
      logs.push("未解析到章节（tocHtml 缓存）");
    }
    return out;
  }

  const fetchTocUrlFinal = String(book.tocUrl || fetchTocUrl);
  const analyzeUrl = new AnalyzeUrl({
    mUrl: resolvedTocUrl,
    baseUrl: String(book.bookUrl || bookPageUrl),
    source,
    host,
    logs,
    ruleVariables: variables,
  });
  let res = await fetchWithLoginCheck(analyzeUrl, source, "", logs);
  let body = res.body;
  let redirectUrl = res.url;
  // bookId 误带 90000001_ 前缀时 all-chapter 返回空 rows，去掉前缀再试
  if (
    body.trim().startsWith("{") &&
    /"rows"\s*:\s*\[\s*\]/.test(body) &&
    /[?&]bookId=\d+_\d+/i.test(fetchTocUrlFinal)
  ) {
    const stripped = fetchTocUrlFinal.replace(
      /([?&]bookId=)\d+_/i,
      "$1",
    );
    if (stripped !== fetchTocUrlFinal) {
      logs.push(`目录 bookId 含前缀且 rows 为空，重试: ${stripped.slice(0, 120)}`);
      const retryUrl = new AnalyzeUrl({
        mUrl: stripped,
        baseUrl: String(book.bookUrl || bookPageUrl),
        source,
        host,
        logs,
        ruleVariables: variables,
      });
      const retry = await fetchWithLoginCheck(retryUrl, source, "", logs);
      body = retry.body;
      redirectUrl = retry.url;
      resolvedTocUrl = stripped;
      book.tocUrl = stripped;
    }
  }
  const chapters: BookChapter[] = [];
  const { listRule, reversePrefix } = parseTocListRule(rule.chapterList ?? "");
  const collect = async (b: string, base: string, redirect: string) => {
    const ar = new AnalyzeRule(source, logs, host)
      .setContent(b, base)
      .setRedirectUrl(redirect)
      .setBook(book)
      .setRuleData({ variable: { ...variables } });
    const list = await ar.getElements(listRule, b);
    if (!list.length && b.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(b) as {
          errors?: { title?: string; details?: string };
          data?: { chapter_lists?: unknown };
        };
        if (parsed.errors) {
          logs.push(
            `目录接口错误: ${parsed.errors.title ?? parsed.errors.details ?? "验签或权限失败"}`,
          );
        } else if (!parsed.data?.chapter_lists && /novel\/api/i.test(base)) {
          logs.push("目录接口未返回 chapter_lists 字段");
        }
      } catch {
        /* ignore */
      }
    }
    for (const el of list) {
      ar.setContent(el, redirect);
      const chapterCtx = { title: "", url: "", tag: "" };
      ar.setChapter(chapterCtx);
      const title = await ar.getString(rule.chapterName, el);
      let url = rule.chapterUrl
        ? await ar.getUrl(rule.chapterUrl, el)
        : "";
      const updateTag = rule.updateTime
        ? await ar.getString(rule.updateTime, el)
        : "";
      if (updateTag && !chapterCtx.tag) chapterCtx.tag = updateTag;
      const isVolume = await resolveChapterIsVolume(ar, rule.isVolume, el);
      if (!title) continue;
      if (!url) {
        if (isVolume) url = `${title}${chapters.length}`;
        else url = base;
      }
      if (!url && !isVolume) continue;
      const tag = String(chapterCtx.tag || updateTag || "").trim();
      chapters.push({
        title,
        url: url || base,
        isVolume,
        isVip: isTruthy(await ar.getString(rule.isVip, el)),
        isPay: isTruthy(await ar.getString(rule.isPay, el)),
        ...(tag ? { tag } : {}),
      });
    }
  };
  await collect(body, res.url, redirectUrl);
  if (rule.nextTocUrl?.trim()) {
    // nextTocUrl 里常按 baseUrl 匹配 UrlOption（如 limit=500）；须用带 option 的原 toc URL，不能只用 res.url
    const tocRuleBaseUrl = resolvedTocUrl || fetchTocUrlFinal || res.url;
    const ar = new AnalyzeRule(source, logs, host)
      .setContent(body, tocRuleBaseUrl)
      .setRedirectUrl(redirectUrl)
      .setBook(book)
      .setRuleData({ variable: { ...variables } });
    const nextList = await ar.getUrlList(rule.nextTocUrl);
    /** 须保留 UrlOption（分页 offset 等常在 POST body）；仅剥末尾空白 */
    const tocVisitKey = (u: string) => u.trim();
    if (nextList.length === 1) {
      let next = nextList[0]!;
      const visited = new Set<string>([
        tocVisitKey(resolvedTocUrl),
        tocVisitKey(fetchTocUrlFinal),
      ]);
      while (next && !visited.has(tocVisitKey(next))) {
        visited.add(tocVisitKey(next));
        const nextAnalyze = new AnalyzeUrl({
          mUrl: next,
          baseUrl: String(book.bookUrl || bookPageUrl),
          source,
          host,
          logs,
          ruleVariables: variables,
        });
        const nextRes = await fetchWithLoginCheck(nextAnalyze, source, "", logs);
        await collect(nextRes.body, nextRes.url, nextRes.url);
        const arNext = new AnalyzeRule(source, logs, host)
          .setContent(nextRes.body, next)
          .setRedirectUrl(nextRes.url)
          .setBook(book)
          .setRuleData({ variable: { ...variables } });
        const more = await arNext.getUrlList(rule.nextTocUrl);
        next = more[0] ?? "";
      }
    } else if (nextList.length > 1) {
      const responses = await ajaxAllStrResponses(host, nextList);
      for (const resp of responses) {
        const pageBody = resp.body();
        const pageUrl = resp.url();
        if (pageBody) await collect(pageBody, pageUrl, pageUrl);
      }
    }
  }
  applyTocReversePrefix(chapters, reversePrefix);
  let list = dedupeChapters(chapters);
  if (rule.formatJs?.trim()) {
    await applyTocFormatJs(list, rule.formatJs, source, host);
  }
  if (!list.length) {
    logs.push(
      `未解析到章节（tocUrl: ${fetchTocUrlFinal.slice(0, 120)}${fetchTocUrlFinal.length > 120 ? "…" : ""}）`,
    );
  }
  return list;
}

export async function getChapterContent(
  source: BookSourceRecord,
  chapterUrl: string,
  bookInput: Book | Record<string, unknown>,
  chapter: Record<string, unknown>,
  logs: string[] = [],
  nextChapterUrl?: string,
  chapterUrls?: string[],
): Promise<string> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const coerced = coerceBook(bookInput as Partial<Book>);
  const resolvedBookUrl = ensureBookUrlWithHeaders(coerced.bookUrl, host);
  const resolvedTocUrl = ensureBookUrlWithHeaders(
    coerced.tocUrl || coerced.bookUrl,
    host,
  );
  const { url: bookPageUrl, variables } = splitUrlAndRuleVariables(resolvedBookUrl);
  const { variables: tocVars } = splitUrlAndRuleVariables(resolvedTocUrl);
  Object.assign(variables, tocVars);
  let kind = stripNumericIdPrefix(coerced.kind);
  if (!kind) {
    kind = resolveBookKindForChapterRules("", resolvedTocUrl, bookPageUrl);
  }
  const book = toEngineBook(
    coerceBook({
      ...coerced,
      kind,
      bookUrl: bookPageUrl,
      tocUrl: resolvedTocUrl,
    }),
  );
  applyPersistedBookVariable(book, bookPageUrl);
  // ads-read 的 BookID 须用 toc/book 上的数字 id，勿用 kind 标签
  const bookIdForChapter =
    resolvedTocUrl.match(/[?&]bookId=([^&]+)/i)?.[1] ??
    resolvedTocUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
    bookPageUrl.match(/[?&](?:bookid|bookId|book_id)=([^&]+)/i)?.[1] ??
    ( /^\d+$/.test(kind) ? kind : "");
  const fetchChapterUrl = repairDuplicateBidInChapterUrl(
    repairChapterUrlBookId(
      chapterUrl,
      bookIdForChapter ? decodeURIComponent(bookIdForChapter) : "",
    ),
  );
  if (fetchChapterUrl !== chapterUrl) {
    chapter = { ...chapter, url: fetchChapterUrl };
  }
  const arInit = new AnalyzeRule(source, logs, host)
    .setBook(book)
    .setChapter(chapter)
    .setRuleData({ variable: { ...variables } });
  syncLegadoHeadersForRules(arInit, host, resolvedBookUrl, variables);
  syncLegadoHeadersForRules(arInit, host, resolvedTocUrl, variables);
  ensureBidVariable(
    arInit,
    variables,
    book,
    bookPageUrl,
    resolvedTocUrl,
    resolvedBookUrl,
  );
  arInit.setRuleData({ variable: { ...variables } });
  const rule = source.ruleContent ?? {};
  const titleRule = rule.title?.trim() || rule.chapterName?.trim() || "";
  const chapterTitle = String(chapter.title ?? "");
  const isVolume = Boolean(
    (chapter as { isVolume?: unknown }).isVolume === true ||
      (chapter as { isVolume?: unknown }).isVolume === "true",
  );

  // 对齐 Legado WebBook.getContent：一级目录（合成 url=标题+序号）不跑正文规则
  if (isVolume && fetchChapterUrl.startsWith(chapterTitle)) {
    logs.push("一级目录正文不解析规则");
    return String((chapter as { tag?: unknown }).tag ?? "").trim();
  }

  // 对齐 Legado：chapter.url == book.bookUrl 且有 tocHtml 时用缓存，免再请求
  const tocHtmlCached = coerced.tocHtml?.trim() ?? "";
  const useTocHtml =
    Boolean(tocHtmlCached) &&
    isSameBookPageUrl(fetchChapterUrl, coerced.bookUrl || bookPageUrl);

  let body: string;
  let redirectUrl: string;
  let resUrl: string;
  if (useTocHtml) {
    logs.push("章节 URL 与书籍页相同，使用 tocHtml 解析正文");
    body = tocHtmlCached;
    // 对齐 Legado：绝对化 nextContentUrl 用详情/目录真实页，勿用仍停在搜索页的书链
    redirectUrl =
      stripLegadoUrlOption(
        coerced.infoUrl ||
          coerced.tocUrl ||
          bookPageUrl ||
          fetchChapterUrl,
      ) || fetchChapterUrl;
    resUrl = redirectUrl;
  } else {
    const analyzeUrl = new AnalyzeUrl({
      mUrl: fetchChapterUrl,
      baseUrl: resolvedTocUrl || source.bookSourceUrl,
      source,
      host,
      logs,
      ruleVariables: variables,
      webJs: rule.webJs?.trim() || undefined,
      sourceRegex: rule.sourceRegex?.trim() || undefined,
    });
    const res = await fetchWithLoginCheck(analyzeUrl, source, "", logs);
    body = res.body;
    redirectUrl = res.url;
    resUrl = res.url;
  }

  const contentParts: string[] = [];
  const currentChapterUrl = String(chapter.url ?? fetchChapterUrl);

  const first = await fetchContentPage(
    source,
    host,
    logs,
    rule,
    body,
    resUrl,
    redirectUrl,
    { ...book, kind, bookUrl: bookPageUrl, tocUrl: resolvedTocUrl },
    chapter,
    variables,
    nextChapterUrl,
    true,
  );
  contentParts.push(first.content);

  // 页头+页脚各一下一页链 → getUrlList 得 2 条相同「下一章」URL；
  // 旧逻辑走 length>1 并发分支且不做边界判断，会把下一章拼进本章。
  const nextUrls = filterContentNextUrls(
    first.nextUrls,
    redirectUrl,
    nextChapterUrl,
    chapterUrls,
    currentChapterUrl,
    logs,
  );

  if (nextUrls.length === 1) {
    let next = nextUrls[0]!;
    const visited = new Set<string>([redirectUrl, resUrl]);
    while (next && !visited.has(next)) {
      if (
        isContentNextChapterBoundary(
          redirectUrl,
          next,
          nextChapterUrl,
          chapterUrls,
          currentChapterUrl,
        )
      ) {
        logs.push(
          `正文下一页已是章节边界，停止翻页: ${next.slice(0, 120)}`,
        );
        break;
      }
      visited.add(next);
      const nextAnalyze = new AnalyzeUrl({
        mUrl: next,
        baseUrl: resolvedTocUrl || source.bookSourceUrl,
        source,
        host,
        logs,
        ruleVariables: variables,
        webJs: rule.webJs?.trim() || undefined,
        sourceRegex: rule.sourceRegex?.trim() || undefined,
      });
      const nextRes = await fetchWithLoginCheck(nextAnalyze, source, "", logs);
      const page = await fetchContentPage(
        source,
        host,
        logs,
        rule,
        nextRes.body,
        nextRes.url,
        nextRes.url,
        { ...book, bookUrl: bookPageUrl, tocUrl: resolvedTocUrl },
        chapter,
        variables,
        nextChapterUrl,
        true,
      );
      contentParts.push(page.content);
      next =
        filterContentNextUrls(
          page.nextUrls,
          nextRes.url,
          nextChapterUrl,
          chapterUrls,
          currentChapterUrl,
          logs,
        )[0] ?? "";
      redirectUrl = nextRes.url;
    }
  } else if (nextUrls.length > 1) {
    const responses = await ajaxAllStrResponses(host, nextUrls);
    for (const resp of responses) {
      const pageBody = resp.body();
      const pageUrl = resp.url();
      if (!pageBody) continue;
      const page = await fetchContentPage(
        source,
        host,
        logs,
        rule,
        pageBody,
        pageUrl,
        pageUrl,
        { ...book, bookUrl: bookPageUrl, tocUrl: resolvedTocUrl },
        chapter,
        variables,
        nextChapterUrl,
        false,
      );
      contentParts.push(page.content);
    }
  }

  let content = contentParts.filter(Boolean).join("\n");
  const ar = new AnalyzeRule(source, logs, host)
    .setContent(body, resUrl)
    .setRedirectUrl(redirectUrl)
    .setBook(book)
    .setChapter(chapter)
    .setNextChapterUrl(nextChapterUrl);

  if (rule.subContent?.trim()) {
    try {
      const raw = await ar.getString(rule.subContent, body);
      if (raw.trim()) {
        let sub = raw.trim();
        if (/^https?:\/\//i.test(sub)) {
          const subRes = await new AnalyzeUrl({
            mUrl: sub,
            baseUrl: source.bookSourceUrl,
            source,
            host,
            logs,
          }).getStrResponse();
          sub = subRes.body;
        }
        if (sub.trim()) {
          content = content ? `${content}\n\n${sub.trim()}` : sub.trim();
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.log(`获取副文出错: ${msg}`);
    }
  }

  if (rule.replaceRegex?.trim()) {
    content = await applyContentReplaceRegex(ar, content, rule.replaceRegex);
  }

  // sophie
  if (/<img\b/i.test(content)) {
    console.log(
      "[inline-img] remains after source replaceRegex:",
      content.match(/<img\b[^>]*>/gi),
    );
  } else {
    console.log(
      "[inline-img] source replaceRegex resolved images",
    );
  }

  if (titleRule) {
    try {
      const t = await ar.getString(titleRule, body);
      if (t.trim()) {
        chapter.title = t.trim();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.log(`获取标题出错: ${msg}`);
    }
  }

  // 对齐 Legado ContentProcessor：去掉正文开头与章节名重复的标题行
  content = stripLeadingDuplicateChapterTitle(
    content,
    String(chapter.title ?? ""),
    String(book.name ?? ""),
  );

  content = content.trim();
  // 对齐 Legado BookContent：非分卷正文为空则抛错（阅读器显示「获取正文失败」）
  if (!isVolume && !content) {
    throw new Error("内容为空");
  }

  return content;
}

/**
 * Legado ContentProcessor「去除重复标题」：正文开头与章节名重复的一行。
 * 离线缓存读取路径也会调用，避免旧缓存仍带标题。
 */
export function stripLeadingDuplicateChapterTitle(
  content: string,
  chapterTitle: string,
  bookName = "",
): string {
  const title = chapterTitle.trim();
  if (!title || !content || content === "null") return content;
  try {
    const escapeRegex = (s: string) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titlePat = escapeRegex(title).replace(/\s+/g, "\\s*");
    const namePat = bookName.trim() ? escapeRegex(bookName.trim()) : "";
    const prefix = namePat
      ? `^(?:\\s|\\p{P}|${namePat})*${titlePat}\\s*`
      : `^(?:\\s|\\p{P})*${titlePat}\\s*`;
    return content.replace(new RegExp(prefix, "u"), "");
  } catch {
    return content;
  }
}

/** 对齐 Legado `String.isTrue()`：非空且非 false/no/not/0 */
function isTruthy(s: string): boolean {
  const v = s.trim().toLowerCase();
  if (!v) return false;
  return v !== "false" && v !== "no" && v !== "not" && v !== "0";
}

/**
 * 分卷标记：优先 isVolume 规则；规则为空时读 JS 目录项上的布尔/字符串字段
 * （部分书源 chapterList 直接返回 `{ isVolume: true }` 且未写 isVolume 规则）。
 */
async function resolveChapterIsVolume(
  ar: AnalyzeRule,
  rule: string | undefined | null,
  el: unknown,
): Promise<boolean> {
  if (rule?.trim()) {
    return isTruthy(await ar.getString(rule, el));
  }
  if (el != null && typeof el === "object" && !Array.isArray(el)) {
    const v = (el as Record<string, unknown>).isVolume;
    if (typeof v === "boolean") return v;
    if (v != null && v !== "") return isTruthy(String(v));
  }
  return false;
}

/** 常见搜索/列表页路径（详情 HTML 有时仍挂在搜索 URL 上） */
function isLikelySearchArticleUrl(url: string): boolean {
  const path = url.split(",")[0]?.trim() ?? "";
  return /\/search\.php(?:$|\?)/i.test(path) || /\/modules\/article\/search/i.test(path);
}

/**
 * 从详情 HTML 推断书籍目录根路径（如 `/数字_数字/`）。
 * 用于 POST 搜索直接返回详情、HTTP 未重定向时 `java.refreshBookUrl()` 仍停在搜索页的情况。
 */
function inferBookDirUrlFromDetailHtml(html: string, pageUrl: string): string {
  const base = normalizeBookSourceBaseUrl(pageUrl.split(",")[0] || pageUrl);
  try {
    const $ = loadCheerioHtml(html);
    const metaCandidates = [
      $('meta[property="og:url"]').attr("content"),
      $('meta[property="og:novel:read_url"]').attr("content"),
      $('link[rel="canonical"]').attr("href"),
    ];
    for (const raw of metaCandidates) {
      const u = String(raw ?? "").trim();
      if (!u || isLikelySearchArticleUrl(u)) continue;
      const abs = resolveAbsoluteUrl(base, u);
      if (/\/\d+_\d+\/?$/i.test(abs.split("?")[0] ?? "")) return abs.endsWith("/") ? abs : `${abs}/`;
    }
    let found = "";
    $("a[href]").each((_, el) => {
      if (found) return;
      const href = String($(el).attr("href") ?? "").trim();
      const m = href.match(/(\/\d+_\d+)\//);
      if (!m?.[1]) return;
      found = resolveAbsoluteUrl(base, `${m[1]}/`);
    });
    return found;
  } catch {
    return "";
  }
}
