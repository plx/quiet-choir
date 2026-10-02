import ts from 'typescript';

import type { DurabilityFinding, DurabilityRule } from './model.js';

/*
 * Static durability lint (ADR 0041). Pure: it reads only the compiler program it is given and
 * returns plain data. The analysis is lexical and per function: receivers and APIs are resolved by
 * their declarations, never by name, and a shape it does not recognize yields no finding.
 */

const contextEffects = new Set([
  'step',
  'sleep',
  'sleepUntil',
  'now',
  'wait',
  'poll',
  'ask',
  'approve',
  'readFile',
  'writeFile',
  'workflow',
  'merge',
  'worktree',
  'map',
]);
const clientEffects = new Set(['value', 'text', 'object']);
const zoneProperties: Readonly<Record<string, ReadonlySet<string>>> = {
  StepDefinition: new Set(['run']),
  PollSource: new Set(['observe']),
  CommandPollSource: new Set(['done']),
  PollErrorPolicy: new Set(['classify', 'retryAfterMs']),
};
const iterationMethods = new Set([
  'map',
  'forEach',
  'flatMap',
  'filter',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'sort',
  'toSorted',
]);
const runtimeDirectory = '/workflow/runtime/';
const suppressionPattern =
  /^\s*\/\/\s*quiet-choir-ignore\s+(QC\d{3}(?:\s*,\s*QC\d{3})*)(?:\s+(.*))?$/;

/** A parsed `// quiet-choir-ignore QCnnn[, QCnnn] <reason>` line. @internal */
export interface DurabilitySuppression {
  readonly rules: readonly string[];
  /** Trimmed reason text; empty when the comment gives none. */
  readonly reason: string;
}

/** Parse one source line as a suppression comment; anything else is undefined. @internal */
export function parseDurabilitySuppression(line: string): DurabilitySuppression | undefined {
  const match = suppressionPattern.exec(line);
  if (!match?.[1]) return undefined;
  return {
    rules: match[1].split(',').map((rule) => rule.trim()),
    reason: (match[2] ?? '').trim(),
  };
}

function normalizedPath(fileName: string): string {
  return fileName.replaceAll('\\', '/');
}

function isRuntimeFile(fileName: string): boolean {
  const path = normalizedPath(fileName);
  const index = path.lastIndexOf(runtimeDirectory);
  if (index < 0) return false;
  const name = path.slice(index + runtimeDirectory.length);
  return !name.includes('/') && name.endsWith('.ts');
}

function isNodeTypes(fileName: string): boolean {
  return normalizedPath(fileName).includes('/@types/node/');
}

/** Name of the interface or type alias that declares a member, if any. */
function ownerName(declaration: ts.Node): string | undefined {
  for (let node = declaration.parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isModuleBlock(node) || ts.isBlock(node) || ts.isClassLike(node)) return undefined;
  }
  return undefined;
}

function memberName(declaration: ts.Declaration): string | undefined {
  if (ts.isCallSignatureDeclaration(declaration)) return '()';
  if (ts.isConstructSignatureDeclaration(declaration)) return 'new()';
  const name = ts.getNameOfDeclaration(declaration);
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

function hasFunctionBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

function skipParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  )
    current = current.expression;
  return current;
}

function terminates(statement: ts.Statement, loopExits = false): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (loopExits && (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)))
    return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && terminates(last, loopExits);
  }
  return false;
}

/** The direct child of `ancestor` on the path from `node`. */
function childOn(node: ts.Node, ancestor: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== ancestor) current = current.parent;
  return current;
}

/** Whether two occurrences, `first` before `second`, can never both run in one execution. */
function exclusive(first: ts.Node, second: ts.Node): boolean {
  const ancestors = new Set<ts.Node>();
  // A source file's parent is undefined at run time, although the declared type omits it.
  for (
    let node = first as ts.Node | undefined;
    node !== undefined;
    node = node.parent as ts.Node | undefined
  )
    ancestors.add(node);
  let common: ts.Node = second;
  while (!ancestors.has(common)) common = common.parent;
  if (common === first || common === second) return false;
  const left = childOn(first, common);
  const right = childOn(second, common);
  if (ts.isIfStatement(common))
    return (
      (left === common.thenStatement && right === common.elseStatement) ||
      (left === common.elseStatement && right === common.thenStatement)
    );
  if (ts.isConditionalExpression(common))
    return (
      (left === common.whenTrue && right === common.whenFalse) ||
      (left === common.whenFalse && right === common.whenTrue)
    );
  if (ts.isCaseBlock(common) && ts.isCaseOrDefaultClause(left)) {
    const last = left.statements.at(-1);
    return last !== undefined && terminates(last, true);
  }
  // An if branch that ends in return or throw versus code after that if.
  for (let node: ts.Node = first; node !== common; node = node.parent) {
    const parent = node.parent;
    if (
      ts.isIfStatement(parent) &&
      (node === parent.thenStatement || node === parent.elseStatement) &&
      terminates(node as ts.Statement)
    )
      return true;
  }
  return false;
}

interface CallInfo {
  readonly owner: string;
  readonly member: string;
  readonly declaration: ts.Declaration;
}

interface Occurrence {
  readonly id: string;
  readonly call: ts.CallExpression;
  readonly inLoop: boolean;
}

interface Namespace {
  readonly occurrences: Occurrence[];
}

interface State {
  /** Inside a workflow function or a function nested in one. */
  readonly workflow: boolean;
  /** The callback zone (StepDefinition.run, PollSource.observe, ...) the node is inside. */
  readonly zone: string | undefined;
  readonly namespace: Namespace | undefined;
  /** Inside a loop of the current ID namespace. */
  readonly loop: boolean;
  /** WorkflowContext parameters visible here: the root receivers of QC005. */
  readonly roots: ReadonlySet<ts.Symbol>;
}

interface RawFinding {
  readonly rule: DurabilityRule;
  readonly node: ts.Node;
  readonly message: string;
}

/** The quiet-choir source roots in a program: src/ or dist/ above the WorkflowContext model. */
function quietChoirRoots(program: ts.Program): string[] {
  const roots: string[] = [];
  for (const file of program.getSourceFiles()) {
    const path = normalizedPath(file.fileName);
    const marker = `${runtimeDirectory}model.`;
    const index = path.lastIndexOf(marker);
    if (index < 0 || !isRuntimeFile(path)) continue;
    if (
      file.statements.some(
        (statement) =>
          ts.isInterfaceDeclaration(statement) && statement.name.text === 'WorkflowContext',
      )
    )
      roots.push(`${path.slice(0, index)}/`);
  }
  return roots;
}

/**
 * The source files the lint inspects: every non-declaration file outside node_modules and outside
 * quiet-choir's own source tree. @internal
 */
export function durabilityLintFiles(program: ts.Program): ts.SourceFile[] {
  const roots = quietChoirRoots(program);
  return program.getSourceFiles().filter((file) => {
    const path = normalizedPath(file.fileName);
    return (
      !file.isDeclarationFile &&
      !path.includes('/node_modules/') &&
      !roots.some((root) => path.startsWith(root))
    );
  });
}

class DurabilityLinter {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #calls = new Map<ts.Node, CallInfo | undefined>();
  readonly #durable = new Map<ts.Node, boolean>();
  readonly #namespaces: Namespace[] = [];
  readonly #findings: RawFinding[] = [];

  public constructor(program: ts.Program) {
    this.#program = program;
    this.#checker = program.getTypeChecker();
  }

  public lint(file: ts.SourceFile): RawFinding[] {
    this.#namespaces.length = 0;
    this.#findings.length = 0;
    const state: State = {
      workflow: false,
      zone: undefined,
      namespace: undefined,
      loop: false,
      roots: new Set(),
    };
    ts.forEachChild(file, (child) => {
      this.#visit(child, state);
    });
    for (const namespace of this.#namespaces) this.#reportIds(namespace);
    return [...this.#findings];
  }

  #report(rule: DurabilityRule, node: ts.Node, message: string): void {
    this.#findings.push({ rule, node, message });
  }

  #isDefaultLibrary(declaration: ts.Node): boolean {
    return this.#program.isSourceFileDefaultLibrary(declaration.getSourceFile());
  }

  /** The declaration a call or `new` resolves to, when it is a member of a named type. */
  #resolve(node: ts.CallExpression | ts.NewExpression): CallInfo | undefined {
    if (this.#calls.has(node)) return this.#calls.get(node);
    let info: CallInfo | undefined;
    try {
      const declaration = this.#checker.getResolvedSignature(node)?.declaration;
      if (declaration && !ts.isJSDocSignature(declaration)) {
        const member = memberName(declaration);
        const owner =
          ts.isFunctionDeclaration(declaration) && member !== undefined
            ? ''
            : ownerName(declaration);
        if (member !== undefined && owner !== undefined) info = { owner, member, declaration };
      }
    } catch {
      info = undefined;
    }
    this.#calls.set(node, info);
    return info;
  }

  /** A quiet-choir call: a member of a runtime context, client or exec type. */
  #quietChoir(node: ts.CallExpression): CallInfo | undefined {
    const info = this.#resolve(node);
    return info && isRuntimeFile(info.declaration.getSourceFile().fileName) ? info : undefined;
  }

  /** Whether a call is a durable effect (checkpointed under an ID). */
  #isEffect(node: ts.CallExpression): boolean {
    const info = this.#quietChoir(node);
    if (!info) return false;
    switch (info.owner) {
      case 'WorkflowContext': {
        return contextEffects.has(info.member);
      }
      case 'ExecFunction': {
        return info.member === '()' || info.member === 'json';
      }
      case 'AgentClient':
      case 'RegisteredAgentClient': {
        return clientEffects.has(info.member);
      }
      default: {
        return false;
      }
    }
  }

  #contextMember(node: ts.CallExpression, member: string): CallInfo | undefined {
    const info = this.#quietChoir(node);
    return info?.owner === 'WorkflowContext' && info.member === member ? info : undefined;
  }

  #isWorkflowContext(node: ts.Node): boolean {
    try {
      return this.#isContextType(this.#checker.getTypeAtLocation(node), new Set());
    } catch {
      return false;
    }
  }

  /**
   * Whether a type is the runtime WorkflowContext or a subtype of it: an interface or class that
   * extends it, or an intersection with it. Unions are not accepted, so `WorkflowContext |
   * undefined` is not a context.
   */
  #isContextType(type: ts.Type, visited: Set<ts.Type>): boolean {
    if (visited.has(type)) return false;
    visited.add(type);
    // A local `type Context = WorkflowContext` has its own aliasSymbol, but the type's symbol
    // still resolves to the interface, so accept either.
    if (
      [type.aliasSymbol, type.getSymbol()].some(
        (symbol) =>
          symbol?.getName() === 'WorkflowContext' &&
          (symbol.declarations ?? []).some(
            (declaration) =>
              ts.isInterfaceDeclaration(declaration) &&
              isRuntimeFile(declaration.getSourceFile().fileName),
          ),
      )
    )
      return true;
    if (type.isIntersection()) return type.types.some((part) => this.#isContextType(part, visited));
    if (type.isClassOrInterface())
      return this.#checker.getBaseTypes(type).some((base) => this.#isContextType(base, visited));
    return false;
  }

  /** The callback zone a function literal fills, from its property's contextual declaration. */
  #zone(fn: ts.FunctionLikeDeclaration): string | undefined {
    let property: ts.PropertyAssignment | ts.MethodDeclaration | undefined;
    if (ts.isMethodDeclaration(fn)) property = fn;
    else {
      let node: ts.Node = fn;
      while (
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isSatisfiesExpression(node.parent)
      )
        node = node.parent;
      if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node)
        property = node.parent;
    }
    if (!property || !ts.isObjectLiteralExpression(property.parent)) return undefined;
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return undefined;
    try {
      const type = this.#checker.getContextualType(property.parent);
      if (!type) return undefined;
      for (const candidate of type.isUnion() ? type.types : [type]) {
        const symbol = this.#checker.getPropertyOfType(candidate, name.text);
        for (const declaration of symbol?.declarations ?? []) {
          const owner = ownerName(declaration);
          if (
            owner !== undefined &&
            zoneProperties[owner]?.has(name.text) === true &&
            isRuntimeFile(declaration.getSourceFile().fileName)
          )
            return `${owner}.${name.text}`;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  #enterFunction(fn: ts.FunctionLikeDeclaration, state: State): State {
    const contexts = fn.parameters.filter((parameter) => this.#isWorkflowContext(parameter));
    if (contexts.length > 0) {
      const roots = new Set(state.roots);
      for (const parameter of contexts) {
        const symbol = this.#checker.getSymbolAtLocation(parameter.name);
        if (symbol) roots.add(symbol);
      }
      return this.#namespace({ workflow: true, zone: undefined, roots }, state);
    }
    const zone = this.#zone(fn);
    if (zone !== undefined) return { ...state, zone };
    const parent = fn.parent;
    if (ts.isCallExpression(parent)) {
      const index = parent.arguments.indexOf(fn as unknown as ts.Expression);
      if (index >= 0) {
        if (index === 1 && this.#contextMember(parent, 'scope')) return this.#namespace({}, state);
        const map = this.#contextMember(parent, 'map');
        if (map) {
          const named = mapIsNamed(map);
          if (named && index === 3) return this.#namespace({}, state);
          if (!named && index === 2) return { ...state, loop: true };
          return state;
        }
        if (this.#quietChoir(parent)) return state;
        // Only a standard-library iteration method or Array.from repeats its callback: a custom
        // method of the same name, or an unresolved (any-typed) receiver, is not a loop.
        const info = this.#resolve(parent);
        if (info && this.#isDefaultLibrary(info.declaration)) {
          // Every iteration method takes its per-item callback first; reduce's initial value and
          // map/forEach's thisArg are not repeated.
          if (iterationMethods.has(info.member) && index === 0) return { ...state, loop: true };
          if (info.owner === 'ArrayConstructor' && info.member === 'from' && index === 1)
            return { ...state, loop: true };
        }
      }
    }
    return state;
  }

  #namespace(changes: Partial<State>, state: State): State {
    const namespace: Namespace = { occurrences: [] };
    this.#namespaces.push(namespace);
    return { ...state, ...changes, namespace, loop: false };
  }

  #visit(node: ts.Node, state: State): void {
    if (hasFunctionBody(node)) {
      const inner = this.#enterFunction(node, state);
      ts.forEachChild(node, (child) => {
        this.#visit(child, inner);
      });
      return;
    }
    if (ts.isForStatement(node)) {
      if (node.initializer) this.#visit(node.initializer, state);
      const looped = { ...state, loop: true };
      if (node.condition) this.#visit(node.condition, looped);
      if (node.incrementor) this.#visit(node.incrementor, looped);
      this.#visit(node.statement, looped);
      return;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      this.#visit(node.initializer, state);
      this.#visit(node.expression, state);
      this.#visit(node.statement, { ...state, loop: true });
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const looped = { ...state, loop: true };
      ts.forEachChild(node, (child) => {
        this.#visit(child, looped);
      });
      return;
    }
    try {
      if (ts.isCallExpression(node)) this.#call(node, state);
      else if (ts.isNewExpression(node)) this.#new(node, state);
      else if (ts.isPropertyAccessExpression(node)) this.#property(node, state);
    } catch {
      /* An unexpected shape yields no finding. */
    }
    ts.forEachChild(node, (child) => {
      this.#visit(child, state);
    });
  }

  #label(node: ts.CallExpression, info: CallInfo): string {
    const text = node.expression.getText();
    return text.length <= 40 && !text.includes('\n') ? text : `.${info.member}`;
  }

  #call(node: ts.CallExpression, state: State): void {
    const info = this.#quietChoir(node);
    const nondeterministic =
      state.workflow && state.zone === undefined && this.#nondeterminism(node);
    if (nondeterministic) this.#reportNondeterminism(node, nondeterministic);
    this.#race(node);
    if (!info) return;
    const effect = this.#isEffect(node);
    const label = this.#label(node, info);
    if (
      (effect ||
        (info.owner === 'WorkflowContext' &&
          (info.member === 'scope' || (info.member === 'phase' && hasBody(info))))) &&
      discarded(node)
    )
      this.#report(
        'QC001',
        node,
        `${label}(...) is not awaited: the runtime drains it and fails the run if it rejects, but the workflow never observes its result and later code cannot depend on it; await it.`,
      );
    if (effect && state.zone !== undefined)
      this.#report(
        'QC003',
        node,
        `${label}(...) inside a ${state.zone} callback is a nested durable call, which the runtime rejects; use the callback's context.exec or move the call into the workflow body.`,
      );
    if (
      info.owner === 'WorkflowContext' &&
      info.member === 'map' &&
      ts.getJSDocDeprecatedTag(info.declaration) !== undefined
    )
      this.#report(
        'QC006',
        node,
        'The positional ctx.map(items, concurrency, mapper) form is deprecated and keeps legacy unscoped IDs; use the named form ctx.map(id, items, options, mapper).',
      );
    if (effect && state.namespace && state.zone === undefined) {
      const first = node.arguments[0];
      if (
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        this.#isRootReceiver(node, info, state)
      )
        state.namespace.occurrences.push({ id: first.text, call: node, inLoop: state.loop });
    }
  }

  #isRootReceiver(node: ts.CallExpression, info: CallInfo, state: State): boolean {
    const callee = skipParentheses(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    let receiver: ts.Expression | undefined = skipParentheses(callee.expression);
    if (info.owner === 'ExecFunction') {
      if (info.member === '()') {
        receiver = callee.name.text === 'exec' ? receiver : undefined;
      } else {
        receiver =
          ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'exec'
            ? skipParentheses(receiver.expression)
            : undefined;
      }
    } else if (info.owner === 'AgentClient' || info.owner === 'RegisteredAgentClient') {
      if (
        ts.isPropertyAccessExpression(receiver) &&
        (receiver.name.text === 'claude' || receiver.name.text === 'codex')
      )
        receiver = skipParentheses(receiver.expression);
      else if (
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'agent'
      )
        receiver = skipParentheses(receiver.expression.expression);
      else receiver = undefined;
    }
    if (!receiver || !ts.isIdentifier(receiver)) return false;
    const symbol = this.#checker.getSymbolAtLocation(receiver);
    return symbol !== undefined && state.roots.has(symbol);
  }

  #reportIds(namespace: Namespace): void {
    const { occurrences } = namespace;
    occurrences.forEach((occurrence, index) => {
      if (occurrence.inLoop) {
        this.#report(
          'QC005',
          occurrence.call,
          `Literal ID '${occurrence.id}' is inside a loop on the root context, so every iteration reuses it; derive it per item with ctx.id(...), or use ctx.within, ctx.scope or a named ctx.map.`,
        );
        return;
      }
      const earlier = occurrences
        .slice(0, index)
        .find(
          (candidate) =>
            candidate.id === occurrence.id && !exclusive(candidate.call, occurrence.call),
        );
      if (earlier) {
        const sourceFile = earlier.call.getSourceFile();
        const line =
          sourceFile.getLineAndCharacterOfPosition(earlier.call.getStart(sourceFile)).line + 1;
        this.#report(
          'QC005',
          occurrence.call,
          `Literal ID '${occurrence.id}' is already used at line ${String(line)} in this ID namespace; give each effect a unique ID, or use ctx.within or ctx.scope.`,
        );
      }
    });
  }

  #new(node: ts.NewExpression, state: State): void {
    if (!state.workflow || state.zone !== undefined) return;
    if ((node.arguments?.length ?? 0) > 0) return;
    const info = this.#resolve(node);
    if (
      info?.owner === 'DateConstructor' &&
      info.member === 'new()' &&
      this.#isDefaultLibrary(info.declaration)
    )
      this.#reportNondeterminism(node, { api: 'new Date()', use: 'ctx.now' });
  }

  #property(node: ts.PropertyAccessExpression, state: State): void {
    if (!state.workflow || state.zone !== undefined || node.name.text !== 'env') return;
    const symbol = this.#checker.getSymbolAtLocation(node.name);
    if (
      (symbol?.declarations ?? []).some(
        (declaration) =>
          ownerName(declaration) === 'Process' && isNodeTypes(declaration.getSourceFile().fileName),
      )
    )
      this.#reportNondeterminism(node, {
        api: 'process.env',
        use: 'workflow input or a ctx.step',
      });
  }

  #nondeterminism(node: ts.CallExpression): { api: string; use: string } | undefined {
    const info = this.#resolve(node);
    if (!info) return undefined;
    const file = info.declaration.getSourceFile().fileName;
    const library = this.#isDefaultLibrary(info.declaration);
    if (info.owner === 'DateConstructor' && library) {
      if (info.member === 'now') return { api: 'Date.now()', use: 'ctx.now' };
      if (info.member === '()' && node.arguments.length === 0)
        return { api: 'Date()', use: 'ctx.now' };
    }
    if (info.owner === 'Math' && info.member === 'random' && library)
      return { api: 'Math.random()', use: 'a ctx.step' };
    if (info.owner === 'Performance' && info.member === 'now' && (library || isNodeTypes(file)))
      return { api: 'performance.now()', use: 'ctx.now' };
    if (info.member === 'randomUUID' && (library || isNodeTypes(file)))
      return { api: 'crypto.randomUUID()', use: 'a ctx.step' };
    if (
      ts.isFunctionDeclaration(info.declaration) &&
      info.member.endsWith('Sync') &&
      normalizedPath(file).endsWith('/@types/node/fs.d.ts')
    )
      return { api: `${info.member}()`, use: 'ctx.readFile, ctx.exec or a ctx.step' };
    return undefined;
  }

  #reportNondeterminism(node: ts.Node, found: { api: string; use: string }): void {
    this.#report(
      'QC002',
      node,
      `${found.api} in the workflow body is not recorded, so a resume can read a different value and change control flow or step input; use ${found.use} instead.`,
    );
  }

  #race(node: ts.CallExpression): void {
    const callee = skipParentheses(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      (callee.name.text !== 'race' && callee.name.text !== 'any')
    )
      return;
    const info = this.#resolve(node);
    if (info?.owner !== 'PromiseConstructor' || !this.#isDefaultLibrary(info.declaration)) return;
    if (!node.arguments.some((argument) => this.#containsDurable(argument, new Set()))) return;
    this.#report(
      'QC004',
      node,
      `Promise.${callee.name.text} over durable calls picks a winner by completion order, which a resume can change; use ctx.wait for one durable choice among a signal, poll or deadline.`,
    );
  }

  #containsDurable(node: ts.Node, seen: Set<ts.Node>): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    const cached = this.#durable.get(node);
    if (cached !== undefined) return cached;
    let found = false;
    if (ts.isCallExpression(node) && this.#isEffect(node)) found = true;
    else if (ts.isIdentifier(node)) {
      const symbol = this.#checker.getSymbolAtLocation(node);
      found = (symbol?.declarations ?? []).some(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          this.#containsDurable(declaration.initializer, seen),
      );
    }
    if (!found)
      found =
        ts.forEachChild(node, (child) => (this.#containsDurable(child, seen) ? true : undefined)) ??
        false;
    this.#durable.set(node, found);
    return found;
  }
}

function mapIsNamed(info: CallInfo): boolean {
  const declaration = info.declaration as ts.SignatureDeclaration;
  const first = declaration.parameters[0];
  return first !== undefined && ts.isIdentifier(first.name) && first.name.text === 'id';
}

function hasBody(info: CallInfo): boolean {
  const declaration = info.declaration as ts.SignatureDeclaration;
  return declaration.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'body',
  );
}

/** Whether a call's promise is dropped: `void`ed or an expression statement, through then chains. */
function discarded(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent)) node = parent;
    else if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      ['then', 'catch', 'finally'].includes(parent.name.text) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    )
      node = parent.parent;
    else return ts.isVoidExpression(parent) || ts.isExpressionStatement(parent);
  }
}

function suppressed(file: ts.SourceFile, line: number, rule: DurabilityRule): boolean {
  if (line < 2) return false;
  const starts = file.getLineStarts();
  const start = starts[line - 2];
  const end = starts[line - 1];
  if (start === undefined || end === undefined) return false;
  const text = file.text.slice(start, end).replace(/\r?\n$/, '');
  return parseDurabilitySuppression(text)?.rules.includes(rule) === true;
}

/**
 * Lint every workflow source file of a type-checked program for replay hazards (QC001-QC006) and
 * return findings sorted by file, line, column and rule. A
 * `// quiet-choir-ignore QCnnn[, QCnnn] <reason>` line directly before a finding's line silences
 * the listed rules for findings that start on that line.
 */
export function lintDurability(program: ts.Program): DurabilityFinding[] {
  const linter = new DurabilityLinter(program);
  const findings = new Map<string, DurabilityFinding>();
  for (const file of durabilityLintFiles(program)) {
    for (const raw of linter.lint(file)) {
      const position = file.getLineAndCharacterOfPosition(raw.node.getStart(file));
      const line = position.line + 1;
      if (suppressed(file, line, raw.rule)) continue;
      const finding: DurabilityFinding = {
        rule: raw.rule,
        file: file.fileName,
        line,
        column: position.character + 1,
        message: raw.message,
      };
      findings.set(
        `${finding.file}\0${String(line)}\0${String(finding.column)}\0${finding.rule}`,
        finding,
      );
    }
  }
  return [...findings.values()].sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      a.column - b.column ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );
}
