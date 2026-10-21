import type { z } from 'zod';

import type { Prompt } from '../runtime/model.js';

// ADR 0064 section 2. Workflow code is imported through tsx with its own copy of quiet-choir
// (ADR 0028), so the runtime recognizes a Prompt and a prompt set by registry-symbol brands,
// never by `instanceof` on a local class. This module has no Node or engine dependency: the core
// imports it to turn a Prompt back into text.

/** Registry key of the brand on the prompt value prototype. @internal */
export const PROMPT_BRAND: unique symbol = Symbol.for('quiet-choir.prompt');

/** Registry key of a prompt set's plain-data descriptor. @internal */
export const PROMPT_SET: unique symbol = Symbol.for('quiet-choir.prompt-set');

/**
 * The pattern every prompt name matches: `definePrompts` refuses any other entry key, and the run
 * record accepts only such a name as a request summary's `promptTemplate`. @internal
 */
export const PROMPT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * A rendered prompt. A class instance rather than a plain object: bound agents keep class
 * instances as they are, while a plain object's symbol keys would be refused as non-JSON.
 */
class PromptValue implements Prompt {
  public readonly text: string;
  public readonly template: string;
  public readonly params: Readonly<Record<string, unknown>>;

  public constructor(text: string, template: string, params: Readonly<Record<string, unknown>>) {
    this.text = text;
    this.template = template;
    this.params = params;
    Object.freeze(this);
  }

  public toString(): string {
    return this.text;
  }
}
Object.defineProperty(PromptValue.prototype, PROMPT_BRAND, { value: true });
Object.freeze(PromptValue.prototype);

/** A new frozen {@link Prompt}. @internal */
export function createPrompt(
  text: string,
  template: string,
  params: Readonly<Record<string, unknown>>,
): Prompt {
  return new PromptValue(text, template, params);
}

/** Whether `value` is a Prompt made by any quiet-choir copy. @internal */
export function isPrompt(value: unknown): value is Prompt {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Reflect.get(value, PROMPT_BRAND) === true && typeof Reflect.get(value, 'text') === 'string'
  );
}

/** The keys whose Prompt values the runtime replaces with their text. */
const promptKeys = ['prompt', 'systemPrompt', 'appendSystemPrompt'] as const;

/**
 * `options` with a Prompt in `prompt`, `systemPrompt` or `appendSystemPrompt` replaced by its text
 * (ADR 0064 section 2), so everything downstream sees exactly the string a literal call would have
 * spelled. Only own data properties are read; a getter is left for the JSON boundary to refuse.
 * Options without a Prompt are returned as they are. @internal
 */
export function promptOptionsAsText<T extends object>(options: T): T {
  let copy: PropertyDescriptorMap | undefined;
  for (const key of promptKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor) || !isPrompt(descriptor.value))
      continue;
    copy ??= Object.getOwnPropertyDescriptors(options);
    copy[key] = { ...descriptor, value: descriptor.value.text };
  }
  if (copy === undefined) return options;
  return Object.create(Object.getPrototypeOf(options) as object | null, copy) as T;
}

/**
 * The template name of the Prompt in an agent call's `prompt` (ADR 0064 section 5), recorded as the
 * request summary's observational `promptTemplate`. Like {@link promptOptionsAsText}, only an own
 * data property is read. A string prompt, a Prompt only in `systemPrompt` or `appendSystemPrompt`,
 * and a Prompt whose template is not a prompt name (a forged value from another copy) give
 * undefined, so a malformed value can never fail the record's save. @internal
 */
export function promptTemplateOf(options: object): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'prompt');
  if (descriptor === undefined || !('value' in descriptor) || !isPrompt(descriptor.value))
    return undefined;
  const template: unknown = Reflect.get(descriptor.value, 'template');
  return typeof template === 'string' && PROMPT_NAME_PATTERN.test(template) ? template : undefined;
}

/** One entry of a prompt set's descriptor. @internal */
export interface PromptEntryDescriptor {
  /** Normalized root-relative template path. */
  readonly file: string;
  /** The entry's parameter schema, as declared. */
  readonly params: z.ZodObject;
  /** The entry's own description. */
  readonly description?: string;
}

/** The plain data a prompt set carries for the load-time checks. @internal */
export interface PromptSetDescriptor {
  /** Absolute template root. */
  readonly root: string;
  /** Entries by prompt name. */
  readonly entries: Readonly<Record<string, PromptEntryDescriptor>>;
}

/** The descriptor of a prompt set from any quiet-choir copy, or undefined. @internal */
export function promptSetDescriptor(value: unknown): PromptSetDescriptor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor: unknown = Reflect.get(value, PROMPT_SET);
  if (typeof descriptor !== 'object' || descriptor === null) return undefined;
  const root: unknown = Reflect.get(descriptor, 'root');
  const entries: unknown = Reflect.get(descriptor, 'entries');
  if (typeof root !== 'string' || typeof entries !== 'object' || entries === null) return undefined;
  return descriptor as PromptSetDescriptor;
}
