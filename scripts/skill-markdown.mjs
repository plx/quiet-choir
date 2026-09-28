import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Extract fenced examples without executing Markdown or treating nested code as links. */
export function fences(text, file = 'Markdown') {
  const lines = text.split('\n');
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(lines[index]);
    if (!opening) continue;
    const start = index;
    const language = opening[2].trim().split(/\s+/u)[0];
    const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`, 'u');
    let previous = start - 1;
    while (previous >= 0 && !lines[previous].trim()) previous--;
    const annotation = lines[previous] ?? '';
    const fragment = /^\s*<!-- skills-check: fragment; reason: (.+) -->\s*$/u.exec(annotation);
    const example = /^\s*<!-- skills-check: example ([a-z0-9-]+) -->\s*$/u.exec(annotation);
    if (
      (annotation.includes('skills-check:') && !fragment && !example) ||
      (fragment && !fragment[1].trim())
    )
      throw new Error(`${file}:${String(previous + 1)}: invalid example/fragment annotation`);
    while (++index < lines.length && !closing.test(lines[index])) {
      /* Find matching delimiter. */
    }
    if (index === lines.length)
      throw new Error(`${file}:${String(start + 1)}: unclosed code fence`);
    const id = example?.[1];
    if (id && result.some((fence) => fence.id === id))
      throw new Error(`${file}:${String(start + 1)}: duplicate example ${id}`);
    result.push({
      language,
      code: lines.slice(start + 1, index).join('\n'),
      line: start + 2,
      start,
      end: index,
      fragment: fragment?.[1],
      id,
    });
  }
  return result;
}

/**
 * Apply a stripping regex to a fixed point so that characters exposed by one pass (e.g. the
 * `<!--` left behind by removing an inner `<!-<!---->->` comment) cannot survive as a still-live
 * sequence; a single non-recursive pass is an incomplete sanitization.
 */
function stripToFixedPoint(text, pattern) {
  let previous;
  do {
    previous = text;
    text = text.replace(pattern, '');
  } while (text !== previous);
  return text;
}

export function prose(text, file) {
  const lines = text.split('\n');
  for (const fence of fences(text, file))
    for (let index = fence.start; index <= fence.end; index++) lines[index] = '';
  return stripToFixedPoint(lines.join('\n'), /<!--[^]*?-->/gu);
}

/** GitHub-style anchors for the headings used by the distributed references. */
export function anchors(text) {
  const result = new Set();
  const body = prose(text);
  for (const match of body.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)) {
    const base = stripToFixedPoint(match[1].toLowerCase(), /<[^>]*>/gu)
      .replace(/[^\p{L}\p{N}_ -]/gu, '')
      .replace(/ /gu, '-');
    let slug = base;
    for (let count = 1; result.has(slug); count++) slug = `${base}-${String(count)}`;
    result.add(slug);
  }
  for (const match of body.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu))
    result.add(match[1] ?? match[2] ?? match[3]);
  return result;
}

export function inside(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Verify relative destinations and fragments within the physical installed package. */
export async function checkLinks(file, text, packageRoot) {
  const body = prose(text, file);
  const definitions = new Map();
  const destinations = [];
  const key = (value) => value.trim().toLowerCase().replace(/\s+/gu, ' ');
  for (const match of body.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gmu)) {
    definitions.set(key(match[1]), match[2] ?? match[3]);
    destinations.push(match[2] ?? match[3]);
  }
  for (const match of body.matchAll(
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^]*?["'])?\s*\)/gu,
  ))
    destinations.push(match[1] ?? match[2]);
  for (const match of body.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/gu)) {
    const name = key(match[2] || match[1]);
    if (!definitions.has(name)) throw new Error(`${file}: unresolved reference link [${name}]`);
    destinations.push(definitions.get(name));
  }
  for (const match of body.matchAll(/\[([^\]]+)\](?![([])/gu))
    if (definitions.has(key(match[1]))) destinations.push(definitions.get(key(match[1])));
  for (const match of body.matchAll(
    /<(?:a|img)\b(?:[^>"']|"[^"]*"|'[^']*')*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))(?:[^>"']|"[^"]*"|'[^']*')*>/giu,
  ))
    destinations.push(match[1] ?? match[2] ?? match[3]);
  const root = await realpath(packageRoot);
  for (const destination of new Set(destinations)) {
    if (/^(?:https?:|mailto:)/iu.test(destination)) {
      new URL(destination);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(destination))
      throw new Error(`${file}: unsupported link protocol: ${destination}`);
    const [pathAndQuery, fragment] = destination.split('#');
    const path = decodeURIComponent(pathAndQuery.split('?')[0]);
    const target = path ? resolve(dirname(file), path) : file;
    if (!inside(resolve(packageRoot), target))
      throw new Error(`${file}: link escapes package: ${destination}`);
    let actual;
    try {
      actual = await realpath(target);
    } catch (error) {
      throw new Error(`${file}: dangling link: ${destination}`, { cause: error });
    }
    if (!inside(root, actual))
      throw new Error(`${file}: link resolves outside package: ${destination}`);
    if (fragment && extname(actual) === '.md' && (await stat(actual)).isFile()) {
      const targetText = actual === file ? text : await readFile(actual, 'utf8');
      if (!anchors(targetText).has(decodeURIComponent(fragment)))
        throw new Error(`${file}: missing link anchor: ${destination}`);
    }
  }
  return destinations.length;
}
