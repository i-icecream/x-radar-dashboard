const state = {
  data: null,
  account: 'all',
  query: '',
  signal: 'all'
};

const elements = {
  generatedAt: document.querySelector('#generatedAt'),
  lookback: document.querySelector('#lookback'),
  postCount: document.querySelector('#postCount'),
  accountCount: document.querySelector('#accountCount'),
  errorCount: document.querySelector('#errorCount'),
  sourceSummary: document.querySelector('#sourceSummary'),
  accountFilter: document.querySelector('#accountFilter'),
  searchInput: document.querySelector('#searchInput'),
  highCount: document.querySelector('#highCount'),
  midCount: document.querySelector('#midCount'),
  lowCount: document.querySelector('#lowCount'),
  signalFilters: document.querySelectorAll('[data-signal-filter]'),
  alerts: document.querySelector('#alerts'),
  digest: document.querySelector('#digest'),
  feed: document.querySelector('#feed'),
  emptyState: document.querySelector('#emptyState')
};

let xWidgetsPromise = null;

function formatDate(value, timezone = 'Asia/Shanghai') {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false
  }).format(new Date(value));
}

function formatRelativeTime(value) {
  if (!value) return '';
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(diffMs / 60000));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function includesAny(text, words) {
  return words.some(word => text.includes(word.toLowerCase()));
}

function fallbackTopics(text = '') {
  const lower = text.toLowerCase();
  const rules = [
    ['AI / 模型', ['ai', 'agent', 'llm', 'openai', 'anthropic', 'model', '智能体', '模型']],
    ['Crypto / Web3', ['crypto', 'bitcoin', 'ethereum', 'web3', 'defi', 'binance', 'okx', '加密', '币安']],
    ['市场 / 投资', ['stock', 'market', 'gpu', 'cpu', 'revenue', '美股', '股价', '投资']],
    ['安全 / 风险', ['hack', 'attack', 'breach', 'risk', 'stolen', '被盗', '攻击', '风险']],
    ['监管 / 合规', ['regulation', 'compliance', 'license', '监管', '合规', '牌照']],
    ['创作者 / 内容', ['youtube', 'substack', 'creator', 'newsletter', '内容', '油管']]
  ];
  const matched = rules.filter(([, words]) => includesAny(lower, words)).map(([label]) => label);
  return matched.length ? matched.slice(0, 3) : ['综合'];
}

function fallbackAnalysis(post) {
  const text = String(post.text || '').trim();
  const topics = fallbackTopics(text);
  const linkOnly = /^(https?:\/\/\S+\s*)+$/.test(text);
  const lowSocial = /^(gm|good morning|thanks|thank you|congrats)[\s!！。,.，🫶]*$/i.test(text.toLowerCase()) || /(恭喜|节日快乐|假期快乐|端午安康|家人们)/.test(text);
  const type = linkOnly ? '链接' : text.length > 800 ? '长文' : post.quotedPostId ? '引用评论' : '动态';
  const signal = linkOnly || lowSocial ? '低信号' : (post.score || 0) >= 75 ? '高信号' : (post.score || 0) >= 55 ? '中信号' : '低信号';
  return {
    method: 'local-rules-v1',
    topics,
    type,
    signal,
    whyItMatters: linkOnly ? '只有链接，需要打开原文才能判断价值。' : lowSocial ? '偏社交互动，信息密度较低。' : '这条内容有一定参考价值，但需要结合原文上下文判断。',
    action: linkOnly || lowSocial ? '建议低优先级处理，除非该账号本身很重要。' : '建议快速浏览，保留原文链接即可。',
    caveat: '本分析由本地规则生成，不是 LLM 深度总结。'
  };
}

function tiltLabel(value = '') {
  return {
    bullish: '??',
    bearish: '??',
    holding: '??',
    neutral: '??',
    watching: '??',
    reducing: '??',
    researching: '研究中',
    unclear: '未明确'
  }[String(value).toLowerCase()] || '未明确';
}

function investmentSignalLine(signal) {
  if (!signal || (!signal.target && !signal.thesis && !signal.evidence)) return '';
  const target = signal.target ? `<span>标的：${escapeHtml(signal.target)}</span>` : '';
  const tilt = `<span>倾向：${escapeHtml(tiltLabel(signal.tilt))}</span>`;
  const thesis = signal.thesis ? `<p>${escapeHtml(signal.thesis)}</p>` : signal.evidence ? `<p>${escapeHtml(signal.evidence)}</p>` : '';
  return `<div class="investment-signal">${target}${tilt}${thesis}</div>`;
}

function renderTags(items = []) {
  return items.map(item => `<span>${escapeHtml(item)}</span>`).join('');
}

function renderSignalBadge(level, post) {
  const importance = post.codexAnalysis?.importance;
  const value = importance ? `${importance}/5` : Number(post.score || 0);
  return `<span class="signal-badge ${level}">${levelLabel(level)} · ${value}</span>`;
}

function sourceLabel(post) {
  const source = post.source || {};
  if (source.type === 'feed') return source.label || 'Feed';
  if (source.type === 'x-api') return 'X API';
  return '离线数据';
}

function sourceType(post) {
  if (post.source?.type === 'feed') return 'feed';
  if (post.source?.type === 'x-api') return 'x-api';
  return 'unknown';
}

function loadXWidgets() {
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  if (xWidgetsPromise) return xWidgetsPromise;

  xWidgetsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-x-widgets]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.twttr), { once: true });
      existing.addEventListener('error', () => reject(new Error('X embed script failed to load.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://platform.x.com/widgets.js';
    script.async = true;
    script.charset = 'utf-8';
    script.dataset.xWidgets = 'true';
    script.onload = () => resolve(window.twttr);
    script.onerror = () => reject(new Error('X embed script failed to load.'));
    document.head.appendChild(script);
  });

  return xWidgetsPromise;
}

function renderOriginalEmbed(post, titleTime) {
  return `
    <div class="tweet-embed" data-embed-url="${escapeHtml(post.url)}">
      <blockquote class="twitter-tweet" data-dnt="true" data-conversation="none" data-align="center">
        <p lang="${escapeHtml(post.lang || '')}">${escapeHtml(post.text || '无可读取正文')}</p>
        <a href="${escapeHtml(post.url)}">${escapeHtml(titleTime)}</a>
      </blockquote>
    </div>
  `;
}

function hydrateOriginalEmbeds() {
  const embeds = [...elements.feed.querySelectorAll('.tweet-embed:not([data-hydrated])')];
  if (!embeds.length) return;
  for (const embed of embeds) embed.dataset.hydrated = 'pending';

  loadXWidgets()
    .then(twttr => twttr.widgets.load(elements.feed))
    .then(() => {
      for (const embed of embeds) embed.dataset.hydrated = 'true';
    })
    .catch(() => {
      for (const embed of embeds) {
        embed.dataset.hydrated = 'failed';
        embed.insertAdjacentHTML('beforeend', '<p class="embed-error">原帖嵌入加载失败，已显示离线正文。</p>');
      }
    });
}

function bestAnalysis(post) {
  if (post.codexAnalysis) {
    return {
      method: post.codexAnalysis.method || 'codex-analysis-v1',
      topics: post.codexAnalysis.tags || [],
      type: `重要度 ${post.codexAnalysis.importance || 3}/5`,
      signal: 'Codex 分析',
      summary: post.codexAnalysis.llmSummary || post.summary || '',
      insight: post.codexAnalysis.insight || '',
      whyItMatters: post.codexAnalysis.whyItMatters || post.codexAnalysis.insight || '',
      action: post.codexAnalysis.action || '',
      risk: post.codexAnalysis.risk || '',
      investmentSignal: post.codexAnalysis.investmentSignal || null
    };
  }
  const analysis = post.analysis || fallbackAnalysis(post);
  return {
    method: analysis.method || 'local-rules-v1',
    topics: analysis.topics || [],
    type: analysis.type || '动态',
    signal: analysis.signal || '未评级',
    summary: post.summary || '',
    insight: '',
    whyItMatters: analysis.whyItMatters || '',
    action: analysis.action || '',
    risk: '',
    investmentSignal: null
  };
}

function signalLevel(post) {
  const importance = post.codexAnalysis?.importance;
  if (importance >= 4) return 'high';
  if (importance === 3) return 'mid';
  if (importance >= 1) return 'low';

  const analysis = post.analysis || fallbackAnalysis(post);
  if (analysis.signal === '高信号' || (post.score || 0) >= 75) return 'high';
  if (analysis.signal === '中信号' || (post.score || 0) >= 55) return 'mid';
  return 'low';
}

function levelLabel(level) {
  return { high: '高信号', mid: '中信号', low: '低信号' }[level] || '未评级';
}

function levelRank(level) {
  return { high: 0, mid: 1, low: 2 }[level] ?? 3;
}

function postDigestLine(post) {
  const analysis = bestAnalysis(post);
  return analysis.summary || post.summary || String(post.text || '').replace(/\s+/g, ' ').slice(0, 120);
}

function groupByAccount(posts) {
  const map = new Map();
  for (const post of posts) {
    const key = post.handle || 'unknown';
    if (!map.has(key)) {
      map.set(key, {
        handle: key,
        name: post.name || key,
        posts: [],
        high: 0,
        mid: 0,
        low: 0
      });
    }
    const group = map.get(key);
    const level = signalLevel(post);
    group.posts.push({ ...post, level });
    group[level] += 1;
  }
  return [...map.values()]
    .map(group => ({
      ...group,
      posts: group.posts.sort((a, b) => levelRank(a.level) - levelRank(b.level) || (b.score || 0) - (a.score || 0))
    }))
    .sort((a, b) => b.high - a.high || b.mid - a.mid || b.posts.length - a.posts.length);
}

function renderSummary() {
  const data = state.data;
  const timezone = data.window?.timezone || 'Asia/Shanghai';
  const stats = data.stats || {};
  elements.generatedAt.textContent = formatDate(data.generatedAt, timezone);
  elements.lookback.textContent = `${data.window?.lookbackHours || 24} 小时`;
  if (elements.postCount) elements.postCount.textContent = stats.totalPosts ?? data.posts.length;
  elements.accountCount.textContent = stats.accountsWithNewPosts ?? data.accounts.length;
  elements.errorCount.textContent = stats.errors ?? data.errors.length;
  if (elements.sourceSummary) {
    const skipped = Number(stats.skippedXApiAccounts || 0);
    const hasSources = Number(stats.feedAccounts || 0) || Number(stats.xApiAccounts || 0) || skipped;
    const newBySource = `本次新帖：Feed ${Number(stats.feedPosts || 0)} / X API ${Number(stats.xApiPosts || 0)}`;
    const coverage = `来源覆盖：Feed ${Number(stats.feedAccounts || 0)} 账号 / X API ${Number(stats.xApiAccounts || 0)} 账号${skipped ? ` / 跳过 ${skipped} API账号` : ''}`;
    elements.sourceSummary.textContent = hasSources
      ? `· ${newBySource} · ${coverage}`
      : '';
  }
}

function countLevels(posts) {
  const counts = { high: 0, mid: 0, low: 0 };
  for (const post of posts) counts[signalLevel(post)] += 1;
  return counts;
}

function renderAccountOptions() {
  const selected = state.account;
  const options = ['<option value="all">全部账号</option>'];
  for (const account of state.data.accounts || []) {
    const label = `${account.name || account.handle} (@${account.handle})`;
    options.push(`<option value="${escapeHtml(account.handle)}">${escapeHtml(label)}</option>`);
  }
  elements.accountFilter.innerHTML = options.join('');
  elements.accountFilter.value = selected;
}

function renderAlerts() {
  const errors = state.data.errors || [];
  if (!errors.length) {
    elements.alerts.hidden = true;
    elements.alerts.innerHTML = '';
    return;
  }
  elements.alerts.hidden = false;
  elements.alerts.innerHTML = `
    <strong>抓取提示</strong>
    <ul>${errors.map(error => `<li>${escapeHtml(error)}</li>`).join('')}</ul>
  `;
}

function matchesReaderFilters(post) {
  const query = state.query.trim().toLowerCase();
  if (state.account !== 'all' && post.handle !== state.account) return false;
  if (!query) return true;
  const analysis = bestAnalysis(post);
  const haystack = `${post.name || ''} ${post.handle || ''} ${post.text || ''} ${post.summary || ''} ${analysis.summary || ''} ${analysis.whyItMatters || ''} ${(analysis.topics || []).join(' ')} ${analysis.type || ''} ${analysis.signal || ''}`.toLowerCase();
  return haystack.includes(query);
}

function getFilterablePosts() {
  return [...(state.data.posts || [])].filter(matchesReaderFilters);
}

function updateSignalFilters(counts) {
  elements.highCount.textContent = counts.high;
  elements.midCount.textContent = counts.mid;
  elements.lowCount.textContent = counts.low;
  for (const button of elements.signalFilters) {
    const selected = button.dataset.signalFilter === state.signal;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function getVisiblePosts() {
  return getFilterablePosts()
    .filter(post => state.signal === 'all' || signalLevel(post) === state.signal)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function renderFeed() {
  const counts = countLevels(getFilterablePosts());
  updateSignalFilters(counts);
  const posts = getVisiblePosts();
  const timezone = state.data.window?.timezone || 'Asia/Shanghai';
  if (elements.postCount) elements.postCount.textContent = posts.length;
  elements.emptyState.hidden = posts.length > 0;
  elements.digest.hidden = true;
  elements.feed.hidden = false;
  elements.feed.innerHTML = posts.map(post => {
    const analysis = bestAnalysis(post);
    const level = signalLevel(post);
    const summary = analysis.summary || post.summary || '';
    const titleTime = formatDate(post.createdAt, timezone);
    return `
    <article class="tweet tweet-embedded ${level}" data-post-id="${escapeHtml(post.id)}">
      <div class="tweet-main">
        <header class="tweet-head">
          <div class="tweet-context">
            <time title="${escapeHtml(titleTime)}">${escapeHtml(formatRelativeTime(post.createdAt))}</time>
            <span class="source-badge ${escapeHtml(sourceType(post))}">${escapeHtml(sourceLabel(post))}</span>
          </div>
          ${renderSignalBadge(level, post)}
        </header>
        ${summary && level !== 'low' ? `
          <section class="tweet-summary ${level}" aria-label="帖子摘要">
            <div>
              <strong>Summary</strong>
            </div>
            <p>${escapeHtml(summary)}</p>
            ${investmentSignalLine(analysis.investmentSignal)}
          </section>
        ` : ''}
        ${renderOriginalEmbed(post, titleTime)}
        <div class="tweet-tags">${renderTags(analysis.topics || [])}</div>
        <footer class="tweet-footer">
          <a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">打开原文</a>
        </footer>
      </div>
    </article>
  `;
  }).join('');
  hydrateOriginalEmbeds();
}

function renderDigest(posts, timezone) {
  const groups = groupByAccount(posts);
  elements.digest.innerHTML = groups.map(group => {
    const worthwhile = group.posts.filter(post => post.level !== 'low');
    const low = group.posts.filter(post => post.level === 'low');

    return `
      <article class="digest-card">
        <header class="digest-head">
          <div>
            <strong>${escapeHtml(group.name)}</strong>
            <span>@${escapeHtml(group.handle)}</span>
          </div>
          <div class="digest-counts">
            <span class="pill high">${group.high} 高</span>
            <span class="pill mid">${group.mid} 中</span>
            <span class="pill low">${group.low} 低</span>
          </div>
        </header>
        <div class="digest-list">
          ${worthwhile.map(post => renderDigestItem(post, timezone)).join('')}
        </div>
        ${low.length ? `
          <details class="low-detail">
            <summary>${low.length} 条低信息量内容</summary>
            <div class="digest-list muted-list">
              ${low.map(post => renderDigestItem(post, timezone)).join('')}
            </div>
          </details>
        ` : ''}
      </article>
    `;
  }).join('');
}

function renderDigestItem(post, timezone) {
  const analysis = bestAnalysis(post);
  const level = signalLevel(post);
  const summary = analysis.summary || post.summary || '';
  const original = String(post.text || '').trim();
  const originalText = escapeHtml(original || '无可读取正文');
  const originalBlock = level === 'low'
    ? `
        <details class="original-detail">
          <summary>原文内容</summary>
          <p>${originalText}</p>
        </details>
      `
    : `
        <div class="original-detail original-detail-open">
          <span class="original-label">原文内容</span>
          <p>${originalText}</p>
        </div>
      `;
  return `
    <div class="digest-item">
      <div class="digest-item-main">
        <span class="pill ${level}">${levelLabel(level)}</span>
        <span class="digest-time">${escapeHtml(formatDate(post.createdAt, timezone))}</span>
        <p class="digest-summary">${escapeHtml(summary)}</p>
        ${investmentSignalLine(analysis.investmentSignal)}
        ${originalBlock}
      </div>
      <a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">原文</a>
    </div>
  `;
}

function render() {
  renderSummary();
  renderAccountOptions();
  renderAlerts();
  renderFeed();
}

async function loadData() {
  try {
    const response = await fetch('data/latest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    render();
  } catch (err) {
    elements.emptyState.hidden = false;
    elements.emptyState.innerHTML = `
      <h2>无法加载离线数据</h2>
      <p>${escapeHtml(err.message)}</p>
    `;
  }
}

elements.accountFilter.addEventListener('change', event => {
  state.account = event.target.value;
  renderFeed();
});

elements.searchInput.addEventListener('input', event => {
  state.query = event.target.value;
  renderFeed();
});

for (const button of elements.signalFilters) {
  button.addEventListener('click', () => {
    const next = button.dataset.signalFilter;
    state.signal = state.signal === next ? 'all' : next;
    renderFeed();
  });
}

loadData();
