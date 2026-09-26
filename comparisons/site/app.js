const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const title = (slug) =>
  slug
    .split('-')
    .map((s) =>
      s === 'qa'
        ? 'QA'
        : s === 'prd'
          ? 'PRD'
          : s === 'sdlc'
            ? 'SDLC'
            : s === 'api'
              ? 'API'
              : s[0].toUpperCase() + s.slice(1),
    )
    .join(' ');
let data,
  batch,
  workflow,
  tab = 'source';
function highlight(source) {
  const pattern =
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:async|await|const|let|var|return|if|else|for|while|of|in|new|export|default|import|from|function|type|interface|true|false|null|undefined|throw|try|catch)\b|\b\d+(?:[._]\d+)*\b)/g;
  let cursor = 0,
    html = '';
  for (const match of source.matchAll(pattern)) {
    html += escape(source.slice(cursor, match.index));
    const token = match[0];
    const kind = token.startsWith('/')
      ? 'comment'
      : /^["'`]/.test(token)
        ? 'string'
        : /^\d/.test(token)
          ? 'number'
          : 'keyword';
    // Close spans at every line so line-number layout stays valid.
    html += token
      .split('\n')
      .map((line) => `<span class="tok-${kind}">${escape(line)}</span>`)
      .join('\n');
    cursor = match.index + token.length;
  }
  html += escape(source.slice(cursor));
  return html
    .split('\n')
    .map((line, i) => `<span class="line" data-line="${i + 1}">${line || ' '}</span>`)
    .join('');
}
function route(values = {}) {
  const p = new URLSearchParams({ batch: batch.id, workflow: workflow.name, view: tab, ...values });
  location.hash = p.toString();
}
function renderRoute() {
  const params = new URLSearchParams(location.hash.slice(1));
  batch = data.batches.find((b) => b.id === params.get('batch')) ?? data.batches[0];
  workflow =
    batch.workflows.find((w) => w.name === params.get('workflow')) ??
    batch.workflows.find((w) => w.name === 'bug-hunt') ??
    batch.workflows[0];
  tab = ['source', 'notes', 'support'].includes(params.get('view')) ? params.get('view') : 'source';
  $('#batch').value = batch.id;
  $('#batch-description').textContent = batch.description;
  $('#count').textContent = String(batch.workflows.length).padStart(2, '0');
  $('#workflows').innerHTML = batch.workflows
    .map(
      (w, i) =>
        `<a href="#${new URLSearchParams({ batch: batch.id, workflow: w.name, view: tab })}" ${w.name === workflow.name ? 'aria-current="page"' : ''}><span class="nav-number">${String(i + 1).padStart(2, '0')}</span>${escape(title(w.name))}</a>`,
    )
    .join('');
  $('#provenance').innerHTML =
    `Source: hesreallyhim / ultracode-workflows<a href="${escape(batch.sourceUrl)}" target="_blank" rel="noreferrer">Snapshot ${escape(batch.revision.slice(0, 7))} ↗</a><a href="./license.txt">MIT · © 2026 Really Him</a>`;
  const notes = workflow.notes;
  $('#content').innerHTML =
    `<div class="breadcrumb"><span>WORKFLOW LAB</span><span>/</span><span>${escape(batch.label.toUpperCase())}</span><span>/</span><span>${escape(workflow.name)}</span></div>
    <div class="heading-row"><div><h1>${escape(title(workflow.name))}</h1><p class="summary">${escape(notes?.summary ?? workflow.description)}</p></div><span class="badge">CLAUDE → CLAUDE</span></div>
    <div class="phases" aria-label="Original workflow phases">${(workflow.phases ?? []).map((p, i) => `<span class="phase" title="${escape(p.detail)}"><span class="phase-number">${String(i + 1).padStart(2, '0')}</span>${escape(p.title)}</span>`).join('')}</div>
    <div class="review-strip"><strong>Port note:</strong> ${escape(notes?.changes?.[0] ?? 'Direct port. Preserve prompts and control flow; make the API differences explicit.')}</div>
    <div class="tabbar" role="tablist" aria-label="Comparison view">${[
      ['source', 'Source comparison'],
      ['notes', 'Port notes'],
      ['support', 'Shared support'],
    ]
      .map(
        ([id, label]) =>
          `<button role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${tab === id}" aria-controls="panel" tabindex="${tab === id ? 0 : -1}">${label}</button>`,
      )
      .join(
        '',
      )}<span class="tabmeta">BATCH ${escape(batch.number)} / ${batch.workflows.length} WORKFLOWS</span></div>
    <section id="panel" role="tabpanel" aria-labelledby="tab-${tab}">${tab === 'source' ? sourceView() : tab === 'notes' ? notesView() : supportView()}</section>`;
  document.title = `${title(workflow.name)} · ${batch.label} · Workflow Lab`;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => route({ view: button.dataset.tab }));
    button.addEventListener('keydown', (event) => {
      const tabs = [...document.querySelectorAll('[data-tab]')];
      const index = tabs.indexOf(button);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        tabs[next].focus();
        tabs[next].click();
      }
    });
  });
  document.querySelectorAll('[data-copy]').forEach((button) =>
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(workflow[button.dataset.copy]);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select code to copy';
      }
    }),
  );
  $('#support-file')?.addEventListener('change', (event) => {
    $('#support-code').innerHTML = highlight(batch.support[event.target.value]);
  });
}
function sourceView() {
  return `<div class="code-grid">${[
    ['original', 'Before', 'Claude Code', 'JavaScript'],
    ['ported', 'After', 'Quiet Choir', 'TypeScript'],
  ]
    .map(
      ([key, side, label, language]) =>
        `<article class="code-panel ${key === 'ported' ? 'after' : ''}" aria-label="${side}: ${label}"><div class="code-heading"><span class="side-label">${side}</span><span class="code-title">${label}</span><span class="lang">${language}</span><button class="copy" data-copy="${key}" aria-label="Copy ${side.toLowerCase()} source">Copy</button></div><div class="code-filename">${escape(workflow.name)}${key === 'original' ? '.js' : '.workflow.ts'} · ${workflow[key].split('\n').length} lines</div><pre tabindex="0" aria-label="${label} source code"><code>${highlight(workflow[key])}</code></pre></article>`,
    )
    .join(
      '',
    )}</div><div class="source-footer">Original source is preserved verbatim. The port calls <code>ctx.claude</code> explicitly. Read <a href="#${new URLSearchParams({ batch: batch.id, workflow: workflow.name, view: 'notes' })}">port notes</a> for equivalence limits. ${escape(batch.validation)}</div>`;
}
function notesView() {
  const n = workflow.notes ?? {};
  return `<div class="notes">${block('What it does', n.summary ?? workflow.description)}${block('What stays the same', n.preserved ?? 'The original prompts, branching, and aggregation are retained.')}<div class="note-block"><h2>What changes</h2><ul>${(n.changes ?? []).map((x) => `<li>${escape(x)}</li>`).join('')}</ul></div><details class="shared-notes"><summary>Translation choices shared by all ${batch.workflows.length} ports</summary><ul>${batch.commonChanges.map((x) => `<li>${escape(x)}</li>`).join('')}</ul></details>${block('Evaluation notes', n.evaluation ?? 'Review the explicit differences before treating the two implementations as interchangeable.')}${block('Verification', batch.validation)}${block('Target API', `${batch.apiSnapshot.package} · ${batch.apiSnapshot.description} API SHA-256: ${batch.apiSnapshot.sha256}`)}<div class="note-block"><h2>Source & attribution</h2><p><a href="${escape(batch.sourceFileBase + workflow.name + '.js')}" target="_blank" rel="noreferrer">View the pinned original on GitHub ↗</a><br>Original workflows © 2026 Really Him, MIT. Ports retain this license. Snapshot: <code>${escape(batch.revision)}</code>.</p></div></div>`;
}
function block(label, text) {
  return `<div class="note-block"><h2>${escape(label)}</h2><p>${escape(text)}</p></div>`;
}
function supportView() {
  const entries = Object.keys(batch.support);
  return `<div class="support"><p>These support files belong to this batch. The helpers adapt composition and durable step IDs; they are not new Quiet Choir APIs. The compiler settings are included for review.</p><label class="eyebrow" for="support-file">SUPPORT FILE</label><select id="support-file">${entries.map((name) => `<option>${escape(name)}</option>`).join('')}</select><pre tabindex="0" aria-label="Shared support source"><code id="support-code">${highlight(batch.support[entries[0]])}</code></pre></div>`;
}
$('#content').append($('#loading').content.cloneNode(true));
try {
  const response = await fetch('./data.json');
  if (!response.ok) throw new Error('Comparison data is unavailable.');
  data = await response.json();
  $('#batch').innerHTML = data.batches
    .map((b) => `<option value="${escape(b.id)}">${escape(b.label)}</option>`)
    .join('');
  $('#batch').addEventListener('change', (event) => {
    const next = data.batches.find((b) => b.id === event.target.value);
    route({
      batch: next.id,
      workflow: next.workflows.some((w) => w.name === workflow.name)
        ? workflow.name
        : next.workflows[0].name,
    });
  });
  addEventListener('hashchange', () => {
    const focus = document.activeElement?.dataset?.tab;
    renderRoute();
    if (focus) document.querySelector(`[data-tab="${tab}"]`)?.focus();
  });
  renderRoute();
} catch (error) {
  $('#content').innerHTML = '';
  $('#error').hidden = false;
  $('#error').textContent =
    `Unable to load the workflow comparisons. ${error.message} Please reload the page.`;
}
