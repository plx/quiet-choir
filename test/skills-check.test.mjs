import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkSkills, packages, repository } from '../scripts/check-skills.mjs';
import { anchors, fences, prose } from '../scripts/skill-markdown.mjs';

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
