const meta = document.querySelector('#briefingMeta');
const summary = document.querySelector('#briefingSummary');
const sections = document.querySelector('#briefingSections');
const empty = document.querySelector('#briefingEmpty');

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false
  }).format(new Date(value));
}

function sourceMeta(data) {
  const stats = data.source?.stats || {};
  const skipped = Number(stats.skippedXApiAccounts || 0);
  const hasSources = Number(stats.feedAccounts || 0) || Number(stats.xApiAccounts || 0) || skipped;
  if (!hasSources) return '';
  const newBySource = `本次新帖：Feed ${Number(stats.feedPosts || 0)} / X API ${Number(stats.xApiPosts || 0)}`;
  const coverage = `来源覆盖：Feed ${Number(stats.feedAccounts || 0)} 账号 / X API ${Number(stats.xApiAccounts || 0)} 账号${skipped ? ` / 跳过 ${skipped} API账号` : ''}`;
  return ` · ${newBySource} · ${coverage}`;
}
function renderTags(tags = []) {
  return tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('');
}

function signalBadge(signal = {}) {
  const level = signal.level || 'low';
  const label = signal.label || '低信号';
  const value = signal.importance ? ` · ${signal.importance}/5` : '';
  return `<span class="signal-badge ${escapeHtml(level)}">${escapeHtml(label)}${escapeHtml(value)}</span>`;
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

function renderBriefLine(item) {
  return `
    <li>
      <span>${escapeHtml(item.title || '未命名要点')}</span>
      <small>
        @${escapeHtml(item.handle || '')} · ${escapeHtml(formatDate(item.createdAt))}
        ${item.url ? ` · <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">原帖</a>` : ''}
      </small>
    </li>
  `;
}

function renderStoryCard(item) {
  const tags = (item.tags || []).slice(0, 3);
  return `
    <article class="story-card ${escapeHtml(item.signal?.level || 'low')}">
      <header>
        <div>
          <strong>${escapeHtml(item.title || '未命名重点')}</strong>
          <p>@${escapeHtml(item.handle || '')} · ${escapeHtml(formatDate(item.createdAt))}</p>
        </div>
        ${signalBadge(item.signal)}
      </header>
      ${tags.length ? `<div class="tweet-tags">${renderTags(tags)}</div>` : ''}
      ${item.url ? `<a class="post-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">打开原帖</a>` : ''}
    </article>
  `;
}

function renderLead(digest, counts) {
  const topCount = Number(digest.topStories?.length || 0);
  summary.innerHTML = `
    <div class="briefing-lead">
      <div>
        <span class="briefing-kicker">今日摘要</span>
        <p>${escapeHtml(digest.lead?.text || '')}</p>
      </div>
      <div class="briefing-reading-plan" aria-label="阅读顺序">
        <span class="briefing-plan-label">阅读顺序</span>
        <span>先读 ${topCount} 条</span>
        <span>高信号共 ${Number(counts.high || 0)} 条</span>
        <span>${Number(counts.topics || 0)} 个主题归档</span>
      </div>
    </div>
  `;
}

function renderTopStories(items = [], counts = {}) {
  if (!items.length) return '';
  return `
    <section class="briefing-section top-stories" id="priority-stories">
      <header class="section-heading">
        <div>
          <h2>先读这 ${items.length} 条</h2>
          <p>从 ${Number(counts.high || items.length)} 条高信号里精选，适合先看；其余高信号按主题收在下方。</p>
        </div>
      </header>
      <div class="story-grid">
        ${items.map(renderStoryCard).join('')}
      </div>
    </section>
  `;
}

function renderTopicArchive(topics = []) {
  if (!topics.length) return '';
  return `
    <details class="briefing-section archive-section" id="topic-archive">
      <summary>
        <span>按主题看完整高信号</span>
        <small>${topics.length} 个主题，包含未放入“先读”的高信号</small>
      </summary>
      <div class="topic-archive">
        ${topics.map(topic => `
          <article class="topic-row ${escapeHtml(topic.signal?.level || 'mid')}">
            <header>
              <div>
                <strong>${escapeHtml(topic.title || '未命名主题')}</strong>
                <p>${Number(topic.sourceCount || 0)} 条相关帖 · ${escapeHtml((topic.handles || []).map(handle => `@${handle}`).join('、'))}</p>
              </div>
              ${signalBadge(topic.signal)}
            </header>
            <ul class="briefing-points">
              ${(topic.items || []).map(renderBriefLine).join('')}
            </ul>
            <div class="tweet-tags">${renderTags(topic.tags || [])}</div>
          </article>
        `).join('')}
      </div>
    </details>
  `;
}

function renderCompactSection(title, items = [], initiallyOpen = false) {
  if (!items.length) return '';
  return `
    <details class="briefing-section compact-section" ${initiallyOpen ? 'open' : ''}>
      <summary>${escapeHtml(title)} · ${items.length} 条</summary>
      <div class="compact-list">
        ${items.map(renderStoryCard).join('')}
      </div>
    </details>
  `;
}

function normalizeDigest(data) {
  if (data.digest?.version === 'daily-briefing-v1') return data.digest;
  const counts = data.counts || {};
  return {
    version: 'daily-briefing-v1',
    generatedAt: data.generatedAt,
    lead: {
      text: data.summary || ''
    },
    counts,
    topStories: data.sections?.top || [],
    topicArchive: data.topics || [],
    midStories: data.sections?.other || [],
    lowSignal: {
      count: data.sections?.lowSignal?.length || 0,
      items: data.sections?.lowSignal || []
    }
  };
}

function renderDigest(data) {
  const digest = normalizeDigest(data);
  const counts = digest.counts || data.counts || {};
  renderLead(digest, counts);
  sections.innerHTML = [
    renderTopStories(digest.topStories || [], counts),
    renderTopicArchive(digest.topicArchive || []),
    renderCompactSection('中信号补充', digest.midStories || []),
    renderCompactSection('低信号归档', digest.lowSignal?.items || [])
  ].join('');
}

async function loadBriefing() {
  try {
    const response = await fetch('data/briefing.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const counts = data.counts || {};
    meta.textContent = `最新扫描 · ${formatDate(data.generatedAt)} · ${counts.total || 0} 帖 · ${counts.high || 0} 高信号${sourceMeta(data)}`;
    renderDigest(data);
    empty.hidden = (counts.total || 0) > 0;
  } catch (err) {
    meta.textContent = '无法加载简报';
    summary.innerHTML = '';
    sections.innerHTML = '';
    empty.hidden = false;
    empty.querySelector('p').textContent = err.message;
  }
}

loadBriefing();
