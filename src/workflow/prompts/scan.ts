// ADR 0064 sections 1 and 3: a conservative syntactic scan of a template's tags. It finds the
// include, extends, import and from targets, which must each be one string literal, and the
// nondeterministic built-ins, which no template may name. It looks only inside `{{ }}` and `{% %}`
// tags, after skipping `{# #}` comments and `{% raw %}` blocks, so prose that mentions them is
// fine; MiniJinja's own parser decides everything else.

/** A template dependency written as a single string literal. @internal */
export interface TemplateDependency {
  /** The tag keyword. */
  readonly keyword: 'include' | 'extends' | 'import' | 'from';
  /** The literal target, its escapes decoded as MiniJinja decodes them. */
  readonly target: string;
  /** 1-based line of the tag. */
  readonly line: number;
}

/** A construct the checks refuse. @internal */
export interface ScanProblem {
  /** 1-based line of the tag. */
  readonly line: number;
  /** What is wrong, quoting the tag. */
  readonly message: string;
}

/** The scan of one template source. @internal */
export interface TemplateScan {
  /** Literal dependency targets in source order. */
  readonly dependencies: readonly TemplateDependency[];
  /** Refused constructs in source order. */
  readonly problems: readonly ScanProblem[];
}

interface Tag {
  readonly kind: 'variable' | 'block';
  /** Interior without delimiters, whitespace markers or surrounding space. */
  readonly body: string;
  readonly line: number;
}

type Token =
  /** `value` is the literal's body as written, between its quotes; `raw` includes the quotes. */
  | { readonly kind: 'string'; readonly value: string; readonly raw: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'other'; readonly value: string };

/** The index just past the string literal opening at `start`, or the source length. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index++;
    else if (source[index] === quote) return index + 1;
  }
  return source.length;
}

/** The tags of a template, skipping comments and raw blocks. */
function tags(source: string): Tag[] {
  const found: Tag[] = [];
  let line = 1;
  let counted = 0;
  const lineAt = (index: number): number => {
    for (; counted < index; counted++) if (source[counted] === '\n') line++;
    return line;
  };
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('{', index);
    if (start < 0 || start + 1 >= source.length) break;
    const opener = source[start + 1];
    if (opener === '#') {
      const end = source.indexOf('#}', start + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    if (opener !== '{' && opener !== '%') {
      index = start + 1;
      continue;
    }
    const closer = opener === '{' ? '}}' : '%}';
    let cursor = start + 2;
    while (cursor < source.length && !source.startsWith(closer, cursor))
      cursor =
        source[cursor] === '"' || source[cursor] === "'" ? stringEnd(source, cursor) : cursor + 1;
    if (cursor >= source.length) break;
    const body = source
      .slice(start + 2, cursor)
      .replace(/^[-+]/u, '')
      .replace(/[-+]$/u, '')
      .trim();
    const tagLine = lineAt(start);
    index = cursor + 2;
    if (opener === '%' && /^raw\b/u.test(body)) {
      const endraw = /\{%[-+]?\s*endraw\s*[-+]?%\}/gu;
      endraw.lastIndex = index;
      const match = endraw.exec(source);
      if (!match) break;
      index = match.index + match[0].length;
      continue;
    }
    found.push({ kind: opener === '{' ? 'variable' : 'block', body, line: tagLine });
  }
  return found;
}

/** Tokens of a tag body: string literals, names and single other characters. */
function tokens(body: string): Token[] {
  const result: Token[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? '';
    if (/\s/u.test(char)) {
      index++;
    } else if (char === '"' || char === "'") {
      const end = stringEnd(body, index);
      result.push({
        kind: 'string',
        value: body.slice(index + 1, Math.max(index + 1, end - 1)),
        raw: body.slice(index, end),
      });
      index = end;
    } else if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(body.slice(index));
      const value = match?.[0] ?? char;
      result.push({ kind: 'name', value });
      index += value.length;
    } else {
      result.push({ kind: 'other', value: char });
      index++;
    }
  }
  return result;
}

const simpleEscapes: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Decode a string literal's body (between its quotes) with MiniJinja's escape rules, or return null
 * for a malformed escape, which MiniJinja refuses too: `\"`, `\'`, `\\`, `\/`, `\b`, `\f`, `\n`,
 * `\r` and `\t`; `\x` with exactly two hex digits; one to three octal digits up to `\377`; and
 * `\u` with exactly four hex digits, a high surrogate paired with a following `\u` low one. A
 * backslash before any other character is kept as written. @internal
 */
export function decodeStringLiteral(body: string): string | null {
  let result = '';
  let index = 0;
  const hex = (start: number, digits: number): number | null => {
    const text = body.slice(start, start + digits);
    return text.length === digits && /^[\dA-Fa-f]+$/u.test(text) ? Number.parseInt(text, 16) : null;
  };
  while (index < body.length) {
    const char = body[index] ?? '';
    if (char !== '\\') {
      result += char;
      index++;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) return null;
    const simple = simpleEscapes[next];
    if (simple !== undefined) {
      result += simple;
      index += 2;
    } else if (next === 'x') {
      const code = hex(index + 2, 2);
      if (code === null) return null;
      result += String.fromCharCode(code);
      index += 4;
    } else if (/[0-7]/u.test(next)) {
      const digits = /^[0-7]{1,3}/u.exec(body.slice(index + 1))?.[0] ?? next;
      const code = Number.parseInt(digits, 8);
      if (code > 0xff) return null;
      result += String.fromCharCode(code);
      index += 1 + digits.length;
    } else if (next === 'u') {
      const code = hex(index + 2, 4);
      if (code === null || (code >= 0xdc00 && code <= 0xdfff)) return null;
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = body.startsWith('\\u', index + 6) ? hex(index + 8, 4) : null;
        if (low === null || low < 0xdc00 || low > 0xdfff) return null;
        result += String.fromCharCode(code, low);
        index += 12;
      } else {
        result += String.fromCharCode(code);
        index += 6;
      }
    } else {
      result += `\\${next}`;
      index += 2;
    }
  }
  return result;
}

function isName(token: Token | undefined, value: string): boolean {
  return token?.kind === 'name' && token.value === value;
}

/** Whether `rest` is empty or exactly `with context` or `without context`. */
function contextClause(rest: readonly Token[]): boolean {
  return (
    rest.length === 0 ||
    (rest.length === 2 &&
      (isName(rest[0], 'with') || isName(rest[0], 'without')) &&
      isName(rest[1], 'context'))
  );
}

const dependencyKeywords: ReadonlySet<string> = new Set(['include', 'extends', 'import', 'from']);

/** The body with every string literal emptied, so quoted text cannot match a built-in name. */
function withoutStrings(body: string): string {
  let result = '';
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? '';
    if (char === '"' || char === "'") {
      result += `${char}${char}`;
      index = stringEnd(body, index);
    } else {
      result += char;
      index++;
    }
  }
  return result;
}

/** The nondeterministic built-ins of ADR 0064 section 1, removed from the environment. */
const nondeterministic: readonly (readonly [RegExp, string])[] = [
  [/[|]\s*random\b/u, 'uses the random filter'],
  [/^filter\s+random\b/u, 'uses the random filter'],
  [/\brandrange\b/u, 'names randrange'],
  [/\blipsum\b/u, 'names lipsum'],
];

/** Scan a template source (front matter already replaced) for its dependencies and refusals. @internal */
export function scanTemplate(source: string): TemplateScan {
  const dependencies: TemplateDependency[] = [];
  const problems: ScanProblem[] = [];
  for (const tag of tags(source)) {
    const shown = tag.kind === 'variable' ? `{{ ${tag.body} }}` : `{% ${tag.body} %}`;
    const code = withoutStrings(tag.body);
    for (const [pattern, what] of nondeterministic)
      if (pattern.test(code))
        problems.push({
          line: tag.line,
          message: `${shown} ${what}, a nondeterministic built-in that templates cannot use`,
        });
    if (tag.kind !== 'block') continue;
    const parts = tokens(tag.body);
    const keyword = parts[0]?.kind === 'name' ? parts[0].value : '';
    if (!dependencyKeywords.has(keyword)) continue;
    const target = parts[1];
    const rest = parts.slice(2);
    const refuse = (message: string): void => {
      problems.push({ line: tag.line, message: `${shown} ${message}` });
    };
    if (
      keyword === 'include' &&
      rest.some((token, at) => isName(token, 'ignore') && isName(rest[at + 1], 'missing'))
    ) {
      refuse(
        'uses ignore missing; every include target must exist under the prompt root, so drop the clause',
      );
      continue;
    }
    if (target?.kind !== 'string') {
      refuse(
        `has a computed or list target; ${keyword} takes exactly one string literal, such as {% ${keyword} "_fragments/part.md"${keyword === 'import' ? ' as part' : keyword === 'from' ? ' import name' : ''} %}`,
      );
      continue;
    }
    const valid =
      keyword === 'include'
        ? contextClause(rest)
        : keyword === 'extends'
          ? rest.length === 0
          : keyword === 'import'
            ? isName(rest[0], 'as') && rest[1]?.kind === 'name' && contextClause(rest.slice(2))
            : isName(rest[0], 'import');
    if (!valid) {
      refuse(`must have exactly one string literal target, with nothing computed after it`);
      continue;
    }
    const decoded = decodeStringLiteral(target.value);
    if (decoded === null) {
      refuse(`has a malformed escape in its target literal ${target.raw}`);
      continue;
    }
    dependencies.push({
      keyword: keyword as TemplateDependency['keyword'],
      target: decoded,
      line: tag.line,
    });
  }
  return { dependencies, problems };
}
