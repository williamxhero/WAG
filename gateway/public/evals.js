const $ = (selector, root=document) => root.querySelector(selector);
let index = null, selectedId = null;
let token = '', generation = 0, pending = null;
const artifactURLs = new Set();
const pct = value => !Number.isFinite(value) ? '—' : `${value.toFixed(value % 1 ? 1 : 0)}%`;
const ms = value => value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
const date = value => value ? new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '未知时间';
const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function kpi(label, value, tone=''){ return `<div class="kpi ${tone}"><label>${label}</label><b>${value}</b></div>`; }
function gateKpi(run, name, label, value, minimum = true) {
  const threshold = run.thresholds?.[name];
  if (!Object.hasOwn(run.thresholds ?? {}, name)) return kpi(`${label} · 未配置门禁`, pct(value));
  const concurrency = name === 'concurrency_degradation_pct';
  const validThreshold = Number.isFinite(threshold) && threshold >= 0 && (concurrency || threshold <= 100);
  const validValue = Number.isFinite(value) && (concurrency ? value >= -100 : value >= 0 && value <= 100);
  const passed = validThreshold && validValue && (run.gates?.[name]?.passed ?? (minimum ? value >= threshold : value <= threshold));
  const policy = validThreshold ? `${minimum ? '≥' : '≤'}${pct(threshold)}` : '无效门限';
  return kpi(`${label} · ${policy}`, pct(value), passed ? 'passed' : 'failed');
}
function renderLatest(run) {
  const s = run.summary;
  const degradation = (run.cases ?? []).find(item => item.id === 'concurrency-two')?.metrics?.degradation_pct;
  const conclusion = run.status === 'passed' ? '通过' : run.status === 'degraded' ? '公网降级' : '未通过';
  const reasons = (run.reasons ?? []).map(item => `${item.gate}: ${item.reason}`).join('; ');
  $('#latest-meta').textContent = `${run.suite.toUpperCase()} · ${date(run.completed_at)} · ${run.legacy ? '兼容旧格式' : '结构化报告'}${run.thresholds_source === 'legacy_defaults' ? ' · 历史默认门限（非重新认证）' : ''}${reasons ? ` · ${reasons}` : ''}`;
  $('#kpis').innerHTML = [
    kpi('结论', conclusion, run.status),
    gateKpi(run, 'success_rate_pct', '成功率', s.success_rate_pct),
    gateKpi(run, 'quality_rate_pct', '质量通过率', s.quality_rate_pct),
    kpi('首个有效结果 p95', ms(s.first_valid_result?.p95_ms)),
    kpi('总延迟 p95', ms(s.total_latency?.p95_ms)),
    gateKpi(run, 'timeout_rate_pct', '超时率', s.timeout_rate_pct, false),
    gateKpi(run, 'concurrency_degradation_pct', '并发 2 退化', degradation, false),
  ].join('');
}
function renderTrend(runs){const values=[...runs].reverse().slice(-30); if(!values.length){$('#trend').textContent='没有可绘制的历史数据';return;} const width=720,height=160,pad=12; const point=(run,i)=>`${pad+i*(width-pad*2)/Math.max(values.length-1,1)},${height-pad-(Number(run.summary.success_rate_pct??0)/100)*(height-pad*2)}`; const points=values.map(point).join(' '); $('#trend').innerHTML=`<span class="axis">成功率</span><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="M${pad},${pad}V${height-pad}H${width-pad}" stroke="#2a353a" fill="none"/><polyline points="${points}" stroke="#82e8ea" stroke-width="2" fill="none"/>${values.map((r,i)=>{const [x,y]=point(r,i).split(',');const color=r.status==='passed'?'#b6e06e':r.status==='degraded'?'#f4cc72':'#ff827b';return `<circle cx="${x}" cy="${y}" r="3" fill="${color}"><title>${escape(r.id)}: ${pct(r.summary.success_rate_pct)}</title></circle>`}).join('')}</svg>`;}
function renderRuns(runs){$('#runs').innerHTML=runs.map(run=>`<button class="run ${run.status} ${run.id===selectedId?'selected':''}" data-run="${escape(run.id)}"><span class="dot"></span><span>${escape(run.suite)} · ${escape(run.id.replace(/^.*?-/,''))}</span><time>${date(run.completed_at)}</time></button>`).join(''); $('#runs').querySelectorAll('[data-run]').forEach(button=>button.onclick=()=>loadRun(button.dataset.run));}
function renderTools(tools={}){$('#tools').innerHTML=Object.entries(tools).map(([name,summary])=>`<div class="tool"><label>${escape(name)}</label><p>${pct(summary.success_rate_pct)} 成功 · p95 ${ms(summary.total_latency?.p95_ms)}<br>${summary.total_cases} 个案例</p></div>`).join('')||'<p class="muted">此旧报告没有工具矩阵。</p>';}
async function renderCases(run, view) {
  $('#detail-title').textContent = `${run.suite.toUpperCase()} 明细`;
  $('#detail-meta').textContent = `${run.cases.length} 个案例 · ${date(run.completed_at)}${run.legacy ? ' · 兼容模式' : ''}`;
  const template = $('#case-template'), target = $('#cases'), artifacts = [];
  target.textContent = '';
  for (const item of run.cases) {
    const node = template.content.cloneNode(true);
    $('.status', node).classList.add(item.status);
    $('.name', node).textContent = item.name;
    $('.category', node).textContent = `${item.tool} / ${item.category ?? 'legacy'}`;
    $('.latency', node).textContent = `首结果 ${ms(item.first_valid_result_ms)} · 总计 ${ms(item.total_ms)}`;
    $('.stages', node).innerHTML = Object.entries(item.stages_ms ?? {}).map(([key, value]) => `<span class="stage">${escape(key.replace(/_ms$/, ''))} ${ms(value)}</span>`).join('');
    $('.checks', node).innerHTML = (item.quality?.checks ?? []).map(check => `<span class="check ${check.passed ? 'pass' : 'fail'}">${check.passed ? '✓' : '×'} ${escape(check.name)}</span>`).join('');
    if (item.error) {
      const error = $('.error', node);
      error.hidden = false;
      error.textContent = `${item.error.kind}: ${item.error.message}`;
    }
    if (item.artifact) {
      const target = $('.artifact', node), entry = (run.artifacts ?? []).find(value => value.name === item.artifact);
      if (entry) artifacts.push(loadArtifact(run.id, entry, item.name, target, view));
      else target.textContent = '产物不存在或已过期。';
    }
    target.append(node);
  }
  await Promise.all(artifacts);
}
async function loadArtifact(runId, entry, name, target, view) {
  target.textContent = '正在读取产物…';
  try {
    if (!['image/png', 'application/pdf'].includes(entry.type)) {
      target.textContent = '不支持的产物类型。';
      return;
    }
    const response = await request(`/api/evals/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(entry.name)}`, view);
    const blob = await response.blob();
    assertCurrent(view);
    const url = URL.createObjectURL(blob);
    artifactURLs.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    target.textContent = '';
    if (entry.type === 'image/png') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = `${name} 截图`;
      link.append(image);
    } else {
      const pdf = document.createElement('iframe');
      pdf.src = url;
      pdf.title = `${name} PDF`;
      target.append(pdf);
      link.textContent = '打开 PDF 产物';
    }
    const download = document.createElement('a');
    download.href = url;
    download.download = entry.name;
    download.textContent = '下载产物';
    target.append(link, download);
  } catch (error) {
    assertCurrent(view);
    if (error.status === 401 || error.name === 'AbortError') throw error;
    target.textContent = error.status === 404 ? '产物不存在或已过期。' : '无法读取产物，请刷新重试。';
  }
}
function beginView() {
  generation++;
  pending?.abort();
  pending = new AbortController();
  $('#content').hidden = true;
  $('#empty').hidden = true;
  for (const id of ['latest-meta', 'kpis', 'trend', 'runs', 'detail-meta', 'tools', 'cases']) $(`#${id}`).textContent = '';
  $('#detail-title').textContent = '运行明细';
  for (const url of artifactURLs) URL.revokeObjectURL(url);
  artifactURLs.clear();
  return generation;
}
function assertCurrent(view) {
  // Abort is best-effort: a response/body may finish after credentials change.
  if (view !== generation) throw new DOMException('Stale request', 'AbortError');
}
async function request(url, view) {
  assertCurrent(view);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    credentials: 'omit', referrerPolicy: 'no-referrer', signal: pending.signal,
  });
  assertCurrent(view);
  if (!response.ok) {
    const error = new Error('Protected request failed');
    error.status = response.status;
    throw error;
  }
  return response;
}
async function reportJSON(url, view) {
  const data = await (await request(url, view)).json();
  assertCurrent(view);
  return data;
}
function clearCredentials(message = '凭据已清除，请重新输入 Token。') {
  token = '';
  $('#token').value = '';
  index = null;
  selectedId = null;
  beginView();
  $('#refresh').disabled = true;
  $('#auth-status').textContent = message;
  $('#refresh-status').textContent = '未加载受保护的报告';
  $('#refresh-dot').style.background = 'var(--mute)';
}
function showFailure(error, view) {
  if (view !== generation || error.name === 'AbortError') return;
  if (error.status === 401) {
    clearCredentials('认证失败 (401)：Token 无效或已过期，请输入或替换 Token 后重试。');
  } else {
    beginView();
    $('#auth-status').textContent = error.status === 404 ? '报告不存在或已过期，请刷新报告。' : '无法读取报告，请刷新重试或替换 Token。';
  }
  $('#refresh-dot').style.background = 'var(--red)';
}
async function showRun(id, view) {
  const run = await reportJSON(`/api/evals/${encodeURIComponent(id)}`, view);
  selectedId = id;
  renderLatest(run);
  renderTrend(index.runs);
  renderRuns(index.runs);
  renderTools(run.tools);
  await renderCases(run, view);
  assertCurrent(view);
  $('#content').hidden = false;
  $('#auth-status').textContent = '已授权；凭据仅保留在当前页面内存中。';
}
async function loadRun(id) {
  if (!token || !index) return;
  const view = beginView();
  try { await showRun(id, view); }
  catch (error) { showFailure(error, view); }
}
async function refresh() {
  if (!token) return;
  const view = beginView();
  index = null;
  $('#refresh-dot').style.background = 'var(--lime)';
  $('#auth-status').textContent = '正在读取受保护的报告…';
  try {
    index = await reportJSON('/api/evals', view);
    if (!index.runs.length) {
      $('#empty').hidden = false;
      $('#auth-status').textContent = '已授权，尚无评测报告。';
    } else {
      await showRun(selectedId && index.runs.some(run => run.id === selectedId) ? selectedId : index.runs[0].id, view);
    }
    $('#refresh-status').textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 每 60 秒刷新`;
  } catch (error) { showFailure(error, view); }
}
$('#token-form').addEventListener('submit', event => {
  event.preventDefault();
  const supplied = $('#token').value.trim();
  clearCredentials();
  if (!supplied) return;
  token = supplied;
  $('#refresh').disabled = false;
  refresh();
});
$('#clear-token').addEventListener('click', () => clearCredentials());
$('#refresh').addEventListener('click', refresh);
let refreshTimer = setInterval(refresh, 60000);
window.addEventListener('pagehide', () => {
  clearInterval(refreshTimer);
  refreshTimer = null;
  clearCredentials();
});
window.addEventListener('pageshow', () => {
  if (refreshTimer === null) refreshTimer = setInterval(refresh, 60000);
});
