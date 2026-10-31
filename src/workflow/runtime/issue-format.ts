/**
 * Structural view of one Zod issue, so the issues of another zod copy format the same way. Key and
 * element issues nest their causes under `issues`; a union lists each option's issues in `errors`.
 * @internal
 */
export interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly issues?: readonly IssueLike[];
  readonly errors?: readonly (readonly IssueLike[])[];
}

const identifier = /^[A-Za-z_$][\w$]*$/u;

/**
 * A path as `tickets[0].id`: indexes and symbols in plain brackets, and a key that is not an
 * identifier in JSON-quoted brackets.
 */
function pathText(path: readonly PropertyKey[]): string {
  let text = '';
  for (const part of path)
    if (typeof part !== 'string') text += `[${String(part)}]`;
    else if (identifier.test(part)) text += text === '' ? part : `.${part}`;
    else text += `[${JSON.stringify(part)}]`;
  return text;
}

function line(path: readonly PropertyKey[], message: string): string {
  const text = pathText(path);
  return text === '' ? message : `${text}: ${message}`;
}

function leaves(issues: readonly IssueLike[], prefix: readonly PropertyKey[]): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.issues !== undefined && issue.issues.length > 0) return leaves(issue.issues, path);
    const message = issue.message.replace(/\s*\n\s*/gu, ' ');
    if (issue.errors === undefined || issue.errors.length === 0) return [line(path, message)];
    const options = issue.errors.map(
      (option, index) => `option ${String(index + 1)}: ${leaves(option, path).join(', ')}`,
    );
    return [line(path, `${message} (${options.join('; ')})`)];
  });
}

/**
 * One `path: message` line per leaf Zod issue, joined with newlines; a root issue is its bare
 * message. Key and element issues are replaced by their nested causes under the parent's path, and
 * a union failure stays one line that lists each option's issues. Unlike `z.prettifyError`, which
 * prints only top-level issues, no nested message is dropped. @internal
 */
export function formatIssues(issues: readonly IssueLike[]): string {
  return leaves(issues, []).join('\n');
}
