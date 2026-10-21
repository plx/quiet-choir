import { brandError, isBranded } from '../runtime/error-brand.js';

/** Details of a {@link PromptError}. */
export interface PromptErrorDetails {
  /** The prompt's name in its `definePrompts` index, or null for an error in the index itself. */
  readonly prompt: string | null;
  /** The template file, relative to the prompt root, or null when no file is involved. */
  readonly file: string | null;
  /**
   * What failed: a MiniJinja error kind passed through (`SyntaxError`, `UndefinedError`,
   * `TemplateNotFound`, `OutOfFuel`, `UnknownFilter`, `UnknownFunction`, ...), or one of
   * `InvalidDefinition` (a `definePrompts` argument), `InvalidParams` (the parameters failed their
   * schema), `InvalidFrontMatter` or `TemplateRefused` (a template path outside the root).
   */
  readonly kind: string;
  /** The 1-based line of the error in `file`, when the engine reports one. */
  readonly line: number | null;
}

/**
 * An authoring error in a prompt template, its parameters or its `definePrompts` index (ADR 0064).
 * It is fatal: thrown inside a workflow body or a settled map's mapper, it fails the run and is
 * never saved as a settled outcome. Its message starts with `Prompt <Name> (<file>)`.
 */
export class PromptError extends Error {
  static {
    brandError(this, 'PromptError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is PromptError {
    return isBranded(this, value);
  }

  /** The prompt's name, or null for an error in the index itself. */
  public readonly prompt: string | null;
  /** The template file relative to the prompt root, or null. */
  public readonly file: string | null;
  /** What failed; see {@link PromptErrorDetails.kind}. */
  public readonly kind: string;
  /** The 1-based line of the error in `file`, or null. */
  public readonly line: number | null;

  /** Construct a prompt error; `message` is the full text, conventionally `Prompt <Name> (<file>): ...`. */
  public constructor(message: string, details: PromptErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PromptError';
    this.prompt = details.prompt;
    this.file = details.file;
    this.kind = details.kind;
    this.line = details.line;
  }
}

/** The `Prompt <Name> (<file>)` prefix shared by every prompt error and check message. @internal */
export function promptLabel(prompt: string | null, file: string | null): string {
  if (prompt === null) return file === null ? 'Prompt index' : `Prompt index (${file})`;
  return file === null ? `Prompt ${prompt}` : `Prompt ${prompt} (${file})`;
}
