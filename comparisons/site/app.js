const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const acronyms = { qa: 'QA', prd: 'PRD', sdlc: 'SDLC', api: 'API' };
const title = (slug) =>
  slug
    .split('-')
    .map((s) => acronyms[s] ?? s[0].toUpperCase() + s.slice(1))
    .join(' ');
const pad = (n) => String(n).padStart(2, '0');
const partLabels = {
  manifest: 'Manifest',
  workflows: 'Control flow',
  contracts: 'Contracts',
  roster: 'Roster',
  promptIndex: 'Prompt index',
  templates: 'Templates',
  lib: 'Mechanics',
  resources: 'Resources',
};
const partOrder = Object.keys(partLabels);
const views = [
  ['source', 'Source comparison'],
  ['package', 'Package'],
  ['notes', 'Port notes'],
  ['support', 'Shared support'],
];
const compares = [
  ['three', 'All three'],
  ['earlier', 'Earlier port ↔ package'],
  ['original', 'Original ↔ package'],
];
let data,
  batch,
  workflow,
  view = 'source',
  params = {},
  lastHash = '';
// Code shown in each panel, for the copy buttons.
const shown = {};

const codePattern =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:async|await|const|let|var|return|if|else|for|while|of|in|new|export|default|import|from|function|type|interface|true|false|null|undefined|throw|try|catch)\b|\b\d+(?:[._]\d+)*\b)/g;
const templatePattern = /(\{#[\s\S]*?#\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\})/g;
const kindOf = (token, template) =>
  template
    ? token.startsWith('{#')
      ? 'comment'
      : token.startsWith('{%')
        ? 'keyword'
        : 'expr'
    : token.startsWith('/')
      ? 'comment'
      : /^["'`]/.test(token)
        ? 'string'
        : /^\d/.test(token)
          ? 'number'
          : 'keyword';
function highlight(source, path = '') {
  const template = path.endsWith('.md');
  let cursor = 0,
    html = '';
  for (const match of source.matchAll(template ? templatePattern : codePattern)) {
    html += escape(source.slice(cursor, match.index));
    const kind = kindOf(match[0], template);
    // Close spans at every line so line-number layout stays valid.
    html += match[0]
      .split('\n')
      .map((line) => `<span class="tok-${kind}">${escape(line)}</span>`)
      .join('\n');
    cursor = match.index + match[0].length;
  }
  html += escape(source.slice(cursor));
  return html
    .split('\n')
    .map((line, i) => `<span class="line" data-line="${i + 1}">${line || ' '}</span>`)
    .join('');
}
const lineCount = (text) => text.trimEnd().split('\n').length;
const language = (path) =>
  path.endsWith('.md')
    ? 'Markdown · MiniJinja'
    : path.endsWith('.json')
      ? 'JSON'
      : /\.m?js$/.test(path)
        ? 'JavaScript'
        : 'TypeScript';

// State lives in the page; the hash mirrors it for bookmarks where the host allows.
const hashFor = (values) =>
  `#${new URLSearchParams(Object.entries(values).filter(([, value]) => value != null))}`;
function navigate(values) {
  params = { ...params, ...values };
  for (const key of Object.keys(params)) if (params[key] === null) delete params[key];
  render();
  const next = hashFor(params);
  try {
    if (location.hash !== next) {
      lastHash = next;
      location.hash = next;
    }
  } catch {
    // A host that refuses fragment changes keeps the in-page state.
  }
}
const link = (values, label, extra = '') =>
  `<a href="${escape(hashFor({ ...params, ...values }))}" data-nav="${escape(JSON.stringify(values))}" ${extra}>${label}</a>`;

/** Earlier batches that hold this workflow, baseline first. */
function earlierPorts() {
  if (!batch.baseline) return [];
  const order = data.batches.map((b) => b.id);
  return data.batches
    .filter((b) => b.id !== batch.id && order.indexOf(b.id) > order.indexOf(batch.id))
    .sort((a, b) => (a.id === batch.baseline ? -1 : b.id === batch.baseline ? 1 : 0))
    .map((b) => ({ batch: b, workflow: b.workflows.find((w) => w.name === workflow.name) }))
    .filter((entry) => entry.workflow);
}
/** The files a panel can show: [{ key, group, label, path, content }]. */
function panelFiles(panel) {
  if (panel === 'original')
    return [
      {
        key: 'original',
        group: 'Upstream',
        label: `${workflow.name}.js`,
        path: `${workflow.name}.js`,
        content: workflow.original,
      },
    ];
  if (panel === 'earlier')
    return earlierPorts().flatMap(({ batch: b, workflow: w }) => [
      {
        key: `${b.id}:${w.name}.workflow.ts`,
        group: b.label,
        label: `${w.name}.workflow.ts`,
        path: `${w.name}.workflow.ts`,
        content: w.ported,
      },
      ...Object.entries(b.support).map(([file, content]) => ({
        key: `${b.id}:${file}`,
        group: b.label,
        label: file,
        path: file,
        content,
      })),
    ]);
  if (workflow.package)
    return workflow.package.files.map((file) => ({
      key: file.path,
      group: partLabels[file.part],
      label: file.path,
      path: file.path,
      content: file.content,
    }));
  return [
    {
      key: 'ported',
      group: batch.label,
      label: `${workflow.name}.workflow.ts`,
      path: `${workflow.name}.workflow.ts`,
      content: workflow.ported,
    },
  ];
}
function options(files, selected) {
  const groups = [...new Set(files.map((file) => file.group))];
  return groups
    .map(
      (group) =>
        `<optgroup label="${escape(group)}">${files
          .filter((file) => file.group === group)
          .map(
            (file) =>
              `<option value="${escape(file.key)}"${file.key === selected ? ' selected' : ''}>${escape(file.label)}</option>`,
          )
          .join('')}</optgroup>`,
    )
    .join('');
}
function codePanel(panel, side, label, files, selectedKey, accent) {
  const file = files.find((f) => f.key === selectedKey) ?? files[0];
  shown[panel] = file.content;
  const picker =
    files.length > 1
      ? `<label class="visually-hidden" for="pick-${panel}">${escape(side)} file</label><select class="file-picker" id="pick-${panel}" data-panel="${panel}">${options(files, file.key)}</select>`
      : `<span class="file-single">${escape(file.label)}</span>`;
  return `<article class="code-panel ${accent}" aria-label="${escape(side)}: ${escape(label)}"><div class="code-heading"><span class="side-label">${escape(side)}</span><span class="code-title">${escape(label)}</span><button class="copy" data-copy="${panel}" aria-label="Copy ${escape(side.toLowerCase())} source">Copy</button></div><div class="code-filename">${picker}<span class="file-meta">${escape(language(file.path))} · ${lineCount(file.content)} lines</span></div><pre tabindex="0" aria-label="${escape(label)} source code"><code>${highlight(file.content, file.path)}</code></pre></article>`;
}

function render() {
  batch = data.batches.find((b) => b.id === params.batch) ?? data.batches[0];
  workflow =
    batch.workflows.find((w) => w.name === params.workflow) ??
    batch.workflows.find((w) => w.name === 'bug-hunt') ??
    batch.workflows[0];
  const available = views.filter(([id]) => id !== 'package' || workflow.package);
  view = available.some(([id]) => id === params.view) ? params.view : 'source';
  $('#batch').value = batch.id;
  $('#batch-description').textContent = batch.description;
  $('#count').textContent = pad(batch.workflows.length);
  $('#workflows').innerHTML = batch.workflows
    .map((w, i) =>
      link(
        { batch: batch.id, workflow: w.name, earlierFile: null, currentFile: null, file: null },
        `<span class="nav-number">${pad(i + 1)}</span>${escape(title(w.name))}${w.package ? '<span class="nav-tag">pkg</span>' : ''}`,
        w.name === workflow.name ? 'aria-current="page"' : '',
      ),
    )
    .join('');
  $('#provenance').innerHTML =
    `Source: hesreallyhim / ultracode-workflows<a href="${escape(batch.sourceUrl)}" target="_blank" rel="noreferrer">Snapshot ${escape(batch.revision.slice(0, 7))} ↗</a><a href="./license.txt">MIT · © 2026 Really Him</a>`;
  const notes = workflow.notes;
  const badge = workflow.package
    ? `CLAUDE → ${escape(workflow.package.dir.toUpperCase())}`
    : 'CLAUDE → QUIET CHOIR';
  $('#content').innerHTML =
    `<div class="breadcrumb"><span>WORKFLOW LAB</span><span>/</span><span>${escape(batch.label.toUpperCase())}</span><span>/</span><span>${escape(workflow.name)}</span></div>
    <div class="heading-row"><div><h1>${escape(title(workflow.name))}</h1><p class="summary">${escape(notes?.summary ?? workflow.description)}</p></div><span class="badge">${badge}</span></div>
    <div class="phases" aria-label="Original workflow phases">${(workflow.phases ?? []).map((p, i) => `<span class="phase" title="${escape(p.detail)}"><span class="phase-number">${pad(i + 1)}</span>${escape(p.title)}</span>`).join('')}</div>
    <div class="review-strip"><strong>Port note:</strong> ${escape(notes?.changes?.[0] ?? 'Direct port. Preserve prompts and control flow; make the API differences explicit.')}</div>
    <div class="tabbar" role="tablist" aria-label="Comparison view">${available
      .map(
        ([id, label]) =>
          `<button role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${view === id}" aria-controls="panel" tabindex="${view === id ? 0 : -1}">${label}</button>`,
      )
      .join(
        '',
      )}<span class="tabmeta">BATCH ${escape(batch.number)} / ${batch.workflows.length} WORKFLOWS</span></div>
    <section id="panel" role="tabpanel" aria-labelledby="tab-${escape(view)}">${view === 'source' ? sourceView() : view === 'package' ? packageView() : view === 'notes' ? notesView() : supportView()}</section>`;
  document.title = `${title(workflow.name)} · ${batch.label} · Workflow Lab`;
  bind();
}

function bind() {
  document.querySelectorAll('[data-nav]').forEach((anchor) =>
    anchor.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(JSON.parse(anchor.dataset.nav));
    }),
  );
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      navigate({ view: button.dataset.tab });
      $(`[data-tab="${view}"]`)?.focus();
    });
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
        tabs[next].click();
      }
    });
  });
  document
    .querySelectorAll('[data-compare]')
    .forEach((button) =>
      button.addEventListener('click', () => navigate({ compare: button.dataset.compare })),
    );
  document.querySelectorAll('.file-picker').forEach((select) =>
    select.addEventListener('change', () => {
      navigate({ [`${select.dataset.panel}File`]: select.value });
      $(`#pick-${select.dataset.panel}`)?.focus();
    }),
  );
  document.querySelectorAll('[data-file]').forEach((button) =>
    button.addEventListener('click', () => {
      navigate({ file: button.dataset.file });
      $(`[data-file="${CSS.escape(button.dataset.file)}"]`)?.focus();
    }),
  );
  document.querySelectorAll('[data-copy]').forEach((button) =>
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shown[button.dataset.copy]);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select code to copy';
      }
    }),
  );
  $('#support-file')?.addEventListener('change', (event) => {
    $('#support-code').innerHTML = highlight(batch.support[event.target.value], event.target.value);
  });
}

function sourceView() {
  const earlier = earlierPorts();
  if (!earlier.length)
    return `<div class="code-grid">${codePanel('original', 'Before', 'Claude Code', panelFiles('original'), 'original', '')}${codePanel('current', 'After', 'Quiet Choir', panelFiles('current'), 'ported', 'after')}</div><div class="source-footer">Original source is preserved verbatim. The port uses named Quiet Choir effects explicitly. Read ${link({ view: 'notes' }, 'port notes')} for equivalence limits. ${escape(batch.validation)}</div>`;
  const compare = compares.some(([id]) => id === params.compare) ? params.compare : 'three';
  const current = panelFiles('current');
  const panels = {
    original: codePanel(
      'original',
      'Upstream',
      'Claude Code',
      panelFiles('original'),
      'original',
      '',
    ),
    earlier: codePanel(
      'earlier',
      'Earlier port',
      'Quiet Choir',
      panelFiles('earlier'),
      params.earlierFile ?? `${batch.baseline}:${workflow.name}.workflow.ts`,
      'earlier',
    ),
    current: codePanel(
      'current',
      `Batch ${batch.number}`,
      workflow.package ? workflow.package.dir : 'Quiet Choir',
      current,
      params.currentFile ?? workflow.package?.entry ?? 'ported',
      'after',
    ),
  };
  const shownPanels =
    compare === 'three'
      ? ['original', 'earlier', 'current']
      : compare === 'earlier'
        ? ['earlier', 'current']
        : ['original', 'current'];
  return `<div class="compare-bar"><span class="eyebrow">COMPARE</span><div class="segmented" role="group" aria-label="Panels to compare">${compares
    .map(
      ([id, label]) =>
        `<button type="button" data-compare="${id}" aria-pressed="${compare === id}">${label}</button>`,
    )
    .join(
      '',
    )}</div><span class="compare-hint">Pick any file of the earlier ports or the package in each panel's header.</span></div><div class="code-grid cols-${shownPanels.length}">${shownPanels.map((panel) => panels[panel]).join('')}</div><div class="source-footer">The upstream source is preserved verbatim. The earlier port panel holds ${earlier.map(({ batch: b }) => escape(b.label)).join(' and ')}, with ${escape(earlier[0].batch.label)} first; the package panel opens on the control-flow module. Read ${link({ view: 'package' }, 'the package')} for its parts, roster and templates, and ${link({ view: 'notes' }, 'port notes')} for equivalence limits.</div>`;
}

function composition(pkg) {
  const totals = {};
  for (const file of pkg.files) totals[file.part] = (totals[file.part] ?? 0) + file.lines;
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const entries = partOrder.filter((part) => totals[part]);
  return `<div class="composition"><div class="bar" role="img" aria-label="${escape(entries.map((part) => `${partLabels[part]} ${totals[part]} lines`).join(', '))}">${entries
    .map(
      (part) =>
        `<span class="seg part-${part}" style="flex-grow:${totals[part]}" title="${escape(partLabels[part])}: ${totals[part]} lines"></span>`,
    )
    .join('')}</div><ul class="legend">${entries
    .map(
      (part) =>
        `<li><span class="swatch part-${part}" aria-hidden="true"></span>${escape(partLabels[part])}<span class="num">${totals[part]}</span></li>`,
    )
    .join(
      '',
    )}</ul><p class="composition-total">${sum} lines in ${pkg.files.length} files${pkg.manifest ? `; the CLI fingerprints ${pkg.manifest.files.count} files, ${pkg.manifest.files.bytes.toLocaleString('en-US')} bytes` : ''}.</p></div>`;
}
function tree(pkg, selected) {
  const groups = partOrder.filter((part) => pkg.files.some((file) => file.part === part));
  return `<nav class="tree" aria-label="Package files">${groups
    .map(
      (part) =>
        `<div class="tree-group"><span class="tree-part"><span class="swatch part-${part}" aria-hidden="true"></span>${escape(partLabels[part])}</span>${pkg.files
          .filter((file) => file.part === part)
          .map(
            (file) =>
              `<button type="button" data-file="${escape(file.path)}" aria-current="${file.path === selected}" title="${escape(file.path)}"><span>${escape(file.path.replace(/^(?:workflows|prompts|lib|resources)\//, ''))}</span><span class="num">${file.lines}</span></button>`,
          )
          .join('')}</div>`,
    )
    .join('')}</nav>`;
}
function rosterTable(manifest) {
  const rows = manifest.workflows.flatMap((declared) =>
    declared.roster.map(
      (entry) =>
        `<tr><td><code>${escape(entry.name)}</code></td>${manifest.workflows.length > 1 ? `<td>${escape(declared.name)}</td>` : ''}<td>${escape(entry.harness)}</td><td><span class="access access-${escape(entry.access)}">${escape(entry.access)}</span></td><td>${escape(entry.model ?? 'default')}</td><td>${escape(entry.effort ?? 'default')}</td><td>${escape(entry.description ?? '')}</td></tr>`,
    ),
  );
  const deciders = Object.entries(manifest.deciders ?? {}).map(
    ([name, decider]) =>
      `<tr><td><code>${escape(name)}</code></td>${manifest.workflows.length > 1 ? `<td>${escape(manifest.entry)}</td>` : ''}<td>decider: ${escape(decider.provider)}</td><td><span class="access access-none">none</span></td><td>${escape(decider.model ?? 'configured')}</td><td>—</td><td>${escape(decider.description ?? '')}</td></tr>`,
  );
  return `<div class="table-wrap"><table><thead><tr><th>Entry</th>${manifest.workflows.length > 1 ? '<th>Workflow</th>' : ''}<th>Harness</th><th>Access</th><th>Model</th><th>Effort</th><th>Role</th></tr></thead><tbody>${[...rows, ...deciders].join('')}</tbody></table></div>`;
}
function promptTable(manifest) {
  const rows = manifest.prompts.flatMap((set) =>
    set.entries.map(
      (entry) =>
        `<tr><td><code>${escape(entry.name)}</code></td><td>${escape(set.root.split('/').slice(-2, -1)[0])}</td><td>${escape(entry.file)}</td><td>${entry.params.map((param) => `<code>${escape(param)}</code>`).join(' ')}</td><td>${escape(entry.description ?? '')}</td></tr>`,
    ),
  );
  return `<div class="table-wrap"><table><thead><tr><th>Template</th><th>Package</th><th>File</th><th>Parameters</th><th>Purpose</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function packageView() {
  const pkg = workflow.package;
  const file =
    pkg.files.find((f) => f.path === params.file) ?? pkg.files.find((f) => f.path === pkg.entry);
  shown.package = file.content;
  const manifest = pkg.manifest;
  const path = `comparisons/batches/${batch.id}/ported/${pkg.dir}`;
  const run = `npm run cli -- workflow validate ${path} --json\nnpm run cli -- workflow execute ${path} --run-id ${workflow.name}-1 --input @input.json`;
  return `<div class="package"><header class="package-head"><div><p class="eyebrow">PACKAGE</p><h2><code>${escape(pkg.dir)}</code></h2><p class="package-meta">${manifest ? `${escape(manifest.name)}@${escape(manifest.version)} · entry <code>${escape(manifest.entry)}</code> · ${manifest.workflows.length} workflow${manifest.workflows.length === 1 ? '' : 's'}` : ''}</p></div>${manifest ? `<dl class="package-facts"><div><dt>Description</dt><dd>${escape(manifest.description)}</dd></div><div><dt>When to use</dt><dd>${escape(manifest.whenToUse)}</dd></div></dl>` : ''}</header>${composition(pkg)}<div class="explorer">${tree(pkg, file.path)}<article class="code-panel after" aria-label="Package file"><div class="code-heading"><span class="side-label">${escape(partLabels[file.part])}</span><span class="code-title">${escape(file.path)}</span><button class="copy" data-copy="package" aria-label="Copy package file">Copy</button></div><div class="code-filename"><span class="file-meta">${escape(language(file.path))} · ${file.lines} lines</span></div><pre tabindex="0" aria-label="${escape(file.path)}"><code>${highlight(file.content, file.path)}</code></pre></article></div>${
    manifest
      ? `<section class="package-section"><h3>Roster</h3><p class="muted">As <code>workflow validate --json</code> reports it; access is the pinned harness's alone, and effort comes from the capability manifest.</p>${rosterTable(manifest)}</section><section class="package-section"><h3>Prompt templates</h3><p class="muted">Every agent prompt in the workflow tree, with its typed parameters. Rendered text is step identity, so a template edit is refused on resume like a code edit.</p>${promptTable(manifest)}</section>`
      : ''
  }<section class="package-section"><h3>Run it</h3><p class="muted">From a built checkout; validate first, then provide the described input. The CLI takes the package directory wherever it takes a workflow file.</p><pre class="snippet"><code>${escape(run)}</code></pre></section></div>`;
}

function measuredTable() {
  const current = workflow.measured?.[String(Number(batch.number))];
  const earlier = earlierPorts()[0];
  const before = earlier?.workflow.measured?.[String(Number(earlier.batch.number))];
  if (!current || !before) return '';
  const fault = (cell) =>
    !cell || cell.finalStatus === 'not-applicable'
      ? 'n/a'
      : `${cell.initialStatus ?? '—'} → ${cell.finalStatus}; ${cell.callsPaidAgain} repaid${cell.outputAdmitsDegradation ? '; output admits it' : ''}`;
  const rows = [
    ['Control-flow lines', before.formattedLines, current.formattedLines],
    [
      'Package',
      'one workflow file + shared batch helpers',
      `${current.package.lines} lines in ${current.package.files} files`,
    ],
    ['Agent calls (success fixture)', before.agentCalls, current.agentCalls],
    ['Calls through prompt templates', 'none (inline strings)', current.templatedCalls],
    ['Write-capable calls', before.writeToolCalls, current.writeToolCalls],
    ...['F1', 'F2', 'F3', 'F4', 'F5'].map((f) => [
      `${f} ${{ F1: 'process failure', F2: 'invalid output', F3: 'SIGKILL at a write', F4: 'code fix and resume', F5: 'human question' }[f]}`,
      fault(before.faults[f]),
      fault(current.faults[f]),
    ]),
  ];
  return `<div class="note-block"><h2>Measured on the fixture path</h2><div><div class="table-wrap"><table class="measured"><thead><tr><th>Measure</th><th>${escape(earlier.batch.label)}</th><th>${escape(batch.label)}</th></tr></thead><tbody>${rows.map(([label, a, b]) => `<tr><th scope="row">${escape(label)}</th><td>${escape(a)}</td><td>${escape(b)}</td></tr>`).join('')}</tbody></table></div><p class="muted">Inert harness replies with real Git, commands, writes and SIGKILLs. Call counts are fixture observations, not cost or quality.</p></div></div>`;
}
function notesView() {
  const n = workflow.notes ?? {};
  return `<div class="notes">${block('What it does', n.summary ?? workflow.description)}${block('What stays the same', n.preserved ?? 'The original prompts, branching, and aggregation are retained.')}<div class="note-block"><h2>What changes</h2><ul>${(n.changes ?? []).map((x) => `<li>${escape(x)}</li>`).join('')}</ul></div>${measuredTable()}<details class="shared-notes"><summary>Translation choices shared by all ${batch.workflows.length} ports</summary><ul>${batch.commonChanges.map((x) => `<li>${escape(x)}</li>`).join('')}</ul></details>${batch.apiFindings ? `<details class="shared-notes"><summary>API friction found while porting this batch</summary><ul>${batch.apiFindings.map((x) => `<li>${escape(x)}</li>`).join('')}</ul></details>` : ''}${block('Evaluation notes', n.evaluation ?? 'Review the explicit differences before treating the two implementations as interchangeable.')}${block('Verification', batch.validation)}<p class="report-links">${Object.entries(
    batch.reports ?? {},
  )
    .map(([name, path]) => `<a href="${escape(path)}">Open ${escape(name)} JSON ↗</a>`)
    .join(
      ' · ',
    )}</p>${block('Target API', `${batch.apiSnapshot.package} · ${batch.apiSnapshot.description} API SHA-256: ${batch.apiSnapshot.sha256} Commit on main: ${batch.apiSnapshot.revision ? batch.apiSnapshot.revision.slice(0, 10) : 'not yet committed'}.`)}<div class="note-block"><h2>Source & attribution</h2><p><a href="${escape(batch.sourceFileBase + workflow.name + '.js')}" target="_blank" rel="noreferrer">View the pinned original on GitHub ↗</a><br>Original workflows © 2026 Really Him, MIT. Ports retain this license. Snapshot: <code>${escape(batch.revision)}</code>.</p></div></div>`;
}
function block(label, text) {
  return `<div class="note-block"><h2>${escape(label)}</h2><p>${escape(text)}</p></div>`;
}
function supportView() {
  const entries = Object.keys(batch.support);
  const intro = batch.workflows.some((w) => w.package)
    ? 'Each port in this batch is a self-contained package; its helpers live in its own lib/ (see the Package tab). The batch compiler settings below apply to every package.'
    : 'These support files belong to this batch. The helpers adapt composition and durable step IDs; they are not new Quiet Choir APIs. The compiler settings are included for review.';
  return `<div class="support"><p>${intro}</p><label class="eyebrow" for="support-file">SUPPORT FILE</label><select id="support-file">${entries.map((name) => `<option>${escape(name)}</option>`).join('')}</select><pre tabindex="0" aria-label="Shared support source"><code id="support-code">${highlight(batch.support[entries[0]], entries[0])}</code></pre></div>`;
}

const parse = (hash) => Object.fromEntries(new URLSearchParams(hash.slice(1)));
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
    navigate({
      batch: next.id,
      workflow: next.workflows.some((w) => w.name === workflow.name)
        ? workflow.name
        : next.workflows[0].name,
      earlierFile: null,
      currentFile: null,
      file: null,
    });
  });
  addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    params = parse(location.hash);
    render();
  });
  params = parse(location.hash);
  render();
} catch (error) {
  $('#content').innerHTML = '';
  $('#error').hidden = false;
  $('#error').textContent =
    `Unable to load the workflow comparisons. ${error.message} Please reload the page.`;
}
