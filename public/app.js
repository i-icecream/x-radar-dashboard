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
  sideSearchInput: document.querySelector('#sideSearchInput'),
  highCount: document.querySelector('#highCount'),
  midCount: document.querySelector('#midCount'),
  lowCount: document.querySelector('#lowCount'),
  profilePostCount: document.querySelector('#profilePostCount'),
  profileHighCount: document.querySelector('#profileHighCount'),
  profileAccountCount: document.querySelector('#profileAccountCount'),
  sideLead: document.querySelector('#sideLead'),
  sideTotalPosts: document.querySelector('#sideTotalPosts'),
  sideHighSignals: document.querySelector('#sideHighSignals'),
  sideMidSignals: document.querySelector('#sideMidSignals'),
  sideFeedAccounts: document.querySelector('#sideFeedAccounts'),
  sideApiAccounts: document.querySelector('#sideApiAccounts'),
  sideFeedPosts: document.querySelector('#sideFeedPosts'),
  sideApiPosts: document.querySelector('#sideApiPosts'),
  sideAccounts: document.querySelector('#sideAccounts'),
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
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
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

function avatarText(name = '', handle = '') {
  const source = String(name || handle || 'FB').trim();
  const ascii = source.match(/[A-Za-z0-9]/g);
  if (ascii?.length) return ascii.slice(0, 2).join('').toUpperCase();
  return source.slice(0, 1) || 'F';
}

function signalLevel(post) {
  const importance = Number(post.codexAnalysis?.importance || 0);
  if (importance >= 4) return 'high';
  if (importance === 3) return 'mid';
  if (importance >= 1) return 'low';
  if ((post.score || 0) >= 75) return 'high';
  if ((post.score || 0) >= 55) return 'mid';
  return 'low';
}

function levelLabel(level) {
  return { high: 'High signal', mid: 'Mid signal', low: 'Low signal' }[level] || 'Unrated';
}

function sourceLabel(post) {
  const source = post.source || {};
  if (source.type === 'feed') return source.label || 'Feed';
  if (source.type === 'x-api') return 'X API';
  return 'Offline';
}

function sourceType(post) {
  if (post.source?.type === 'feed') return 'feed';
  if (post.source?.type === 'x-api') return 'x-api';
  return 'unknown';
}

function bestAnalysis(post) {
  if (post.codexAnalysis) {
    return {
      summary: post.codexAnalysis.llmSummary || post.summary || '',
      insight: post.codexAnalysis.insight || '',
      tags: post.codexAnalysis.tags || [],
      importance: Number(post.codexAnalysis.importance || 0),
      investmentSignal: post.codexAnalysis.investmentSignal || null
    };
  }
  return {
    summary: post.summary || '',
    insight: '',
    tags: post.analysis?.topics || [],
    importance: 0,
    investmentSignal: null
  };
}

function renderSignalBadge(level, post) {
  const importance = Number(post.codexAnalysis?.importance || 0);
  const value = importance ? `${importance}/5` : Number(post.score || 0);
  return `<span class="signal-badge ${level}">${levelLabel(level)} · ${value}</span>`;
}

function renderTags(items = []) {
  return items.slice(0, 6).map(item => `<span>${escapeHtml(item)}</span>`).join('');
}

function tiltLabel(value = '') {
  return {
    bullish: 'Bullish',
    bearish: 'Bearish',
    holding: 'Holding',
    neutral: 'Neutral',
    watching: 'Watching',
    reducing: 'Reducing',
    researching: 'Researching',
    unclear: 'Unclear'
  }[String(value).toLowerCase()] || 'Unclear';
}

function investmentSignalLine(signal) {
  if (!signal || (!signal.target && !signal.thesis && !signal.evidence)) return '';
  const target = signal.target ? `<span>Target: ${escapeHtml(signal.target)}</span>` : '';
  const tilt = `<span>Tilt: ${escapeHtml(tiltLabel(signal.tilt))}</span>`;
  const thesis = signal.thesis ? `<p>${escapeHtml(signal.thesis)}</p>` : signal.evidence ? `<p>${escapeHtml(signal.evidence)}</p>` : '';
  return `<div class="investment-signal">${target}${tilt}${thesis}</div>`;
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
        <p lang="${escapeHtml(post.lang || '')}">${escapeHtml(post.text || 'No readable text captured.')}</p>
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
        embed.insertAdjacentHTML('beforeend', '<p class="embed-error">Original embed failed to load. Offline text is shown instead.</p>');
      }
    });
}

function countLevels(posts) {
  const counts = { high: 0, mid: 0, low: 0 };
  for (const post of posts) counts[signalLevel(post)] += 1;
  return counts;
}

function matchesReaderFilters(post) {
  const query = state.query.trim().toLowerCase();
  if (state.account !== 'all' && post.handle !== state.account) return false;
  if (!query) return true;
  const analysis = bestAnalysis(post);
  const haystack = `${post.name || ''} ${post.handle || ''} ${post.text || ''} ${post.summary || ''} ${analysis.summary || ''} ${(analysis.tags || []).join(' ')}`.toLowerCase();
  return haystack.includes(query);
}

function getFilterablePosts() {
  return [...(state.data.posts || [])].filter(matchesReaderFilters);
}

function getVisiblePosts() {
  return getFilterablePosts()
    .filter(post => state.signal === 'all' || signalLevel(post) === state.signal)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function renderSummary() {
  const data = state.data;
  const timezone = data.window?.timezone || 'Asia/Shanghai';
  const stats = data.stats || {};
  const posts = data.posts || [];
  const counts = countLevels(posts);

  elements.generatedAt.textContent = formatDate(data.generatedAt, timezone);
  elements.lookback.textContent = `${data.window?.lookbackHours || 24}h`;
  elements.accountCount.textContent = stats.accountsWithNewPosts ?? data.accounts.length;
  elements.errorCount.textContent = stats.errors ?? data.errors.length;
  elements.profilePostCount.textContent = stats.totalPosts ?? posts.length;
  elements.profileHighCount.textContent = counts.high;
  elements.profileAccountCount.textContent = stats.accountsWithNewPosts ?? data.accounts.length;

  const skipped = Number(stats.skippedXApiAccounts || 0);
  const hasSources = Number(stats.feedAccounts || 0) || Number(stats.xApiAccounts || 0) || skipped;
  elements.sourceSummary.textContent = hasSources
    ? ` · New: Feed ${Number(stats.feedPosts || 0)} / X API ${Number(stats.xApiPosts || 0)} · Sources: Feed ${Number(stats.feedAccounts || 0)} / X API ${Number(stats.xApiAccounts || 0)}`
    : '';
}

function renderAccountOptions() {
  const selected = state.account;
  const options = ['<option value="all">All accounts</option>'];
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
    <strong>Scan alerts</strong>
    <ul>${errors.map(error => `<li>${escapeHtml(error)}</li>`).join('')}</ul>
  `;
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

function renderSidePanel() {
  const data = state.data;
  const posts = data.posts || [];
  const stats = data.stats || {};
  const counts = countLevels(posts);
  const highPosts = posts.filter(post => signalLevel(post) === 'high');
  const leadTags = highPosts.flatMap(post => bestAnalysis(post).tags || []).slice(0, 3);

  elements.sideLead.textContent = highPosts.length
    ? `Latest scan found ${highPosts.length} high-signal posts${leadTags.length ? ` around ${leadTags.join(' / ')}` : ''}.`
    : `Latest scan found ${posts.length} posts. Nothing is marked high-signal yet.`;
  elements.sideTotalPosts.textContent = stats.totalPosts ?? posts.length;
  elements.sideHighSignals.textContent = counts.high;
  elements.sideMidSignals.textContent = counts.mid;
  elements.sideFeedAccounts.textContent = Number(stats.feedAccounts || 0);
  elements.sideApiAccounts.textContent = Number(stats.xApiAccounts || 0);
  elements.sideFeedPosts.textContent = Number(stats.feedPosts || 0);
  elements.sideApiPosts.textContent = Number(stats.xApiPosts || 0);

  const active = [...(data.accounts || [])]
    .sort((a, b) => Number(b.postCount || 0) - Number(a.postCount || 0))
    .slice(0, 8);
  elements.sideAccounts.innerHTML = active.map(account => `
    <div class="account-row">
      <span class="mini-avatar">${escapeHtml(avatarText(account.name, account.handle))}</span>
      <span>
        <strong>${escapeHtml(account.name || account.handle)}</strong>
        <small>@${escapeHtml(account.handle)} · ${Number(account.postCount || 0)} posts</small>
      </span>
    </div>
  `).join('');
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
          <section class="tweet-summary ${level}" aria-label="Post summary">
            <strong>Summary</strong>
            <p>${escapeHtml(summary)}</p>
            ${investmentSignalLine(analysis.investmentSignal)}
          </section>
        ` : ''}
        ${renderOriginalEmbed(post, titleTime)}
        <div class="tweet-tags">${renderTags(analysis.tags || [])}</div>
        <footer class="tweet-footer">
          <a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">Open original</a>
        </footer>
      </div>
    </article>
  `;
  }).join('');
  hydrateOriginalEmbeds();
}

function render() {
  renderSummary();
  renderAccountOptions();
  renderAlerts();
  renderSidePanel();
  renderFeed();
}

function setQuery(value) {
  state.query = value;
  if (elements.searchInput && elements.searchInput.value !== value) elements.searchInput.value = value;
  if (elements.sideSearchInput && elements.sideSearchInput.value !== value) elements.sideSearchInput.value = value;
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
      <h2>Unable to load radar data</h2>
      <p>${escapeHtml(err.message)}</p>
    `;
  }
}

elements.accountFilter.addEventListener('change', event => {
  state.account = event.target.value;
  renderFeed();
});

elements.searchInput.addEventListener('input', event => setQuery(event.target.value));
if (elements.sideSearchInput) {
  elements.sideSearchInput.addEventListener('input', event => setQuery(event.target.value));
}

for (const button of elements.signalFilters) {
  button.addEventListener('click', () => {
    const next = button.dataset.signalFilter;
    state.signal = state.signal === next ? 'all' : next;
    renderFeed();
  });
}

loadData();