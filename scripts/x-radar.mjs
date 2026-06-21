#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config', 'sources.json');
const ENV_PATH = join(ROOT, '.env');
const STATE_PATH = join(ROOT, 'state', 'seen-posts.json');
const USER_CACHE_PATH = join(ROOT, 'state', 'user-cache.json');
const REPORTS_DIR = join(ROOT, 'reports');
const LATEST_DATA_PATH = join(ROOT, 'public', 'data', 'latest.json');
const LATEST_BRIEFING_PATH = join(ROOT, 'public', 'data', 'briefing.json');
const ARCHIVE_DIR = join(ROOT, 'public', 'data', 'archive');
const ARCHIVE_INDEX_PATH = join(ARCHIVE_DIR, 'index.json');
const X_API_BASE = 'https://api.x.com/2';
const REQUEST_TIMEOUT_MS = 30_000;
const USER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const estimateCost = args.has('--estimate-cost');
const feedOnly = args.has('--feed-only') || args.has('--skip-api');
const discoverFollowingArg = getArgValue('--discover-following');
const discoverLimitArg = Number(getArgValue('--limit') || 200);

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function cleanHandle(handle = '') {
  return String(handle).trim().replace(/^@/, '').toLowerCase();
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function mapLimit(items, limit, task) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err.message}`);
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const text = await readFile(path, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadConfig() {
  const config = await readJson(CONFIG_PATH, null);
  if (!config) {
    throw new Error('Missing config/sources.json. Copy config/sources.example.json or add accounts there.');
  }
  const accounts = uniqBy(
    (config.accounts || [])
      .map(account => ({
        ...account,
        handle: cleanHandle(account.handle)
      }))
      .filter(account => account.handle),
    account => account.handle
  );
  const feedSources = uniqBy(
    (config.feedSources || [])
      .map(source => ({
        id: source.id || source.name || source.url,
        name: source.name || source.id || 'Feed',
        url: source.url,
        maxAgeHours: Number(source.maxAgeHours || 36),
        handles: uniqBy((source.handles || []).map(cleanHandle).filter(Boolean), handle => handle)
      }))
      .filter(source => source.id && source.url),
    source => source.id
  );
  return {
    timezone: config.timezone || 'Asia/Shanghai',
    lookbackHours: Number(config.lookbackHours || 24),
    maxPostsPerAccount: Math.max(1, Math.min(Number(config.maxPostsPerAccount || 3), 10)),
    includeReplies: Boolean(config.includeReplies),
    includeReposts: Boolean(config.includeReposts),
    language: config.language || 'zh-CN',
    feedSources,
    accounts
  };
}

async function loadState() {
  const state = await readJson(STATE_PATH, { seenPosts: {}, runs: [] });
  return {
    seenPosts: state.seenPosts || {},
    runs: state.runs || []
  };
}

async function loadUserCache() {
  const cache = await readJson(USER_CACHE_PATH, { usersByHandle: {}, updatedAt: null });
  return {
    usersByHandle: cache.usersByHandle || {},
    updatedAt: cache.updatedAt || null,
    dirty: false
  };
}

function isFreshCachedUser(user) {
  if (!user?.id) return false;
  const updatedAt = new Date(user.updatedAt || 0).getTime();
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= USER_CACHE_TTL_MS;
}

function cacheUser(userCache, user, generatedAt = new Date().toISOString()) {
  const handle = cleanHandle(user?.username);
  if (!handle || !user?.id) return;
  userCache.usersByHandle[handle] = {
    id: String(user.id),
    username: user.username || handle,
    name: user.name || user.username || handle,
    description: user.description || '',
    updatedAt: generatedAt
  };
  userCache.updatedAt = generatedAt;
  userCache.dirty = true;
}

async function saveUserCache(userCache) {
  if (!userCache?.dirty) return null;
  const { dirty, ...serializable } = userCache;
  await writeJson(USER_CACHE_PATH, serializable);
  userCache.dirty = false;
  return USER_CACHE_PATH;
}

async function xFetch(path, bearerToken) {
  const url = `${X_API_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`X API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    return xFetchWithPowerShell(url, bearerToken, err);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.detail || data?.title || data?.errors?.[0]?.detail || text || `HTTP ${res.status}`;
    throw new Error(`X API ${res.status}: ${detail}`);
  }
  return data;
}

async function xFetchWithPowerShell(url, bearerToken, originalError) {
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = $utf8',
    '[Console]::InputEncoding = $utf8',
    'Add-Type -AssemblyName System.Net.Http',
    '$client = New-Object System.Net.Http.HttpClient',
    '$client.Timeout = [TimeSpan]::FromSeconds(30)',
    '$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $env:X_BEARER_TOKEN)',
    'try {',
    '  $res = $client.GetAsync($env:X_RADAR_URL).GetAwaiter().GetResult()',
    '  $bytes = $res.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()',
    '  if (-not $res.IsSuccessStatusCode) {',
    '    [Console]::Error.Write($utf8.GetString($bytes))',
    '    exit ([int]$res.StatusCode)',
    '  }',
    '  $stdout = [Console]::OpenStandardOutput()',
    '  $stdout.Write($bytes, 0, $bytes.Length)',
    '  $stdout.Flush()',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.Write($_.Exception.Message)',
    '  exit 1',
    '} finally {',
    '  $client.Dispose()',
    '}'
  ].join('; ');

  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
      env: {
        ...process.env,
        X_RADAR_URL: url,
        X_BEARER_TOKEN: bearerToken
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: REQUEST_TIMEOUT_MS + 15_000
    });
    return stdout ? JSON.parse(stdout) : null;
  } catch (err) {
    const stderr = String(err.stderr || '').trim();
    let detail = stderr || err.message;
    try {
      const parsed = JSON.parse(stderr);
      detail = parsed.detail || parsed.title || parsed.errors?.[0]?.detail || stderr;
    } catch {}
    throw new Error(`X API request failed after native fetch error (${originalError.message}): ${detail}`);
  }
}

async function fetchJsonUrl(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'x-radar-local/1.0'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Feed returned invalid JSON from ${url}`);
  }
  if (!res.ok) {
    throw new Error(`Feed HTTP ${res.status}: ${data?.message || text || res.statusText}`);
  }
  return data;
}

async function lookupUsers(accounts, bearerToken, userCache = { usersByHandle: {} }) {
  const byHandle = new Map();
  const errors = [];
  const missingAccounts = [];

  for (const account of accounts) {
    const handle = cleanHandle(account.handle);
    const cached = userCache.usersByHandle?.[handle];
    if (isFreshCachedUser(cached)) {
      byHandle.set(handle, {
        id: cached.id,
        username: cached.username || handle,
        name: cached.name || account.name || handle,
        description: cached.description || ''
      });
    } else {
      missingAccounts.push(account);
    }
  }

  let userReads = 0;
  const fetchedAt = new Date().toISOString();
  for (let i = 0; i < missingAccounts.length; i += 100) {
    const batch = missingAccounts.slice(i, i + 100);
    const usernames = batch.map(account => account.handle).join(',');
    if (!usernames) continue;
    userReads += batch.length;
    try {
      const data = await xFetch(`/users/by?usernames=${encodeURIComponent(usernames)}&user.fields=name,description,username`, bearerToken);
      for (const user of data.data || []) {
        const handle = cleanHandle(user.username);
        byHandle.set(handle, user);
        cacheUser(userCache, user, fetchedAt);
      }
      for (const err of data.errors || []) {
        errors.push(`User lookup: ${err.value || err.detail || JSON.stringify(err)}`);
      }
    } catch (err) {
      errors.push(`User lookup batch failed: ${err.message}`);
    }
  }
  return { byHandle, errors, userReads, cacheHits: accounts.length - missingAccounts.length };
}

async function discoverFollowing(handle, bearerToken, limit = 200) {
  const sourceHandle = cleanHandle(handle);
  if (!sourceHandle) throw new Error('Pass a handle, for example --discover-following @DianZhiAI');
  const { byHandle, errors } = await lookupUsers([{ handle: sourceHandle }], bearerToken);
  const user = byHandle.get(sourceHandle);
  if (!user) {
    throw new Error(`Could not find @${sourceHandle}${errors.length ? `: ${errors.join('; ')}` : ''}`);
  }

  const following = [];
  let paginationToken = null;
  while (following.length < limit) {
    const params = new URLSearchParams();
    params.set('max_results', String(Math.min(1000, Math.max(1, limit - following.length))));
    params.set('user.fields', 'name,username,description');
    if (paginationToken) params.set('pagination_token', paginationToken);
    const data = await xFetch(`/users/${user.id}/following?${params.toString()}`, bearerToken);
    for (const item of data.data || []) {
      following.push({
        handle: item.username,
        name: item.name || item.username,
        description: item.description || ''
      });
      if (following.length >= limit) break;
    }
    paginationToken = data.meta?.next_token || null;
    if (!paginationToken || !data.data?.length) break;
  }

  return {
    source: {
      handle: user.username,
      name: user.name,
      id: user.id
    },
    generatedAt: new Date().toISOString(),
    count: following.length,
    following
  };
}

function buildTweetQuery(userId, config) {
  const params = new URLSearchParams();
  params.set('max_results', String(Math.max(5, config.maxPostsPerAccount * 2)));
  params.set('tweet.fields', 'created_at,public_metrics,referenced_tweets,note_tweet,entities,lang,conversation_id');
  params.set('expansions', 'referenced_tweets.id');
  params.set('start_time', new Date(Date.now() - config.lookbackHours * 60 * 60 * 1000).toISOString());
  const excludes = [];
  if (!config.includeReplies) excludes.push('replies');
  if (!config.includeReposts) excludes.push('retweets');
  if (excludes.length) params.set('exclude', excludes.join(','));
  return `/users/${userId}/tweets?${params.toString()}`;
}

function normalizePost(tweet, account, user) {
  const metrics = tweet.public_metrics || {};
  const quoted = (tweet.referenced_tweets || []).find(item => item.type === 'quoted');
  return {
    id: tweet.id,
    handle: account.handle,
    name: account.name || user.name || account.handle,
    text: tweet.note_tweet?.text || tweet.text || '',
    createdAt: tweet.created_at || null,
    url: `https://x.com/${account.handle}/status/${tweet.id}`,
    metrics: {
      likes: metrics.like_count || 0,
      reposts: metrics.retweet_count || 0,
      replies: metrics.reply_count || 0,
      quotes: metrics.quote_count || 0
    },
    lang: tweet.lang || null,
    quotedPostId: quoted?.id || null,
    source: {
      type: 'x-api',
      label: 'X API'
    }
  };
}

function isFeedFresh(feedData, feedSource) {
  if (!feedData?.generatedAt) return true;
  const generatedAt = new Date(feedData.generatedAt).getTime();
  if (!Number.isFinite(generatedAt)) return false;
  const maxAgeMs = Math.max(1, feedSource.maxAgeHours || 36) * 60 * 60 * 1000;
  return Date.now() - generatedAt <= maxAgeMs;
}

function isFeedPostAllowed(tweet, config) {
  if (!tweet?.id) return false;
  const createdAt = new Date(tweet.createdAt || 0).getTime();
  const cutoff = Date.now() - config.lookbackHours * 60 * 60 * 1000;
  if (!Number.isFinite(createdAt) || createdAt < cutoff) return false;

  const text = String(tweet.text || '').trim();
  if (!config.includeReplies && /^@\w+/i.test(text)) return false;
  if (!config.includeReposts && /^RT\s+@/i.test(text)) return false;
  return true;
}

function normalizeFeedPost(tweet, account, feedAccount, feedSource, feedData) {
  const handle = account.handle;
  return {
    id: String(tweet.id),
    handle,
    name: account.name || feedAccount.name || handle,
    text: tweet.text || '',
    createdAt: tweet.createdAt || null,
    url: tweet.url || `https://x.com/${handle}/status/${tweet.id}`,
    metrics: {
      likes: Number(tweet.likes || 0),
      reposts: Number(tweet.retweets || tweet.reposts || 0),
      replies: Number(tweet.replies || 0),
      quotes: Number(tweet.quotes || 0)
    },
    lang: tweet.lang || null,
    quotedPostId: tweet.quotedTweetId || null,
    source: {
      type: 'feed',
      id: feedSource.id,
      label: feedSource.name,
      generatedAt: feedData.generatedAt || null
    }
  };
}

async function fetchFeedAccounts(config, state) {
  const errors = [];
  const accounts = [];
  const coveredHandles = new Set();
  const sourceStats = [];
  const configuredByHandle = new Map(config.accounts.map(account => [account.handle, account]));

  for (const feedSource of config.feedSources || []) {
    const stat = {
      id: feedSource.id,
      name: feedSource.name,
      url: feedSource.url,
      generatedAt: null,
      fresh: false,
      accountsAvailable: 0,
      accountsMatched: 0,
      accountsCovered: 0,
      accountsWithNewPosts: 0,
      postsUsed: 0,
      errors: []
    };

    let feedData;
    try {
      feedData = await fetchJsonUrl(feedSource.url);
      stat.generatedAt = feedData?.generatedAt || null;
      stat.fresh = isFeedFresh(feedData, feedSource);
      if (!stat.fresh) {
        stat.errors.push(`Feed is older than ${feedSource.maxAgeHours}h.`);
        sourceStats.push(stat);
        errors.push(`${feedSource.name}: feed is stale, falling back to X API for covered accounts.`);
        continue;
      }
    } catch (err) {
      stat.errors.push(err.message);
      sourceStats.push(stat);
      errors.push(`${feedSource.name}: ${err.message}. Falling back to X API for covered accounts.`);
      continue;
    }

    const feedAccounts = Array.isArray(feedData?.x) ? feedData.x : [];
    stat.accountsAvailable = feedAccounts.length;

    for (const feedAccount of feedAccounts) {
      const handle = cleanHandle(feedAccount.handle);
      const account = configuredByHandle.get(handle);
      if (!account) continue;
      stat.accountsMatched += 1;
      stat.accountsCovered += 1;
      coveredHandles.add(handle);

      const posts = [];
      for (const tweet of feedAccount.tweets || []) {
        if (state.seenPosts[tweet.id]) continue;
        if (!isFeedPostAllowed(tweet, config)) continue;
        posts.push(normalizeFeedPost(tweet, account, feedAccount, feedSource, feedData));
        if (posts.length >= config.maxPostsPerAccount) break;
      }

      if (posts.length) {
        stat.accountsWithNewPosts += 1;
        stat.postsUsed += posts.length;
        accounts.push({
          handle,
          name: account.name || feedAccount.name || handle,
          bio: feedAccount.bio || '',
          sourceType: 'feed',
          sourceLabel: feedSource.name,
          posts
        });
      }
    }

    sourceStats.push(stat);
  }

  return { accounts, errors, coveredHandles, sourceStats };
}

async function fetchRecentPosts(config, bearerToken, state, options = {}) {
  const feedResult = await fetchFeedAccounts(config, state);
  const fallbackAccounts = config.accounts.filter(account => !feedResult.coveredHandles.has(account.handle));
  const apiAccounts = options.feedOnly ? [] : fallbackAccounts;
  const lookupResult = apiAccounts.length
    ? await lookupUsers(apiAccounts, bearerToken, options.userCache)
    : { byHandle: new Map(), errors: [], userReads: 0, cacheHits: 0 };
  const { byHandle, errors: lookupErrors } = lookupResult;
  const errors = [...feedResult.errors, ...lookupErrors];
  const accounts = [...feedResult.accounts];
  let xApiPosts = 0;

  async function fetchApiAccount(account) {
    const user = byHandle.get(account.handle);
    if (!user) return null;

    try {
      const data = await xFetch(buildTweetQuery(user.id, config), bearerToken);
      const posts = [];
      for (const tweet of data.data || []) {
        if (state.seenPosts[tweet.id]) continue;
        posts.push(normalizePost(tweet, account, user));
        if (posts.length >= config.maxPostsPerAccount) break;
      }
      if (posts.length) {
        xApiPosts += posts.length;
        accounts.push({
          handle: account.handle,
          name: account.name || user.name || account.handle,
          bio: user.description || '',
          sourceType: 'x-api',
          sourceLabel: 'X API',
          posts
        });
      }
    } catch (err) {
      errors.push(`@${account.handle}: ${err.message}`);
    }
  }

  await mapLimit(apiAccounts, 4, fetchApiAccount);

  const feedPosts = feedResult.accounts.reduce((sum, account) => sum + account.posts.length, 0);
  return {
    accounts,
    errors,
    sourceStats: {
      feedAccounts: feedResult.coveredHandles.size,
      xApiAccounts: apiAccounts.length,
      feedPosts,
      xApiPosts,
      skippedXApiAccounts: options.feedOnly ? fallbackAccounts.length : 0,
      xApiPostReadsEstimated: apiAccounts.length * Math.max(5, config.maxPostsPerAccount * 2),
      xApiUserReadsEstimated: lookupResult.userReads,
      xApiUserCacheHits: lookupResult.cacheHits,
      feeds: feedResult.sourceStats
    }
  };
}

function summarizeText(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '这条帖子没有可读取的正文。';
  const withoutLinks = compact.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const source = withoutLinks || compact;
  const sentence = source.split(/(?<=[。！？!?])\s+|(?<=\.)\s+(?=[A-Z0-9])/)[0] || source;
  if (sentence.length <= 220) return sentence;
  return `${sentence.slice(0, 219)}...`;
}

function includesAny(text, words) {
  return words.some(word => text.includes(word.toLowerCase()));
}

function pickTopics(text) {
  const lower = text.toLowerCase();
  const topicRules = [
    { id: 'ai', label: 'AI / 模型', words: ['ai', 'agent', 'llm', 'openai', 'anthropic', 'model', '智能体', '模型', '人工智能'] },
    { id: 'crypto', label: 'Crypto / Web3', words: ['crypto', 'bitcoin', 'ethereum', 'web3', 'defi', 'binance', 'okx', '链上', '加密', '币安'] },
    { id: 'market', label: '市场 / 投资', words: ['stock', 'market', 'gpu', 'cpu', 'revenue', '美股', '股价', '财报', '投资', '资本'] },
    { id: 'security', label: '安全 / 风险', words: ['hack', 'attack', 'breach', 'exploit', 'risk', 'stolen', '被盗', '攻击', '漏洞', '风险'] },
    { id: 'regulation', label: '监管 / 合规', words: ['regulation', 'compliance', 'license', '监管', '合规', '牌照', '法院'] },
    { id: 'creator', label: '创作者 / 内容', words: ['youtube', 'substack', 'creator', 'newsletter', '内容', '油管', '创作者'] },
    { id: 'product', label: '产品 / 公司', words: ['launch', 'product', 'feature', 'startup', '产品', '发布', '公司', '业务'] }
  ];
  const matches = topicRules.filter(rule => includesAny(lower, rule.words));
  return matches.length ? matches.slice(0, 3).map(rule => rule.label) : ['综合'];
}

function classifyPost(post) {
  const text = String(post.text || '').trim();
  const lower = text.toLowerCase();
  if (!text) return '空正文';
  if (/^(https?:\/\/\S+\s*)+$/.test(text)) return '链接';
  if (text.length > 800) return '长文';
  if (post.quotedPostId) return '引用评论';
  if (includesAny(lower, ['ceo', 'founder', 'report', '报道称', '表示', '宣布', '发布'])) return '资讯';
  if (includesAny(lower, ['i think', 'why', 'how', '观点', '认为', '觉得', '建议'])) return '观点';
  return '动态';
}

function lowSignalReason(post) {
  const text = String(post.text || '').trim().toLowerCase();
  const textWithoutUrls = text.replace(/https?:\/\/\S+/g, '').trim();
  if (!text) return '正文为空，无法判断信息量。';
  if (/^(https?:\/\/\S+\s*)+$/.test(text)) return '只有链接，需要打开原文才能判断价值。';
  if (/https?:\/\//.test(text) && textWithoutUrls.length <= 8 && !/[a-z0-9\u4e00-\u9fff]{2,}/i.test(textWithoutUrls)) {
    return '只有表情或极短提示加链接，离线状态下缺少可判断信息。';
  }
  if (/^(gm|good morning|thanks|thank you|congrats)[\s!！。,.，🫶]*$/i.test(text) || /(恭喜|节日快乐|假期快乐|端午安康|家人们)/.test(text)) {
    return '偏社交互动，信息密度较低。';
  }
  if (text.length < 24 && !post.quotedPostId) return '正文较短，缺少可分析上下文。';
  return null;
}

function buildWhyItMatters(post, topics, type, score, lowSignal) {
  if (lowSignal) return lowSignal;
  if (topics.includes('安全 / 风险')) return '这类内容可能提示真实风险或资金损失，适合优先核对细节和来源。';
  if (topics.includes('监管 / 合规')) return '它反映了行业规则和平台边界的变化，可能影响后续业务判断。';
  if (topics.includes('AI / 模型')) return '它可能包含 AI 能力、成本、产品或工作流的新变化，适合判断是否值得学习或跟进。';
  if (topics.includes('市场 / 投资')) return '它可能包含标的、估值、催化剂或持仓倾向线索，适合后续交叉验证。';
  if (topics.includes('Crypto / Web3')) return '它可能涉及加密市场叙事、项目机会或风险，适合快速判断是否需要跟踪。';
  if (type === '长文') return '这是一条长内容，只有在包含新信息、方法论或可行动线索时才值得精读。';
  if (score >= 75) return '这条内容命中了新信息、学习价值或可行动线索，值得优先查看。';
  return '这条内容有一定上下文价值，但未必需要深入处理。';
}

function buildActionSuggestion(post, topics, type, lowSignal) {
  if (lowSignal) return '建议低优先级处理，除非该账号本身很重要。';
  if (type === '长文') return '建议先判断是否有新信息或具体行动线索，再决定是否精读。';
  if (topics.includes('安全 / 风险')) return '建议打开原文核对涉事项目、金额、时间线和来源。';
  if (topics.includes('市场 / 投资')) return '建议提取标的、倾向、催化剂和风险，只作为研究线索，不直接当作交易依据。';
  if (topics.includes('AI / 模型')) return '建议记录具体变化点，并观察它是否影响工具选型、产品机会或成本结构。';
  return '建议快速浏览，保留原文链接即可。';
}

function analyzePost(post) {
  const text = String(post.text || '');
  const topics = pickTopics(text);
  const type = classifyPost(post);
  const score = scorePost(post);
  const lowSignal = lowSignalReason(post);
  return {
    method: 'local-rules-v1',
    topics,
    type,
    signal: lowSignal ? '低信号' : score >= 75 ? '高信号' : score >= 55 ? '中信号' : '低信号',
    whyItMatters: buildWhyItMatters(post, topics, type, score, lowSignal),
    action: buildActionSuggestion(post, topics, type, lowSignal),
    caveat: '本分析由本地规则生成，不是 LLM 深度总结。'
  };
}

function scorePost(post) {
  const m = post.metrics || {};
  const engagement = m.likes + m.reposts * 2 + m.replies * 1.5 + m.quotes * 2;
  const lowSignal = lowSignalReason(post);
  if (lowSignal) return 20;

  const text = String(post.text || '').toLowerCase();
  const newInfoWords = [
    'announce', 'announced', 'launch', 'launched', 'release', 'released', 'report', 'reportedly',
    'partnership', 'export', 'exported', 'pricing', 'benchmark', 'guidance',
    '宣布', '发布', '上线', '推出', '报道', '据称', '合作', '出口', '价格', '定价', '财报', '监管', '政策'
  ];
  const learningWords = [
    'how', 'why', 'breakdown', 'deep dive', 'guide', 'workflow', 'architecture', 'api',
    'latency', 'cost', 'model', 'agent', 'automation',
    '如何', '为什么', '拆解', '复盘', '指南', '工作流', '架构', '成本', '模型', '智能体', '自动化'
  ];
  const actionWords = [
    'buy', 'sell', 'long', 'short', 'position', 'exposure', 'watchlist', 'research',
    'valuation', 'nav', 'discount', 'catalyst', 'earnings', 'revenue', '$',
    '买入', '卖出', '看多', '看空', '持仓', '仓位', '敞口', '关注', '研究', '估值', '折价', '催化剂', '收入'
  ];
  const topicWords = [
    'ai', 'agent', 'llm', 'model', 'gpu', 'cpu', 'asml', 'euv', 'semiconductor',
    'crypto', 'bitcoin', 'ethereum', 'startup', 'product',
    '产品', '半导体', '加密', '创业', '公司'
  ];
  const personalWords = [
    '人生', '享受', '创造', '成就感', '选择', '上瘾', '心态', '生活', '情绪'
  ];
  const countHits = words => words.filter(word => text.includes(word)).length;
  const newHits = countHits(newInfoWords);
  const learningHits = countHits(learningWords);
  const actionHits = countHits(actionWords);
  const topicHits = countHits(topicWords);
  const personalHits = countHits(personalWords);
  const engagementBoost = Math.min(8, Math.log10(engagement + 1) * 3);
  let score = 28 + newHits * 14 + learningHits * 12 + actionHits * 18 + topicHits * 6 + engagementBoost;

  if (personalHits && !newHits && !learningHits && !actionHits) score -= 22;
  if (typeLooksLikeQuestionWithoutContext(text)) score -= 8;

  return Math.round(Math.max(10, Math.min(100, score)));
}

function typeLooksLikeQuestionWithoutContext(text) {
  return text.length < 80 && /^(why|how|what|谁|什么|为什么|如何)/i.test(text) && !/\$|ai|asml|euv|model|模型|标的|公司/.test(text);
}

function formatMetrics(metrics = {}) {
  const parts = [];
  if (metrics.likes) parts.push(`${metrics.likes} likes`);
  if (metrics.reposts) parts.push(`${metrics.reposts} reposts`);
  if (metrics.replies) parts.push(`${metrics.replies} replies`);
  if (metrics.quotes) parts.push(`${metrics.quotes} quotes`);
  return parts.join(', ') || 'no visible engagement';
}

function formatDate(iso, timezone) {
  if (!iso) return 'unknown time';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false
  }).format(new Date(iso));
}

function renderReport({ config, accounts, errors, generatedAt, sourceStats }) {
  const totalPosts = accounts.reduce((sum, account) => sum + account.posts.length, 0);
  const lines = [];
  lines.push(`# X 关注雷达`);
  lines.push('');
  lines.push(`生成时间：${formatDate(generatedAt, config.timezone)}`);
  lines.push(`窗口：最近 ${config.lookbackHours} 小时`);
  lines.push(`新帖子：${totalPosts} 条，账号：${accounts.length} 个`);
  if (sourceStats) {
    lines.push(`来源：Feed ${sourceStats.feedAccounts || 0} 个账号 / X API ${sourceStats.xApiAccounts || 0} 个账号`);
  }
  lines.push('');

  if (totalPosts === 0) {
    lines.push('没有发现未汇报的新帖子。');
    lines.push('');
  }

  const ranked = accounts
    .flatMap(account => account.posts.map(post => ({ ...post, score: scorePost(post) })))
    .sort((a, b) => b.score - a.score);

  if (ranked.length) {
    lines.push('## 今日优先看');
    lines.push('');
    for (const post of ranked.slice(0, 5)) {
      lines.push(`- **${post.score}/100** [@${post.handle}](${post.url})：${summarizeText(post.text)}`);
    }
    lines.push('');
  }

  for (const account of accounts) {
    lines.push(`## @${account.handle} ${account.name ? `- ${account.name}` : ''}`);
    lines.push('');
    for (const post of account.posts) {
      const score = scorePost(post);
      lines.push(`### ${formatDate(post.createdAt, config.timezone)} · ${score}/100`);
      lines.push('');
      lines.push(summarizeText(post.text));
      lines.push('');
      lines.push(`互动：${formatMetrics(post.metrics)}`);
      lines.push('');
      lines.push(`[原文](${post.url})`);
      lines.push('');
    }
  }

  if (errors.length) {
    lines.push('## 抓取提示');
    lines.push('');
    for (const err of errors) lines.push(`- ${err}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function flattenPosts(accounts) {
  return accounts
    .flatMap(account => account.posts.map(post => ({
      ...post,
      summary: summarizeText(post.text),
      score: scorePost(post),
      analysis: analyzePost(post)
    })))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function buildLatestData({ config, accounts, errors, generatedAt, sourceStats }) {
  const posts = flattenPosts(accounts);
  return {
    generatedAt,
    window: {
      lookbackHours: config.lookbackHours,
      timezone: config.timezone,
      includeReplies: config.includeReplies,
      includeReposts: config.includeReposts
    },
    stats: {
      accountsConfigured: config.accounts.length,
      accountsWithNewPosts: accounts.length,
      totalPosts: posts.length,
      errors: errors.length,
      feedAccounts: sourceStats?.feedAccounts || 0,
      xApiAccounts: sourceStats?.xApiAccounts ?? config.accounts.length,
      feedPosts: sourceStats?.feedPosts || 0,
      xApiPosts: sourceStats?.xApiPosts || 0,
      skippedXApiAccounts: sourceStats?.skippedXApiAccounts || 0,
      xApiPostReadsEstimated: sourceStats?.xApiPostReadsEstimated || 0,
      xApiUserReadsEstimated: sourceStats?.xApiUserReadsEstimated || 0,
      xApiUserCacheHits: sourceStats?.xApiUserCacheHits || 0
    },
    sources: sourceStats || null,
    analysisMethod: 'local-rules-v1',
    accounts: accounts.map(account => ({
      handle: account.handle,
      name: account.name,
      bio: account.bio || '',
      postCount: account.posts.length,
      sourceType: account.sourceType || account.posts[0]?.source?.type || 'x-api',
      sourceLabel: account.sourceLabel || account.posts[0]?.source?.label || 'X API'
    })),
    posts: posts.map(post => ({
      id: post.id,
      handle: post.handle,
      name: post.name,
      text: post.text,
      summary: post.summary,
      createdAt: post.createdAt,
      url: post.url,
      metrics: post.metrics,
      score: post.score,
      analysis: post.analysis,
      lang: post.lang,
      quotedPostId: post.quotedPostId,
      source: post.source || null
    })),
    errors
  };
}

async function saveReport(markdown) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(REPORTS_DIR, `x-radar-${stamp}.md`);
  await writeFile(path, markdown, 'utf8');
  return path;
}

async function saveLatestData(data) {
  await writeJson(LATEST_DATA_PATH, data);
  return LATEST_DATA_PATH;
}

function safeStamp(iso) {
  return new Date(iso).toISOString().replace(/[:.]/g, '-');
}

function signalFromPost(post) {
  const importance = post.codexAnalysis?.importance;
  if (importance >= 4) return { level: 'high', label: '高信号', importance };
  if (importance === 3) return { level: 'mid', label: '中信号', importance };
  if (importance >= 1) return { level: 'low', label: '低信号', importance };

  const signal = post.analysis?.signal || '低信号';
  if (signal === '高信号') return { level: 'high', label: signal, importance: null };
  if (signal === '中信号') return { level: 'mid', label: signal, importance: null };
  return { level: 'low', label: '低信号', importance: null };
}

function postBrief(post) {
  const codex = post.codexAnalysis || {};
  const analysis = post.analysis || {};
  const signal = signalFromPost(post);
  return {
    id: post.id,
    handle: post.handle,
    name: post.name,
    createdAt: post.createdAt,
    url: post.url,
    signal,
    title: codex.llmSummary || post.summary || summarizeText(post.text),
    whyItMatters: codex.whyItMatters || analysis.whyItMatters || '',
    action: codex.action || analysis.action || '',
    risk: codex.risk || '',
    investmentSignal: codex.investmentSignal || null,
    tags: codex.tags || analysis.topics || [],
    textPreview: summarizeText(post.text)
  };
}

function briefingCategory(post) {
  const text = `${post.text || ''} ${(post.codexAnalysis?.tags || []).join(' ')} ${(post.analysis?.topics || []).join(' ')}`.toLowerCase();
  if (/\$|stock|nav|discount|valuation|catalyst|revenue|earnings|buy|sell|long|short|持仓|仓位|敞口|标的|估值|折价|催化剂|投资|美股/.test(text)) {
    return 'investment';
  }
  if (/ai|agent|llm|model|api|workflow|automation|gpu|cpu|asml|euv|semiconductor|模型|智能体|自动化|半导体|产品|成本/.test(text)) {
    return 'technology';
  }
  if (/risk|hack|breach|regulation|policy|export|compliance|风险|监管|政策|出口|合规|漏洞/.test(text)) {
    return 'risk';
  }
  if ((post.text || '').length > 500 || /article|newsletter|substack|thread|文章|长文|报告/.test(text)) {
    return 'reading';
  }
  return 'other';
}

function uniqueStrings(items, limit = 8) {
  return [...new Set(items.filter(Boolean).map(String))].slice(0, limit);
}

function extractTickers(text = '') {
  return [...String(text).matchAll(/\$[A-Z][A-Z0-9.]{1,9}\b/g)].map(match => match[0].toUpperCase());
}

function topicForPost(post, category) {
  const text = String(post.text || '');
  const lower = text.toLowerCase();
  const tags = [...(post.codexAnalysis?.tags || []), ...(post.analysis?.topics || [])].map(String);
  const tagText = tags.join(' ').toLowerCase();
  const tickers = extractTickers(text);

  if (/claude code|artifacts/.test(lower) || /claude code|artifacts/.test(tagText)) {
    return { key: 'tech-claude-code-artifacts', title: 'Claude Code Artifacts', category: 'technology' };
  }
  if (/fable/.test(lower) || /fable/.test(tagText)) {
    return { key: 'tech-fable', title: 'Fable', category: 'technology' };
  }
  if (/neocloud|h100|gpu|nvidia|lambda/.test(lower) || /neocloud|h100|gpu|nvidia|lambda/.test(tagText)) {
    return { key: 'investment-ai-compute-neocloud', title: 'AI compute / neocloud', category: 'investment' };
  }
  if (/artie_labs|artie labs/.test(lower) || /artie labs/.test(tagText)) {
    return { key: 'investment-artie-labs', title: 'Artie Labs', category: 'investment' };
  }
  if (/\bintc\b|\$intc|intel/.test(lower)) {
    return { key: 'investment-intc-policy', title: 'INTC / Apple / 政策催化', category: 'investment' };
  }
  if (/nav|discount|折价/.test(lower) || /nav|折价/.test(tagText)) {
    return { key: 'investment-nav-ai-discount', title: 'NAV 折价 + AI 增长敞口', category: 'investment' };
  }
  if (/asml|euv|semiconductor|半导体|出口管制/.test(lower) || /asml|euv|半导体/.test(tagText)) {
    return { key: 'tech-asml-euv-export', title: 'ASML / EUV / 出口管制', category: 'technology' };
  }
  if (/ai|llm|model|agent|模型|智能|成本/.test(lower) || /ai|模型|成本/.test(tagText)) {
    return { key: 'tech-ai-model-cost', title: 'AI 模型成本 / 产品机会', category: 'technology' };
  }
  if (tickers.length) {
    return { key: `investment-${tickers.slice(0, 3).join('-')}`, title: `${tickers.slice(0, 3).join(' / ')} 投资线索`, category: 'investment' };
  }
  const firstTag = tags[0];
  if (firstTag) {
    return { key: `${category}-${firstTag}`.toLowerCase().replace(/\s+/g, '-'), title: firstTag, category };
  }
  return { key: `${category}-other`, title: '其他线索', category };
}

function buildTopics(enriched) {
  const groups = new Map();
  for (const item of enriched) {
    if (item.brief.signal.level === 'low') continue;
    const topic = topicForPost(item.post, item.category);
    if (!groups.has(topic.key)) {
      groups.set(topic.key, {
        id: topic.key,
        title: topic.title,
        category: topic.category,
        posts: [],
        tags: [],
        handles: new Set(),
        importance: 0,
        updatedAt: null
      });
    }
    const group = groups.get(topic.key);
    group.posts.push(item.brief);
    group.tags.push(...(item.brief.tags || []));
    group.handles.add(item.brief.handle);
    group.importance = Math.max(group.importance, item.brief.signal.importance || (item.brief.signal.level === 'high' ? 4 : 3));
    if (!group.updatedAt || new Date(item.brief.createdAt || 0) > new Date(group.updatedAt || 0)) {
      group.updatedAt = item.brief.createdAt;
    }
  }

  return [...groups.values()]
    .map(group => ({
      id: group.id,
      title: group.title,
      category: group.category,
      signal: {
        level: group.importance >= 4 ? 'high' : group.importance === 3 ? 'mid' : 'low',
        label: group.importance >= 4 ? '高信号' : group.importance === 3 ? '中信号' : '低信号',
        importance: group.importance
      },
      sourceCount: group.posts.length,
      handles: [...group.handles],
      tags: uniqueStrings(group.tags),
      updatedAt: group.updatedAt,
      whyItMatters: uniqueStrings(group.posts.map(post => post.whyItMatters), 2).join('；'),
      action: group.posts.find(post => post.action)?.action || '',
      risk: group.posts.find(post => post.risk)?.risk || '',
      posts: group.posts
    }))
    .sort((a, b) => b.signal.importance - a.signal.importance || b.sourceCount - a.sourceCount || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function compactBrief(item) {
  return {
    id: item.id,
    title: item.title,
    handle: item.handle,
    name: item.name,
    createdAt: item.createdAt,
    url: item.url,
    signal: item.signal,
    investmentSignal: item.investmentSignal || null,
    tags: item.tags || []
  };
}

function buildDigest({ generatedAt, counts, topics, high, mid, low }) {
  const leadTopics = topics.slice(0, 3).map(topic => topic.title);
  const leadText = counts.high
    ? `本次扫描 ${counts.total} 条帖子，筛出 ${counts.high} 条高信号。重点集中在${leadTopics.length ? `：${leadTopics.join('、')}` : '若干主题'}。`
    : `本次扫描 ${counts.total} 条帖子，没有明显高信号内容，适合快速浏览后归档。`;

  return {
    version: 'daily-briefing-v1',
    generatedAt,
    lead: {
      title: '今日摘要',
      text: leadText
    },
    counts,
    topStories: high.slice(0, 4).map(item => compactBrief(item)),
    topicArchive: topics.map(topic => ({
      id: topic.id,
      title: topic.title,
      signal: topic.signal,
      sourceCount: topic.sourceCount,
      handles: topic.handles || [],
      tags: topic.tags || [],
      items: (topic.posts || []).slice(0, 5).map(item => compactBrief(item))
    })),
    midStories: mid.slice(0, 10).map(item => compactBrief(item)),
    lowSignal: {
      count: low.length,
      items: low.slice(0, 20).map(item => compactBrief(item))
    }
  };
}

function buildBriefing(data) {
  const posts = data.posts || [];
  const enriched = posts.map(post => ({ post, brief: postBrief(post), category: briefingCategory(post) }));
  const sortBriefs = items => items
    .map(item => item.brief)
    .sort((a, b) => {
      const ai = a.signal.importance ?? (a.signal.level === 'high' ? 4 : a.signal.level === 'mid' ? 3 : 1);
      const bi = b.signal.importance ?? (b.signal.level === 'high' ? 4 : b.signal.level === 'mid' ? 3 : 1);
      return bi - ai || new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  const byCategory = category => sortBriefs(enriched.filter(item => item.category === category && item.brief.signal.level !== 'low'));
  const high = sortBriefs(enriched.filter(item => item.brief.signal.level === 'high'));
  const mid = sortBriefs(enriched.filter(item => item.brief.signal.level === 'mid'));
  const low = sortBriefs(enriched.filter(item => item.brief.signal.level === 'low'));
  const topics = buildTopics(enriched);
  const top = high.slice(0, 5);
  const counts = {
    high: high.length,
    mid: mid.length,
    low: low.length,
    total: posts.length,
    topics: topics.length
  };

  return {
    generatedAt: data.generatedAt,
    source: {
      latestGeneratedAt: data.generatedAt,
      postCount: posts.length,
      accounts: data.accounts || [],
      errors: data.errors || [],
      stats: data.stats || {},
      sources: data.sources || null
    },
    summary: top.length
      ? `本次有 ${high.length} 条高信号内容，聚合为 ${topics.length} 个主题，重点关注：${topics.slice(0, 3).map(item => item.title).join('；')}`
      : '本次没有明显高信号内容，建议只快速浏览原帖。',
    counts,
    digest: buildDigest({ generatedAt: data.generatedAt, counts, topics, high, mid, low }),
    topics,
    sections: {
      top,
      investment: byCategory('investment'),
      technology: byCategory('technology'),
      risk: byCategory('risk'),
      reading: byCategory('reading'),
      other: byCategory('other'),
      lowSignal: low
    }
  };
}

async function saveLatestBriefing(briefing) {
  await writeJson(LATEST_BRIEFING_PATH, briefing);
  return LATEST_BRIEFING_PATH;
}

async function saveRunArchive({ latestData, briefing, reportPath, generatedAt, dryRun }) {
  const stamp = safeStamp(generatedAt);
  const postsArchivePath = join(ARCHIVE_DIR, 'posts', `${stamp}.json`);
  const briefingArchivePath = join(ARCHIVE_DIR, 'briefings', `${stamp}.json`);
  await writeJson(postsArchivePath, latestData);
  await writeJson(briefingArchivePath, briefing);

  const index = await readJson(ARCHIVE_INDEX_PATH, { runs: [] });
  index.runs = [
    {
      generatedAt,
      dryRun,
      postsArchivePath,
      briefingArchivePath,
      postsArchiveUrl: `data/archive/posts/${stamp}.json`,
      briefingArchiveUrl: `data/archive/briefings/${stamp}.json`,
      reportPath,
      newPosts: latestData.posts.length,
      accountsWithNewPosts: latestData.stats.accountsWithNewPosts,
      highSignals: briefing.counts.high,
      midSignals: briefing.counts.mid,
      lowSignals: briefing.counts.low,
      sourceStats: latestData.sources || null,
      errors: latestData.errors.length
    },
    ...(index.runs || []).filter(run => run.generatedAt !== generatedAt)
  ].slice(0, 365);
  await writeJson(ARCHIVE_INDEX_PATH, index);

  return {
    postsArchivePath,
    briefingArchivePath,
    archiveIndexPath: ARCHIVE_INDEX_PATH
  };
}

function estimateReadCost(config, userCache = { usersByHandle: {} }) {
  const accounts = config.accounts.length;
  const feedHandles = new Set((config.feedSources || []).flatMap(source => source.handles || []));
  const feedCoveredAccounts = config.accounts.filter(account => feedHandles.has(account.handle)).length;
  const xApiAccountsList = config.accounts.filter(account => !feedHandles.has(account.handle));
  const xApiAccounts = xApiAccountsList.length;
  const cachedUserReads = xApiAccountsList.filter(account => isFreshCachedUser(userCache.usersByHandle?.[account.handle])).length;
  const userReads = xApiAccounts - cachedUserReads;
  const postsRequested = xApiAccounts * Math.max(5, config.maxPostsPerAccount * 2);
  const postReadCost = postsRequested * 0.005;
  const userReadCost = userReads * 0.010;
  return {
    accounts,
    feedCoveredAccounts,
    xApiAccounts,
    cachedXApiUsers: cachedUserReads,
    estimatedPostReadsPerRun: postsRequested,
    estimatedUserReadsPerRun: userReads,
    officialPostReadUnitPriceUsd: 0.005,
    officialUserReadUnitPriceUsd: 0.010,
    estimatedUsdPerRun: postReadCost + userReadCost,
    estimatedUsdPer30DailyRuns: (postReadCost + userReadCost) * 30
  };
}

async function main() {
  const config = await loadConfig();
  if (estimateCost) {
    const userCache = await loadUserCache();
    console.log(JSON.stringify(estimateReadCost(config, userCache), null, 2));
    return;
  }

  if (!discoverFollowingArg && config.accounts.length === 0) {
    throw new Error('config/sources.json has no accounts yet. Add handles under accounts before scanning.');
  }

  const env = { ...process.env, ...(await loadEnv(ENV_PATH)) };
  const needsBearerToken = Boolean(discoverFollowingArg) || !feedOnly;
  if (needsBearerToken && !env.X_BEARER_TOKEN) {
    throw new Error('Missing X_BEARER_TOKEN. Create .env from .env.example and add your token.');
  }

  if (discoverFollowingArg) {
    const snapshot = await discoverFollowing(discoverFollowingArg, env.X_BEARER_TOKEN, discoverLimitArg);
    const path = join(ROOT, 'config', `following-${cleanHandle(discoverFollowingArg)}.json`);
    await writeJson(path, snapshot);
    console.log(JSON.stringify({
      status: 'ok',
      path,
      count: snapshot.count,
      note: 'Review this file, then copy selected accounts into config/sources.json.'
    }, null, 2));
    return;
  }

  const state = await loadState();
  const userCache = await loadUserCache();
  const generatedAt = new Date().toISOString();
  const result = await fetchRecentPosts(config, env.X_BEARER_TOKEN, state, { feedOnly, userCache });
  const markdown = renderReport({
    config,
    accounts: result.accounts,
    errors: result.errors,
    generatedAt,
    sourceStats: result.sourceStats
  });
  const latestData = buildLatestData({
    config,
    accounts: result.accounts,
    errors: result.errors,
    generatedAt,
    sourceStats: result.sourceStats
  });
  const briefing = buildBriefing(latestData);
  const reportPath = await saveReport(markdown);
  const latestDataPath = await saveLatestData(latestData);
  const latestBriefingPath = await saveLatestBriefing(briefing);
  const archive = await saveRunArchive({ latestData, briefing, reportPath, generatedAt, dryRun });
  const userCachePath = await saveUserCache(userCache);

  const surfaced = latestData.posts;
  if (!dryRun) {
    for (const post of surfaced) {
      state.seenPosts[post.id] = {
        firstSeenAt: generatedAt,
        handle: post.handle,
        url: post.url
      };
    }
    state.runs.unshift({
      generatedAt,
      reportPath,
      latestDataPath,
      latestBriefingPath,
      postsArchivePath: archive.postsArchivePath,
      briefingArchivePath: archive.briefingArchivePath,
      newPosts: surfaced.length,
      accountsWithNewPosts: result.accounts.length,
      sourceStats: result.sourceStats,
      errors: result.errors.length
    });
    state.runs = state.runs.slice(0, 50);
    await writeJson(STATE_PATH, state);
  }

  console.log(JSON.stringify({
    status: 'ok',
    dryRun,
    feedOnly,
    reportPath,
    latestDataPath,
    latestBriefingPath,
    postsArchivePath: archive.postsArchivePath,
    briefingArchivePath: archive.briefingArchivePath,
    userCachePath,
    newPosts: surfaced.length,
    accountsWithNewPosts: result.accounts.length,
    sourceStats: result.sourceStats,
    errors: result.errors
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }, null, 2));
  process.exit(1);
});
