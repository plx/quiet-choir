import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkSkills, packages, repository, sourceExample } from '../scripts/check-skills.mjs';
import { anchors, checkLinks, fences, prose } from '../scripts/skill-markdown.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'qc-skill-check-'));
  try {
    for (const path of ['plugins', '.agents/plugins', '.claude-plugin'])
      await cp(join(repository, path), join(root, path), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const skill = (root, host = 0) => join(root, packages[host], 'skills/quiet-choir/SKILL.md');
async function append(root, text, both = true) {
  for (const index of both ? [0, 1] : [0]) {
    const file = skill(root, index);
    await writeFile(file, (await readFile(file, 'utf8')) + text);
  }
}

test('broken complete TypeScript is rejected at the documentation line', async () => {
  await fixture(async (root) => {
    await append(root, '\n```ts\nexport const broken: number = "wrong";\n```\n');
    await assert.rejects(checkSkills(root), /SKILL\.md:\d+: TS2322/u);
  });
});
test('a fence importing quiet-choir/github compiles, and a wrong export is rejected at its line', async () => {
  const fence = (name) =>
    `\n\`\`\`ts\nimport { z } from 'quiet-choir';\nimport { ${name} } from 'quiet-choir/github';\n\nexport const pick = (value: unknown) => z.unknown().parse(${name}) ?? value;\n\`\`\`\n`;
  await fixture(async (root) => {
    await append(root, fence('nextTicket'));
    await checkSkills(root);
  });
  await fixture(async (root) => {
    const before = (await readFile(skill(root), 'utf8')).split('\n').length;
    await append(root, fence('noSuchExport'));
    // The appended text starts on the file's last (empty) line; the github import is three later.
    await assert.rejects(
      checkSkills(root),
      new RegExp(`SKILL\\.md:${String(before + 3)}: TS2305: .*noSuchExport`, 'u'),
    );
  });
});
test('sourceExample maps quiet-choir/github beside the runtime it maps the root to', () => {
  const code = [
    "import { z } from 'quiet-choir';",
    "import { github } from 'quiet-choir/github';",
    "import { defineWorkflow } from '../../src/index.js';",
    "import { nextTicket } from '../../src/integrations/github.js';",
    "const prompt = 'quiet-choir/github';",
  ].join('\n');
  const dist = join(repository, 'dist/index.js');
  const rewritten = sourceExample(code, dist).split('\n');
  assert.deepEqual(rewritten.slice(0, 4), [
    `import { z } from ${JSON.stringify(dist)};`,
    `import { github } from ${JSON.stringify(join(repository, 'dist/integrations/github.js'))};`,
    `import { defineWorkflow } from ${JSON.stringify(dist)};`,
    `import { nextTicket } from ${JSON.stringify(join(repository, 'dist/integrations/github.js'))};`,
  ]);
  // Strings that merely look like specifiers stay intact.
  assert.equal(rewritten[4], "const prompt = 'quiet-choir/github';");
  assert.match(sourceExample(code), /src\/integrations\/github\.js/u);
});
for (const [name, path, transform] of [
  [
    'portable manifest',
    `${packages[0]}/plugin.json`,
    (data) => {
      data.name = 'Invalid Name';
    },
  ],
  [
    'Claude manifest',
    `${packages[1]}/.claude-plugin/plugin.json`,
    (data) => {
      data.author = {};
    },
  ],
  [
    'marketplace path',
    '.agents/plugins/marketplace.json',
    (data) => {
      data.plugins[0].source.path = '../outside';
    },
  ],
])
  test(`rejects invalid ${name}`, async () => {
    await fixture(async (root) => {
      const file = join(root, path),
        data = JSON.parse(await readFile(file, 'utf8'));
      transform(data);
      await writeFile(file, JSON.stringify(data));
      await assert.rejects(
        checkSkills(root, { compile: false }),
        /invalid manifest|invalid marketplace source/u,
      );
    });
  });
for (const [label, text, expected] of [
  [
    'empty fragment reason',
    '\n<!-- skills-check: fragment; reason:   -->\n```ts\nbroken\n```\n',
    /invalid example\/fragment annotation/u,
  ],
  ['dangling link', '\n[missing](references/missing.md)\n', /dangling link/u],
  [
    'dangling link in mixed-case raw HTML',
    '\n<A HREF="references/missing.md">missing</A>\n',
    /dangling link/u,
  ],
  [
    'dangling link in raw HTML with spaced attribute',
    "\n<img src = 'references/missing.md'>\n",
    /dangling link/u,
  ],
  [
    'dangling link in raw HTML with a quoted greater-than before href',
    '\n<a title=">" href="references/missing.md">missing</a>\n',
    /dangling link/u,
  ],
  [
    'missing anchor',
    '\n[missing](references/agent-calls.md#does-not-exist)\n',
    /missing link anchor/u,
  ],
  ['package escape', '\n[escape](../../../../AGENTS.md)\n', /link escapes package/u],
  ['unlisted copy edit', '\nUnexpected independent change.\n', /unlisted difference/u],
  [
    'unknown difference region',
    '\n<!-- skills-difference: unknown -->\nHidden\n<!-- /skills-difference: unknown -->\n',
    /unlisted difference region/u,
  ],
  [
    'malformed skip marker',
    '\n<!-- skills-check: fragment -->\n```ts\nnot valid\n```\n',
    /invalid example\/fragment annotation/u,
  ],
])
  test(`rejects ${label}`, async () => {
    await fixture(async (root) => {
      await append(root, text, false);
      await assert.rejects(checkSkills(root, { compile: false }), expected);
    });
  });
test('rejects difference markers nested inside an approved region', async () => {
  await fixture(async (root) => {
    const file = skill(root, 1);
    const text = await readFile(file, 'utf8');
    const marker = '<!-- /skills-difference: claude-host -->';
    assert.ok(text.includes(marker));
    await writeFile(
      file,
      text.replace(
        marker,
        `<!-- skills-difference: unknown -->\nHidden\n<!-- /skills-difference: unknown -->\n${marker}`,
      ),
    );
    await assert.rejects(checkSkills(root, { compile: false }), /malformed difference marker/u);
  });
});
test('rejects malformed nested difference marker variants', async () => {
  await fixture(async (root) => {
    const file = skill(root, 1);
    const text = await readFile(file, 'utf8');
    const marker = '<!-- /skills-difference: claude-host -->';
    assert.ok(text.includes(marker));
    await writeFile(file, text.replace(marker, `<!-- skills-difference : unknown -->\n${marker}`));
    await assert.rejects(
      checkSkills(root, { compile: false }),
      /nested or malformed difference marker/u,
    );
  });
});
test('a shell fence invoking bare quiet-choir is rejected at its line', async () => {
  await fixture(async (root) => {
    const before = (await readFile(skill(root), 'utf8')).split('\n').length;
    await append(root, '\n```sh\necho first\n$ quiet-choir workflow list --json\n```\n');
    // The appended text starts on the file's last (empty) line; the command is three lines later.
    await assert.rejects(
      checkSkills(root, { compile: false }),
      new RegExp(`SKILL\\.md:${String(before + 3)}: shell fence invokes bare quiet-choir`, 'u'),
    );
  });
});
test('an installed-mode annotation permits bare quiet-choir in a shell fence', async () => {
  await fixture(async (root) => {
    await append(
      root,
      '\n<!-- skills-check: installed-mode -->\n```sh\nquiet-choir workflow list --json\n```\n',
    );
    await checkSkills(root, { compile: false });
  });
});
test('bare quiet-choir outside a shell fence, or as a later word, is not a launcher', async () => {
  await fixture(async (root) => {
    await append(
      root,
      '\n```text\nquiet-choir workflow list\n```\n\n```sh\nnode "$QC_CHECKOUT/bin/run.js" workflow list # quiet-choir\nquiet-choirs\n```\n',
    );
    await checkSkills(root, { compile: false });
  });
});
test('an unknown skills-check annotation is still rejected', async () => {
  await fixture(async (root) => {
    await append(
      root,
      '\n<!-- skills-check: installed -->\n```sh\nquiet-choir workflow list\n```\n',
      false,
    );
    await assert.rejects(
      checkSkills(root, { compile: false }),
      /invalid example\/fragment annotation/u,
    );
  });
});
test('frontmatter YAML is validated, including duplicate fields', async () => {
  await fixture(async (root) => {
    const file = skill(root);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'name: quiet-choir',
        'name: quiet-choir\nname: duplicate',
      ),
    );
    await assert.rejects(checkSkills(root, { compile: false }), /invalid YAML/u);
  });
});
const command = (root) => join(root, packages[1], 'commands/run.md');
async function editCommand(root, transform) {
  const file = command(root);
  await writeFile(file, transform(await readFile(file, 'utf8')));
}
for (const [label, transform, expected] of [
  [
    'a command without a description',
    (text) => text.replace(/^description: >-\n(?: {2}.*\n)+/mu, ''),
    /run\.md: invalid command frontmatter/u,
  ],
  [
    'an unknown command frontmatter key',
    (text) => text.replace('argument-hint:', 'model: haiku\nargument-hint:'),
    /run\.md: invalid command frontmatter/u,
  ],
  [
    'a duplicate command frontmatter key',
    (text) => text.replace('argument-hint:', 'argument-hint: ID\nargument-hint:'),
    /run\.md: invalid YAML/u,
  ],
  [
    'a dangling command link',
    (text) => `${text}\n[missing](../skills/quiet-choir/references/missing.md)\n`,
    /run\.md: dangling link/u,
  ],
  [
    'a command link escaping the package',
    (text) => `${text}\n[escape](../../../../AGENTS.md)\n`,
    /run\.md: link escapes package/u,
  ],
  [
    'a missing command link anchor',
    (text) => `${text}\n[missing](../skills/quiet-choir/SKILL.md#does-not-exist)\n`,
    /run\.md: missing link anchor/u,
  ],
  ['an unclosed command fence', (text) => `${text}\n\`\`\`sh\necho open\n`, /unclosed code fence/u],
  [
    'a duplicate command example ID',
    (text) =>
      `${text}\n<!-- skills-check: example run-launch -->\n\n\`\`\`sh\necho again\n\`\`\`\n`,
    /duplicate example run-launch/u,
  ],
  [
    'a bare quiet-choir in a command shell fence',
    (text) => `${text}\n\`\`\`sh\nquiet-choir workflow list --json\n\`\`\`\n`,
    /run\.md:\d+: shell fence invokes bare quiet-choir/u,
  ],
  [
    '$ARGUMENTS in a command shell fence',
    (text) => `${text}\n\`\`\`sh\necho "$ARGUMENTS"\n\`\`\`\n`,
    /run\.md:\d+: command fence uses \$ARGUMENTS/u,
  ],
  [
    'a positional $1 in a command shell fence',
    (text) => `${text}\n\`\`\`sh\necho "$1"\n\`\`\`\n`,
    /run\.md:\d+: command fence uses \$ARGUMENTS or a positional/u,
  ],
  [
    'pre-execution syntax in command prose',
    (text) => `${text}\nToday is !\`date\`.\n`,
    /run\.md:\d+: Claude Code runs !`\.\.\.` at load time/u,
  ],
  [
    'pre-execution syntax in a command shell fence',
    (text) => `${text}\n\`\`\`sh\necho !\`date\`\n\`\`\`\n`,
    /run\.md:\d+: Claude Code runs !`/u,
  ],
  [
    'pre-execution syntax in command inline code',
    (text) => `${text}\nRun \`!\`date\`\` here.\n`,
    /run\.md:\d+: Claude Code runs !`/u,
  ],
  [
    'pre-execution syntax in a command HTML comment',
    (text) => `${text}\n<!-- !\`date\` -->\n`,
    /run\.md:\d+: Claude Code runs !`/u,
  ],
  [
    'a command fence whose info string starts with !',
    (text) => `${text}\n\`\`\`!\ndate\n\`\`\`\n`,
    /run\.md:\d+: Claude Code runs a fence whose info string starts with !/u,
  ],
  [
    'a command fence with ! nested inside a longer fence',
    (text) => `${text}\n~~~~text\n\`\`\`!\ndate\n\`\`\`\n~~~~\n`,
    /run\.md:\d+: Claude Code runs a fence whose info string starts with !/u,
  ],
  [
    'an indented command fence whose info string starts with !',
    (text) => `${text}\n    \`\`\`!\n    date\n    \`\`\`\n`,
    /run\.md:\d+: Claude Code runs a fence whose info string starts with !/u,
  ],
  [
    'a command fence marker after other text in an HTML comment',
    (text) => `${text}\n<!-- \`\`\`!printf preexecution\`\`\` -->\n`,
    /run\.md:\d+: Claude Code runs a fence whose info string starts with !/u,
  ],
  [
    'a command fence marker after other text in prose',
    (text) => `${text}\nsee \`\`\`!date\`\`\` here\n`,
    /run\.md:\d+: Claude Code runs a fence whose info string starts with !/u,
  ],
])
  test(`rejects ${label}`, async () => {
    await fixture(async (root) => {
      await editCommand(root, transform);
      await assert.rejects(checkSkills(root, { compile: false }), expected);
    });
  });
test('pre-execution syntax in a command is rejected at its line', async () => {
  await fixture(async (root) => {
    const before = (await readFile(command(root), 'utf8')).split('\n').length;
    await editCommand(root, (text) => `${text}\nfirst\nToday is !\`date\`.\n`);
    // The appended text starts on the file's last (empty) line; the span is two lines later.
    await assert.rejects(
      checkSkills(root, { compile: false }),
      new RegExp(`run\\.md:${String(before + 2)}: Claude Code runs !`, 'u'),
    );
  });
});
test('pre-execution syntax in SKILL.md is rejected at its line', async () => {
  await fixture(async (root) => {
    const before = (await readFile(skill(root), 'utf8')).split('\n').length;
    await append(root, '\nfirst\nToday is !`date`.\n');
    await assert.rejects(
      checkSkills(root, { compile: false }),
      new RegExp(`SKILL\\.md:${String(before + 2)}: Claude Code runs !`, 'u'),
    );
  });
});
test('shell negation and a lone backtick are not pre-execution syntax', async () => {
  await fixture(async (root) => {
    const text =
      '\nUse ! to negate, `code`, or a lone ` backtick.\n\n```sh\nif ! true; then echo `date`; fi\n```\n';
    await editCommand(root, (body) => body + text);
    await append(root, text);
    await checkSkills(root, { compile: false });
  });
});
test('a broken TypeScript example in a command is rejected at its line', async () => {
  await fixture(async (root) => {
    await editCommand(
      root,
      (text) => `${text}\n\`\`\`ts\nexport const broken: number = "x";\n\`\`\`\n`,
    );
    await assert.rejects(checkSkills(root), /run\.md:\d+: TS2322/u);
  });
});
test('a non-Markdown file under commands is rejected', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, packages[1], 'commands/run.sh'), 'echo hi\n');
    await assert.rejects(checkSkills(root, { compile: false }), /commands must be Markdown files/u);
  });
});
test('commands are counted, and the manifests may differ only in description', async () => {
  await fixture(async (root) => {
    const summary = await checkSkills(root, { compile: false });
    assert.equal(summary.commands, 1);
    const portable = join(root, packages[0], 'plugin.json');
    const claude = join(root, packages[1], '.claude-plugin/plugin.json');
    const portableData = JSON.parse(await readFile(portable, 'utf8'));
    const claudeData = JSON.parse(await readFile(claude, 'utf8'));
    assert.notEqual(portableData.description, claudeData.description);
    claudeData.version = '0.0.1';
    await writeFile(claude, JSON.stringify(claudeData));
    await assert.rejects(
      checkSkills(root, { compile: false }),
      /manifest metadata differs: version/u,
    );
  });
});
test('package roots cannot be symlinks to the other deliverable', async () => {
  await fixture(async (root) => {
    const directory = join(root, packages[0]);
    await rm(directory, { recursive: true });
    await symlink(join(root, packages[1]), directory, 'dir');
    await assert.rejects(checkSkills(root, { compile: false }), /must be physical/u);
  });
});
test('explicit fragments are counted while complete examples remain checked', async () => {
  await fixture(async (root) => {
    await append(
      root,
      '\n<!-- skills-check: fragment; reason: Property inside a larger options object. -->\n```ts\nonEvent: event => event\n```\n',
    );
    const result = await checkSkills(root, { compile: false });
    assert.ok(result.fragments >= 2);
    assert.ok(result.examples >= 10);
  });
});
test("href text inside another attribute's quoted value is not treated as a link destination", async () => {
  await fixture(async (root) => {
    await append(root, '\n<a title="see href=references/missing.md">text</a>\n');
    await checkSkills(root, { compile: false });
  });
});
test('Markdown parser handles longer fences, language aliases, and duplicate heading anchors', () => {
  const text = '# A `title`\n\n# A `title`\n\n````typescript\nconst text = "```";\n````\n';
  assert.deepEqual([...anchors(text)], ['a-title', 'a-title-1']);
  assert.equal(fences(text)[0].language, 'typescript');
  assert.equal(fences(text)[0].code, 'const text = "```";');
  assert.throws(() => fences('```ts\nunfinished'), /unclosed code fence/u);
});
test('comment and tag stripping is not defeated by nesting', () => {
  // A single non-recursive pass would remove only the inner `<!-- -->` and leave the outer
  // markers as a still-live comment; stripping to a fixed point removes both.
  assert.equal(prose('a<!--<!-- -->b-->c'), 'ab-->c');
  assert.deepEqual([...anchors('# x<scr<script>y</script>z')], ['xyz']);
});
test('inline link destinations honor balanced and escaped parentheses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qc-skill-links-'));
  try {
    const pkg = join(root, 'pkg'),
      file = join(pkg, 'SKILL.md');
    await mkdir(join(pkg, 'safe(x)'), { recursive: true });
    await mkdir(join(pkg, 'dir(1)'), { recursive: true });
    // Decoy that a destination truncated at its first `)` would resolve to.
    await writeFile(join(pkg, 'safe(x'), '');
    await writeFile(join(pkg, 'dir(1)/file.md'), '# Title\n');
    await writeFile(join(pkg, 'a)b.md'), '');
    await writeFile(join(root, 'outside.md'), '');
    const check = (text) => checkLinks(file, `# Skill\n\n${text}\n`, pkg);
    await assert.rejects(check('[x](safe(x)/../../outside.md)'), /link escapes package/u);
    assert.equal(await check('[x](dir(1)/file.md#title "Title")'), 1);
    assert.equal(await check('[x](a\\)b.md)'), 1);
    await rm(join(pkg, 'a)b.md'));
    await assert.rejects(check('[x](a\\)b.md)'), /dangling link: a\)b\.md/u);
    await assert.rejects(check('[x](safe(x/../../outside.md "title")'), /unbalanced parentheses/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rejects stale cookbook code even when both distributed copies agree', async () => {
  await fixture(async (root) => {
    for (const pkg of packages) {
      const file = join(root, pkg, 'skills/quiet-choir/references/patterns.md');
      await writeFile(
        file,
        (await readFile(file, 'utf8')).replace(
          "name: 'cross-harness'",
          "name: 'stale-documentation'",
        ),
      );
    }
    await assert.rejects(
      checkSkills(root, { compile: false }),
      /pattern example pattern-cross-harness differs from/u,
    );
  });
});
test('rejects a patterns.md index that omits a recipe section, even one linked from the intro', async () => {
  await fixture(async (root) => {
    for (const pkg of packages) {
      const file = join(root, pkg, 'skills/quiet-choir/references/patterns.md');
      const text = await readFile(file, 'utf8');
      const row = /^\| Test before native calls .*\(#rehearse-for-free\) +\|\n/mu;
      assert.match(text, row);
      assert.ok(text.includes('(#rehearse-for-free)'));
      await writeFile(file, text.replace(row, ''));
    }
    await assert.rejects(
      checkSkills(root, { compile: false }),
      /patterns index does not link recipe section "Rehearse for free" \(#rehearse-for-free\)/u,
    );
  });
});

const docsUrl = 'https://github.com/plx/quiet-choir/blob/main/docs/github.md#waits';
test('a link into the repository docs tree is rejected in references, SKILL.md and commands', async () => {
  const links = [
    `[waits](${docsUrl})`,
    `[waits][docs]\n\n[docs]: ${docsUrl}`,
    `<a href="https://github.com/plx/quiet-choir/tree/main/docs">docs</a>`,
  ];
  for (const link of links)
    await fixture(async (root) => {
      const reference = join(root, packages[0], 'skills/quiet-choir/references/extensions.md');
      await writeFile(reference, `${await readFile(reference, 'utf8')}\n${link}\n`);
      await assert.rejects(
        checkSkills(root, { compile: false }),
        /extensions\.md: link into the repository's docs\/ tree.*bundle a skill-relative reference/u,
      );
    });
  await fixture(async (root) => {
    const command = join(root, packages[1], 'commands/run.md');
    await writeFile(command, `${await readFile(command, 'utf8')}\n[waits](${docsUrl})\n`);
    await assert.rejects(
      checkSkills(root, { compile: false }),
      /run\.md: link into the repository's docs\/ tree/u,
    );
  });
});
test('links outside the docs tree and docs links in code are not rejected', async () => {
  await fixture(async (root) => {
    await append(
      root,
      [
        '',
        '[example](https://github.com/plx/quiet-choir/blob/main/examples/patterns/next-ticket.workflow.ts)',
        '[other](https://github.com/plx/quiet-choir/blob/main/src/docs/index.ts)',
        `Inline code \`${docsUrl}\` is prose, not a link.`,
        '',
      ].join('\n'),
    );
    await checkSkills(root, { compile: false });
  });
});

/** The ts fence that follows the heading `# title`, the way a reader finds the example. */
function fenceAfter(text, file, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `${file}: missing heading ${heading}`);
  const found = fences(text, file).find(
    (fence) => fence.start > start && ['ts', 'typescript'].includes(fence.language),
  );
  assert.ok(found, `${file}: no ts fence after ${heading}`);
  return found;
}
test('the bundled GitHub reference keeps its anchors and the docs write, gate and land examples', async () => {
  const docs = await readFile(join(repository, 'docs/github.md'), 'utf8');
  for (const pkg of packages) {
    const file = join(repository, pkg, 'skills/quiet-choir/references/github.md');
    const bundled = await readFile(file, 'utf8');
    for (const anchor of ['waits', 'writes', 'merging', 'epics', 'gate-example', 'land-example'])
      assert.ok(anchors(bundled).has(anchor), `${file}: missing #${anchor}`);
    for (const heading of ['### Write example', '## Gate example', '## Land example'])
      assert.equal(
        fenceAfter(bundled, file, heading).code,
        fenceAfter(docs, 'docs/github.md', heading).code,
        `${file}: ${heading} differs from docs/github.md`,
      );
  }
});
test('a drifted bundled GitHub example is caught by the fence comparison', async () => {
  const docs = await readFile(join(repository, 'docs/github.md'), 'utf8');
  const file = join(repository, packages[0], 'skills/quiet-choir/references/github.md');
  const drifted = (await readFile(file, 'utf8')).replace("name: 'gate'", "name: 'drifted'");
  assert.notEqual(
    fenceAfter(drifted, file, '## Gate example').code,
    fenceAfter(docs, 'docs/github.md', '## Gate example').code,
  );
});
