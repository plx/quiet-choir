// Capability manifests without the profile surface (#724, #726): the counterparts of the denial and
// limit diagnostics, redaction, grant digest, rooted-directory and strict call-site cases of the
// removed profile tests, written on roster entries, `defaults` and the default role. An entry pins one
// harness and resets the other blocks to the text baseline, so the old cross-harness profile is a
// Claude entry plus a Codex entry here. An entry's grant digest includes its harness pin, so it
// cannot equal a profile-era value: the golden digests are computed through `defaults` on the
// built-in text role, which takes the same merge path as a profile without extends, and must never
// move. Cases that check a checkpointed pin compare it with the live entry digest instead.
import { describe, expect, vi } from 'vitest';
import {
  claudeCapabilityKeys,
  codexCapabilityKeys,
  defineHarness,
  defineRoster,
  defineWorkflow,
  HarnessError,
  readRun,
  WorkflowRunError,
  z,
  type AgentDefaults,
  type Harness,
  type HarnessAdapter,
  type ProfileOverride,
} from '../src/index.js';
import { claudeDefinition, codexDefinition } from '../src/harnesses/builtins/definitions.js';
import { parseClaude } from '../src/harnesses/protocol.js';
import { digest } from '../src/workflow/runtime/json.js';
import {
  capabilityManifestSchema,
  parseProfileOverride,
  profileGrantDigest,
  publicCapabilityManifest,
  resolveCapabilities,
  resolveProfileCall,
  capabilityManifest,
} from '../src/workflow/runtime/profiles.js';
import { it } from './setup/state-dir.js';

const prompt = 'x';
const runId = 'capability-manifest';
const base = {
  name: 'capability-manifest',
  version: '1',
  input: z.null(),
  output: z.string(),
} as const;
const reply = {
  text: 'ok',
  sessionId: 'session',
  usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.31 },
};

/** A fake harness whose calls are counted; it answers `reply` unless told otherwise. */
function fake() {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  return { invoke, harness: { invoke } };
}

/** A resolved role by name; a missing one fails the test. */
const role = (manifest: ReturnType<typeof resolveCapabilities>, name: string) => {
  const resolved = manifest.profiles[name];
  if (!resolved) throw new Error(`Missing role ${name}.`);
  return resolved;
};

describe('denial and limit diagnostics', () => {
  it.for(['warn', 'fail'] as const)(
    'persists permission-denial diagnostics of an entry in %s mode',
    async (mode, { stateDir, runs }) => {
      const definition = defineWorkflow({
        ...base,
        roster: defineRoster({
          Scout: { harness: 'claude', tools: ['Read'], onPermissionDenied: mode },
        }),
        async run(ctx) {
          const result = await ctx.roster.Scout.text('ask', { prompt, onError: 'return' });
          return result.ok ? result.value.output : result.error.kind;
        },
      });
      const result = await runs.run(definition, {
        stateDir,
        runId,
        input: null,
        harness: { invoke: () => Promise.resolve({ ...reply, permissionDenials: 2 }) },
      });
      expect(result.output).toBe(mode === 'warn' ? 'ok' : 'permission');
      expect(result.steps['ask']?.warnings).toEqual([
        'Profile Scout: 2 permission denials reported.',
      ]);
      if (mode === 'fail')
        expect(result.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
    },
  );

  it('extracts counts without persisting permission-denial payloads or fabricating tool use', () => {
    const metadata = {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      num_turns: 5,
      permission_denials: [{ tool_name: 'Read', tool_input: { secret: 'private path' } }],
      total_cost_usd: 0.1,
    };
    const outcome = parseClaude(JSON.stringify(metadata), false);
    expect(outcome).toMatchObject({
      kind: 'success',
      response: { turns: 5, permissionDenials: 1 },
    });
    expect(JSON.stringify(outcome)).not.toContain('private path');
    expect(
      parseClaude(
        JSON.stringify({ ...metadata, subtype: 'error_max_turns', is_error: true }),
        false,
      ),
    ).toMatchObject({ kind: 'failure', failure: { turns: 5, permissionDenials: 1 } });
  });

  it('preserves adapter error objects and explains a step-policy cap that wins over a role', async ({
    stateDir,
    runs,
  }) => {
    const error = new HarnessError({
      harness: 'claude',
      kind: 'turn-limit',
      exit: { code: 1, signal: null },
      failure: null,
      reason: 'cap',
      stderr: '',
      stdout: '',
    });
    const original = error.message;
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (await ctx.claude.text('ask', { prompt })).output;
      },
    });
    await expect(
      runs.run(definition, {
        stateDir,
        runId,
        input: null,
        harness: { invoke: () => Promise.reject(error) },
        policy: [{ match: 'ask', maxTurns: 3 }],
      }),
    ).rejects.toThrow(`--policy '{"match":"ask","maxTurns":6}'`);
    expect(error.message).toBe(original);
    expect((await readRun({ stateDir, runId })).error).toContain('turns=unknown; costUsd=unknown');
  });

  it('keeps denial diagnostics on successful envelopes with process failure', async ({
    stateDir,
    runs,
  }) => {
    const error = new HarnessError({
      harness: 'claude',
      kind: 'process',
      exit: { code: 7, signal: null },
      failure: null,
      reason: 'process failure',
      stderr: '',
      stdout: '',
      permissionDenials: 2,
      turns: 4,
      usage: reply.usage,
    });
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (await ctx.claude.text('ask', { prompt })).output;
      },
    });
    const failed: unknown = await runs
      .run(definition, {
        stateDir,
        runId,
        input: null,
        harness: { invoke: () => Promise.reject(error) },
      })
      .catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(WorkflowRunError);
    if (!(failed instanceof WorkflowRunError)) throw failed;
    expect(failed.cause).toBe(error);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['ask']?.warnings).toEqual(['Profile text: 2 permission denials reported.']);
    expect(saved.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
    expect(parseProfileOverride('text.maxBudgetUsd=1e-7')).toEqual({
      profile: 'text',
      maxBudgetUsd: 1e-7,
    });
  });

  it('uses sticky limits for unfinished calls and resets them to role values', async ({
    stateDir,
    runs,
  }) => {
    const invoke = vi.fn<Harness['invoke']>().mockRejectedValue(new Error('offline'));
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (await ctx.claude.text('ask', { prompt })).output;
      },
    });
    const options = { stateDir, runId, input: null, harness: { invoke } };
    await expect(
      runs.run(definition, { ...options, profileOverrides: [{ profile: 'text', maxTurns: 40 }] }),
    ).rejects.toThrow('offline');
    await expect(runs.run(definition, { ...options, resume: true })).rejects.toThrow('offline');
    invoke.mockResolvedValue(reply);
    const result = await runs.run(definition, { ...options, resume: true, policyReset: true });
    expect(
      invoke.mock.calls.map(([request]) => (request.options as { maxTurns?: number }).maxTurns),
    ).toEqual([40, 40, 10]);
    expect(result.profileOverrides).toEqual([]);
    const updated = await runs.run(definition, {
      ...options,
      resume: true,
      profileOverrides: [{ profile: 'text', maxTurns: 50 }],
      grants: ['write'],
    });
    expect(updated.profileOverrides).toHaveLength(1);
    expect(updated.grants).toEqual(['write']);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('parses idle-deadline override rules and rejects semantic or malformed ones before the body', async ({
    stateDir,
    runs,
  }) => {
    expect(parseProfileOverride('Scout.idleTimeoutMs=20')).toEqual({
      profile: 'Scout',
      idleTimeoutMs: 20,
    });
    expect(parseProfileOverride('Scout.maxBudgetUsd=0.75')).toEqual({
      profile: 'Scout',
      maxBudgetUsd: 0.75,
    });
    for (const value of [
      'Scout.model=sonnet',
      'Scout.maxTurns=0',
      'Scout.maxTurns=1.5',
      'Scout.timeoutMs=2147483648',
      'Scout.idleTimeoutMs=0',
      'Scout.idleTimeoutMs=2147483648',
      '*.maxTurns=-2',
      'bad',
    ])
      expect(() => parseProfileOverride(value), value).toThrow();
    const run = vi.fn(() => Promise.resolve('ok'));
    const definition = defineWorkflow({
      ...base,
      roster: defineRoster({ Scout: { harness: 'claude', tools: ['Read'] } }),
      run,
    });
    await expect(
      runs.run(definition, {
        stateDir,
        runId,
        input: null,
        profileOverrides: [{ profile: '*', model: 'x' } as unknown as ProfileOverride],
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

// Marker values prove that nothing sensitive reaches a public manifest or checkpoint.
const markers = {
  settings: 'marker-settings-theme',
  hook: 'marker-settings-hook',
  mcpCommand: 'marker-mcp-command',
  mcpToken: 'marker-mcp-token',
  agentDescription: 'marker-agent-description',
  agentPrompt: 'marker-agent-prompt',
  systemPrompt: 'marker-system-prompt',
  appendPrompt: 'marker-append-prompt',
  env: 'marker-env-value',
  codex: 'marker-codex-config',
};
/** Every free-form control the public manifest redacts, for both built-in harnesses. */
const sensitiveControls = (mcpToken = markers.mcpToken) =>
  ({
    claude: {
      isolation: 'inherit',
      settings: { theme: markers.settings, hooks: { Stop: markers.hook } },
      mcpServers: { tracker: { command: markers.mcpCommand, env: { TOKEN: mcpToken } } },
      agents: {
        reviewer: { description: markers.agentDescription, prompt: markers.agentPrompt },
      },
      systemPrompt: markers.systemPrompt,
      appendSystemPrompt: markers.appendPrompt,
      env: { set: { PRIVATE: markers.env } },
    },
    codex: {
      isolation: 'inherit',
      config: { 'model_providers.x.base_url': markers.codex, model_verbosity: 'low' },
    },
  }) as const satisfies AgentDefaults;
/** The Claude half of the sensitive controls as an entry. */
const claudeEntry = (mcpToken?: string) => ({
  harness: 'claude' as const,
  ...sensitiveControls(mcpToken).claude,
});
/** The Codex half of the sensitive controls as an entry. */
const codexEntry = () => ({ harness: 'codex' as const, ...sensitiveControls().codex });
// Captured on main before the redaction change (#103) for the same controls on a profile without
// extends, which merges like `defaults` on the text role; it must never move.
const sensitiveGrantDigest = '629539c408eb9f6d26dce10eda94f73ded2530a730458dbfcfc9047665e2d5f3';

describe('built-in redaction on entries', () => {
  /** P runs two Claude steps, then Q one Codex step. */
  const sensitiveWorkflow = (fail: () => boolean, mcpToken?: string) => {
    // defineRoster's DeepReadonlyOption recurses through the JsonValue types of these controls
    // (TS2589), so the entries hide the free-form keys from their static types; the runtime still
    // sees them.
    const P = claudeEntry(mcpToken) as {
      readonly harness: 'claude';
      readonly isolation: 'inherit';
    };
    const Q = codexEntry() as { readonly harness: 'codex'; readonly isolation: 'inherit' };
    return defineWorkflow({
      ...base,
      roster: defineRoster({ P, Q }),
      async run(ctx) {
        await ctx.roster.P.text('first', { prompt: 'one' });
        await ctx.roster.P.text('second', { prompt: 'two' });
        await ctx.roster.Q.text('third', { prompt: 'three' });
        if (fail()) throw new Error('pause');
        return 'done';
      },
    });
  };

  it('reduces free-form controls of a Claude and a Codex entry to names and digests in public manifests only', () => {
    const definition = { roster: { P: claudeEntry(), Q: codexEntry() } };
    const live = resolveCapabilities(definition);
    const raw = structuredClone(live);
    const manifest = capabilityManifest(definition);
    const text = JSON.stringify(manifest);
    for (const marker of Object.values(markers)) expect(text).not.toContain(marker);
    const [p, q] = [role(manifest, 'P'), role(manifest, 'Q')];
    const [liveP, liveQ] = [role(live, 'P'), role(live, 'Q')];
    // Each entry carries only its own harness's controls, so each redacts only that block.
    expect(p.redacted).toEqual({
      claude: {
        settings: { sha256: digest(liveP.claude.settings), keys: ['hooks', 'theme'] },
        mcpServers: { sha256: digest(liveP.claude.mcpServers), keys: ['tracker'] },
        agents: { sha256: digest(liveP.claude.agents), keys: ['reviewer'] },
        systemPrompt: { sha256: digest(markers.systemPrompt) },
        appendSystemPrompt: { sha256: digest(markers.appendPrompt) },
      },
    });
    expect(q.redacted).toEqual({
      codex: {
        config: {
          sha256: digest(liveQ.codex.config),
          keys: ['model_providers.x.base_url', 'model_verbosity'],
        },
      },
    });
    for (const field of ['settings', 'mcpServers', 'agents', 'systemPrompt', 'appendSystemPrompt'])
      expect(p.claude).not.toHaveProperty(field);
    expect(q.codex).not.toHaveProperty('config');
    expect(p.environment?.claude.set).toEqual(['PRIVATE']);
    expect(p.claude.isolation).toBe('inherit');
    expect(q.codex.isolation).toBe('inherit');
    expect(manifest.defaults).not.toHaveProperty('redacted');
    for (const [name, other] of Object.entries(manifest.profiles))
      if (name !== 'P' && name !== 'Q') expect(other).not.toHaveProperty('redacted');
    expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
    // The live manifest keeps raw values and the projection leaves its input untouched.
    expect(liveP.claude.mcpServers).toEqual(claudeEntry().mcpServers);
    expect(liveQ.codex.config).toEqual(codexEntry().config);
    expect(live).toEqual(raw);
    expect(publicCapabilityManifest(live, [])).toEqual(manifest);
    // A second pass changes nothing; registered env digests are covered with their own harness (#248).
    expect(publicCapabilityManifest(manifest, [])).toEqual(manifest);
  });

  it('keeps grant digests of redacted controls stable across redaction and sensitive to rotation', () => {
    const live = resolveCapabilities({ defaults: sensitiveControls() });
    expect(profileGrantDigest(role(live, 'text'))).toBe(sensitiveGrantDigest);
    const changed = resolveCapabilities({ defaults: sensitiveControls('other-token') });
    expect(profileGrantDigest(role(changed, 'text'))).not.toBe(sensitiveGrantDigest);
  });

  it('checkpoints redacted entry manifests, runs with raw controls and replays an unchanged resume', async ({
    stateDir,
    runs,
  }) => {
    let stop = true;
    const { invoke, harness } = fake();
    const definition = sensitiveWorkflow(() => stop);
    const options = { stateDir, runId, input: null, harness, grants: ['P'] };
    await expect(runs.run(definition, options)).rejects.toThrow('pause');
    const saved = await readRun({ stateDir, runId });
    const text = JSON.stringify(saved);
    for (const marker of Object.values(markers)) expect(text).not.toContain(marker);
    expect(saved.capabilities?.profiles['P']?.redacted?.claude?.mcpServers?.keys).toEqual([
      'tracker',
    ]);
    expect(saved.capabilities?.profiles['Q']?.redacted?.codex?.config?.keys).toEqual([
      'model_providers.x.base_url',
      'model_verbosity',
    ]);
    expect(saved.grantedProfiles?.['P']).toBe(
      profileGrantDigest(role(resolveCapabilities(definition), 'P')),
    );
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
      settings: { theme: markers.settings },
      mcpServers: { tracker: { env: { TOKEN: markers.mcpToken } } },
      systemPrompt: markers.systemPrompt,
      env: { set: { PRIVATE: markers.env } },
    });
    expect(invoke.mock.calls[2]?.[0].options).toMatchObject({
      config: { 'model_providers.x.base_url': markers.codex },
    });
    // Unchanged resume replays every step and finishes without a new invocation.
    stop = false;
    await expect(runs.run(definition, { ...options, resume: true })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('refuses a resume whose only change is a redacted entry value', async ({ stateDir, runs }) => {
    const { invoke, harness } = fake();
    const options = { stateDir, runId, input: null, harness, grants: ['P'] };
    await expect(
      runs.run(
        sensitiveWorkflow(() => true),
        options,
      ),
    ).rejects.toThrow('pause');
    const rotated = sensitiveWorkflow(() => true, 'rotated-token');
    // A completed step that ran under the entry is detected by identity, even with an entry grant.
    await expect(runs.run(rotated, { ...options, resume: true })).rejects.toThrow(
      'option.mcpServers changed on a completed step',
    );
    await expect(runs.run(rotated, { ...options, resume: true, grants: ['all'] })).rejects.toThrow(
      'option.mcpServers changed on a completed step',
    );
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

// Registered harness sensitiveOptions (#247): headers is sensitive and a capability key, token is
// sensitive only, and region is neither.
const vaultMarkers = {
  header: 'marker-vault-header',
  trace: 'marker-vault-trace',
  token: 'marker-vault-token',
};
const vault = defineHarness({
  name: 'vault',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    region: z.string().optional(),
  }),
  capabilities: { structuredOutput: 'none' },
  capabilityKeys: ['headers'],
  sensitiveOptions: ['headers', 'token'],
  access: (options) => (options.headers ? 'write' : 'none'),
});
const vaultHeaders = (header = vaultMarkers.header) => ({
  Authorization: header,
  'X-Trace': vaultMarkers.trace,
});
/** The vault options as a registered-harness block, for `defaults`. */
const vaultOptions = (header?: string, token = vaultMarkers.token) => ({
  headers: vaultHeaders(header),
  token,
  region: 'eu-west',
});
/** The vault options as an entry. */
const vaultEntry = (header?: string, token?: string) => ({
  harness: 'vault' as const,
  ...vaultOptions(header, token),
});
// Captured on main b707169 before #247 for the same options on a profile without extends (which
// merges like `defaults` on the text role) under the same registration without sensitiveOptions
// (access 'write'), and with the header rotated to 'other'; neither may move.
const vaultGrantDigest = '74877c78d0261e0b6c35d6c480438597cbb275344cfd02977477d655622d9613';
const rotatedVaultGrantDigest = '53f34a784c3da809af2498cc76cc878ae9beebda6d01f033a2d44eaf37ec1999';

// Registered harness env (#248): env is a capability key and the only free-form option digested
// outside `redacted`; secret is a declared sensitive option so one manifest mixes both paths.
const envMarkers = { env: 'marker-env-harness-value', secret: 'marker-env-harness-secret' };
const envHarness = defineHarness({
  name: 'envh',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    secret: z.string().optional(),
  }),
  capabilities: { structuredOutput: 'none' },
  capabilityKeys: ['env', 'secret'],
  sensitiveOptions: ['secret'],
  access: () => 'none',
});
const envEntry = (env: Record<string, string> = { TOKEN: envMarkers.env }) => ({
  harness: 'envh',
  env,
  secret: envMarkers.secret,
});

describe('registered harness sensitive options on entries', () => {
  /** P runs two vault steps. */
  const vaultWorkflow = (fail: () => boolean, entry = vaultEntry()) =>
    defineWorkflow({
      ...base,
      harnesses: [vault],
      roster: defineRoster({ P: entry }, { harnesses: [vault] }),
      async run(ctx) {
        await ctx.roster.P.text('first', { prompt: 'one' });
        await ctx.roster.P.text('second', { prompt: 'two' });
        if (fail()) throw new Error('pause');
        return 'done';
      },
    });

  it('moves declared sensitive harness options to redacted digests in public manifests only', () => {
    // A spread copy stands in for the old inheriting profile.
    const definition = {
      harnesses: [vault],
      roster: { P: vaultEntry(), Child: { ...vaultEntry() } },
    };
    const live = resolveCapabilities(definition);
    const raw = structuredClone(live);
    const manifest = capabilityManifest(definition);
    const text = JSON.stringify(manifest);
    for (const marker of Object.values(vaultMarkers)) expect(text).not.toContain(marker);
    for (const name of ['P', 'Child']) {
      const entry = role(manifest, name);
      expect(entry.redacted).toEqual({
        harnesses: {
          vault: {
            headers: { sha256: digest(vaultHeaders()), keys: ['Authorization', 'X-Trace'] },
            token: { sha256: digest(vaultMarkers.token) },
          },
        },
      });
      // The non-sensitive option stays in plaintext; the capability copy loses the sensitive key.
      expect(entry.harnesses?.['vault']).toEqual({ region: 'eu-west' });
      expect(entry.harnessCapabilities?.['vault']).toEqual({});
    }
    expect(manifest.defaults).not.toHaveProperty('redacted');
    for (const [name, other] of Object.entries(manifest.profiles))
      if (name !== 'P' && name !== 'Child') expect(other).not.toHaveProperty('redacted');
    expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
    // The live manifest keeps raw values for execution, grants and identity, and is not mutated.
    expect(live).toEqual(raw);
    expect(role(live, 'P').harnessCapabilities?.['vault']).toEqual({ headers: vaultHeaders() });
    expect(role(live, 'P').harnesses?.['vault']).toMatchObject({ token: vaultMarkers.token });
    expect(publicCapabilityManifest(live, [vault])).toEqual(manifest);
    // A second pass changes nothing; registered env digests are covered separately (#248).
    expect(publicCapabilityManifest(manifest, [vault])).toEqual(manifest);
    // Without the declarations, the projection leaves registered options alone.
    expect(publicCapabilityManifest(live, undefined).profiles['P']?.harnesses?.['vault']).toEqual(
      role(live, 'P').harnesses?.['vault'],
    );
  });

  describe('registered harness env digest (#248)', () => {
    // S carries the built-in controls next to P's registered ones, since an entry pins one harness.
    const definition = { harnesses: [envHarness], roster: { P: envEntry(), S: claudeEntry() } };

    it('digests env once in harnessCapabilities and drops the raw copy', () => {
      const live = resolveCapabilities(definition);
      expect(role(live, 'P').harnessCapabilities?.['envh']).toMatchObject({
        env: { TOKEN: envMarkers.env },
      });
      const manifest = capabilityManifest(definition);
      const entry = role(manifest, 'P');
      expect(entry.harnessCapabilities?.['envh']).toEqual({
        env: { sha256: digest({ TOKEN: envMarkers.env }) },
      });
      expect(entry.harnesses?.['envh']).not.toHaveProperty('env');
      const text = JSON.stringify(manifest);
      for (const marker of [...Object.values(envMarkers), ...Object.values(markers)])
        expect(text).not.toContain(marker);
      expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
    });

    it('is idempotent with built-in controls, declared sensitive options and registered env', () => {
      const live = resolveCapabilities(definition);
      const raw = structuredClone(live);
      for (const declarations of [[envHarness], undefined]) {
        const once = publicCapabilityManifest(live, declarations);
        expect(publicCapabilityManifest(once, declarations)).toEqual(once);
        expect(
          publicCapabilityManifest(publicCapabilityManifest(once, declarations), declarations),
        ).toEqual(once);
        expect(capabilityManifestSchema.parse(once)).toEqual(once);
        expect(role(once, 'P').harnessCapabilities?.['envh']?.['env']).toEqual({
          sha256: digest({ TOKEN: envMarkers.env }),
        });
      }
      // Built-in redactions and the declared sensitive option are in the same manifest.
      const once = publicCapabilityManifest(live, [envHarness]);
      expect(role(once, 'S').redacted?.claude?.settings).toBeDefined();
      expect(role(once, 'P').redacted?.harnesses?.['envh']?.['secret']).toEqual({
        sha256: digest(envMarkers.secret),
      });
      expect(live).toEqual(raw);
    });

    it('digests a live env shaped like a digest and then leaves the digest alone', () => {
      const lookalike = { sha256: 'a'.repeat(64) };
      const live = resolveCapabilities({
        harnesses: [envHarness],
        roster: { P: envEntry(lookalike) },
      });
      expect(role(live, 'P').harnessCapabilities?.['envh']?.['env']).toEqual(lookalike);
      const once = publicCapabilityManifest(live, [envHarness]);
      const expected = { sha256: digest(lookalike) };
      expect(role(once, 'P').harnessCapabilities?.['envh']?.['env']).toEqual(expected);
      expect(publicCapabilityManifest(once, [envHarness])).toEqual(once);
      expect(publicCapabilityManifest(once, undefined)).toEqual(once);
    });

    it('still digests a public-looking env that is not a digest', () => {
      const once = publicCapabilityManifest(resolveCapabilities(definition), [envHarness]);
      const bogus = { sha256: 'short', extra: 'marker-forged' };
      const forged = {
        ...once,
        profiles: {
          ...once.profiles,
          P: { ...role(once, 'P'), harnessCapabilities: { envh: { env: bogus } } },
        },
      };
      expect(
        role(publicCapabilityManifest(forged, [envHarness]), 'P').harnessCapabilities?.['envh'],
      ).toEqual({ env: { sha256: digest(bogus) } });
    });
  });

  it('gives sensitive array options a digest only and leaves entries without them unredacted', () => {
    const lister = defineHarness({
      name: 'lister',
      revision: 1,
      options: z.object({ prompt: z.string(), scopes: z.array(z.string()).optional() }),
      capabilities: { structuredOutput: 'none' },
      sensitiveOptions: ['scopes'],
      access: () => 'none',
    });
    const manifest = capabilityManifest({
      harnesses: [lister],
      roster: { P: { harness: 'lister', scopes: ['marker-scope'] }, Q: { harness: 'lister' } },
    });
    expect(role(manifest, 'P').redacted).toEqual({
      harnesses: { lister: { scopes: { sha256: digest(['marker-scope']) } } },
    });
    expect(JSON.stringify(manifest)).not.toContain('marker-scope');
    expect(role(manifest, 'Q')).not.toHaveProperty('redacted');
    // A registration without sensitiveOptions publishes its options as before.
    const open = defineHarness({ ...lister, sensitiveOptions: [] });
    expect(
      capabilityManifest({
        harnesses: [open],
        roster: { P: { harness: 'lister', scopes: ['visible'] } },
      }).profiles['P'],
    ).toMatchObject({ harnesses: { lister: { scopes: ['visible'] } } });
  });

  it('keeps grant digests of sensitive registered options stable and sensitive to rotation', () => {
    const digestOf = (header?: string) =>
      profileGrantDigest(
        role(
          resolveCapabilities({
            harnesses: [vault],
            defaults: { harnesses: { vault: vaultOptions(header) } },
          }),
          'text',
        ),
      );
    expect(digestOf()).toBe(vaultGrantDigest);
    expect(digestOf('other')).toBe(rotatedVaultGrantDigest);
  });

  it('checkpoints redacted registered options, invokes with raw values and replays an unchanged resume', async ({
    stateDir,
    runs,
  }) => {
    let stop = true;
    const invoke = vi.fn<HarnessAdapter['invoke']>().mockResolvedValue(reply);
    const definition = vaultWorkflow(() => stop);
    const options = {
      stateDir,
      runId,
      input: null,
      adapters: { vault: { invoke } },
      grants: ['P'],
    };
    await expect(runs.run(definition, options)).rejects.toThrow('pause');
    const saved = await readRun({ stateDir, runId });
    const text = JSON.stringify(saved);
    for (const marker of Object.values(vaultMarkers)) expect(text).not.toContain(marker);
    expect(
      saved.capabilities?.profiles['P']?.redacted?.harnesses?.['vault']?.['headers']?.keys,
    ).toEqual(['Authorization', 'X-Trace']);
    expect(saved.grantedProfiles?.['P']).toBe(
      profileGrantDigest(role(resolveCapabilities(definition), 'P')),
    );
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
      headers: vaultHeaders(),
      token: vaultMarkers.token,
      region: 'eu-west',
    });
    stop = false;
    await expect(runs.run(definition, { ...options, resume: true })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.for([
    { label: 'the capability-key header', rotate: () => vaultEntry('rotated-header') },
    { label: 'the token', rotate: () => vaultEntry(undefined, 'rotated-token') },
  ])(
    'refuses a resume whose only change is a rotated sensitive option ($label)',
    async ({ rotate }, { stateDir, runs }) => {
      const invoke = vi.fn<HarnessAdapter['invoke']>().mockResolvedValue(reply);
      const options = {
        stateDir,
        runId,
        input: null,
        adapters: { vault: { invoke } },
        grants: ['P'],
      };
      await expect(
        runs.run(
          vaultWorkflow(() => true),
          options,
        ),
      ).rejects.toThrow('pause');
      const rotated = vaultWorkflow(() => true, rotate());
      // Step identity still sees the raw value, even under --grant all.
      await expect(
        runs.run(rotated, { ...options, resume: true, grants: ['all'] }),
      ).rejects.toThrow('Step first: options changed on a completed step');
      await expect(runs.run(rotated, { ...options, resume: true })).rejects.toThrow(
        'Step first: options changed on a completed step',
      );
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );
});

// Rooted call-site directories were removed (#707; ADRs 0054 and 0062 record the old form).
describe('rooted directories, strict call sites and digests', () => {
  it('refuses claude.addDirRoots in defaults and on an entry, naming the replacement', async ({
    stateDir,
    runs,
  }) => {
    // The definitions are cast past the types, which no longer admit the key.
    const roots = ['runs'];
    for (const resolve of [resolveCapabilities, capabilityManifest]) {
      // An empty list is refused for the same reason, not as a schema error.
      for (const addDirRoots of [roots, []]) {
        const defaults = { defaults: { claude: { addDirRoots } } } as never;
        expect(() => resolve(defaults)).toThrow('defaults.claude.addDirRoots:');
        expect(() => resolve(defaults)).toThrow('rooted call-site directories were removed');
        expect(() => resolve(defaults)).toThrow('addDirs on a roster entry');
        expect(() => resolve({ roster: { Reader: { harness: 'claude', addDirRoots } } })).toThrow(
          'Roster entry Reader cannot set addDirRoots: rooted call-site directories were removed; list addDirs on the entry.',
        );
      }
    }
    // An inline child is refused when it loads, before any effect.
    const { invoke, harness } = fake();
    const child = defineWorkflow({
      ...base,
      name: 'rooted-child',
      defaults: { claude: { addDirRoots: roots } } as never,
      run: async (ctx) => (await ctx.claude.text('read', { prompt })).output,
    });
    const parent = defineWorkflow({
      ...base,
      run: (ctx) => ctx.workflow('child', child, null),
    });
    await expect(runs.run(parent, { stateDir, runId, input: null, harness })).rejects.toThrow(
      'defaults.claude.addDirRoots: rooted call-site directories were removed',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects codex.addDirRoots in defaults with the reason, and on an entry', () => {
    const definition = { defaults: { codex: { addDirRoots: ['runs'] } } } as never;
    for (const resolve of [resolveCapabilities, capabilityManifest]) {
      expect(() => resolve(definition)).toThrow('defaults.codex.addDirRoots:');
      expect(() => resolve(definition)).toThrow('Codex addDirs are writable roots');
      expect(() => resolve(definition)).toThrow('list them statically in codex.addDirs');
      expect(() =>
        resolve({ roster: { Writer: { harness: 'codex', addDirRoots: ['runs'] } } }),
      ).toThrow('Roster entry Writer cannot set addDirRoots');
    }
  });

  it('refuses strict call-site Claude addDirs at runtime under the default role and an entry', async ({
    stateDir,
    runs,
  }) => {
    const reader = { harness: 'claude', tools: ['Read'], addDirs: ['docs'] } as const;
    const manifest = resolveCapabilities({ strictProfiles: true, roster: { Reader: reader } });
    // resolveProfileCall reads the role as `profile`, the key the runner spells a roster call's
    // internal role channel with (#717); the default role is a call without it.
    const call = (name: string | undefined, options: { addDirs?: string[] } = {}) =>
      resolveProfileCall(
        manifest,
        'claude',
        { prompt, ...(name === undefined ? {} : { profile: name }), ...options },
        [],
        {},
        true,
      );
    for (const name of [undefined, 'Reader'])
      expect(() => call(name, { addDirs: ['runs/a'] }), String(name)).toThrow(
        'strictProfiles forbids call-site addDirs;',
      );
    // The entry's own static addDirs still reach the harness when the call passes none.
    expect(call('Reader').options.addDirs).toEqual(['docs']);
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      strictProfiles: true,
      roster: defineRoster({ Reader: reader }),
      async run(ctx) {
        const options = { prompt, addDirs: ['runs/a'] } as never;
        await ctx.roster.Reader.text('entry', options);
        return (await ctx.claude.text('plain', options)).output;
      },
    });
    await expect(runs.run(definition, { stateDir, runId, input: null, harness })).rejects.toThrow(
      'Step entry (claude) failed: Step entry: strictProfiles forbids call-site addDirs;',
    );
    const plain = defineWorkflow({
      ...base,
      strictProfiles: true,
      async run(ctx) {
        const options = { prompt, addDirs: ['runs/a'] } as never;
        return (await ctx.claude.text('plain', options)).output;
      },
    });
    await expect(
      runs.run(plain, { stateDir, runId: 'plain', input: null, harness }),
    ).rejects.toThrow('strictProfiles forbids call-site addDirs;');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps grant digests of roles without roots', () => {
    const digestOf = (defaults: AgentDefaults) =>
      profileGrantDigest(role(resolveCapabilities({ defaults }), 'text'));
    // Computed on unmodified main 4c3ebf5 (see test/fixtures/schema-revision/README.md) for the
    // edit and readonly presets and for a profile extending edit with claude addDirs ['docs'].
    expect(
      digestOf({
        claude: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
        codex: { sandbox: 'workspace-write' },
      }),
    ).toBe('4a87c86d2adce1b7712d584da2a0cf6a16c3daf76fc049310af0af38ef53f5f9');
    expect(digestOf({ claude: { tools: ['Read', 'Grep', 'Glob'] } })).toBe(
      '19aaa56680b71d1d6cba7dccaa13695368d337a391bd36ce4519707dcf0ab8b3',
    );
    expect(
      digestOf({
        claude: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], addDirs: ['docs'] },
        codex: { sandbox: 'workspace-write' },
      }),
    ).toBe('7ce299811063fa4dfd34efcb9bb75f06c3b0552cc2882f7a87d34e6d1ca8a65c');
  });

  it('still reads a stored manifest whose role carries claude.addDirRoots', () => {
    // Records written before #707 may carry rooted roles; the persisted schema keeps the field.
    const manifest = capabilityManifest({
      roster: { Scout: { harness: 'claude', tools: ['Read', 'Grep', 'Glob'] } },
    });
    const scout = role(manifest, 'Scout');
    const stored = {
      ...manifest,
      profiles: {
        ...manifest.profiles,
        Scout: { ...scout, claude: { ...scout.claude, addDirRoots: ['runs'] } },
      },
    };
    const parsed = capabilityManifestSchema.parse(stored);
    expect(parsed).toEqual(stored);
    expect(parsed.profiles['Scout']?.claude).toMatchObject({ addDirRoots: ['runs'] });
    expect(() =>
      capabilityManifestSchema.parse({
        ...stored,
        profiles: { Scout: { ...scout, claude: { ...scout.claude, addDirRoots: [] } } },
      }),
    ).toThrow();
  });

  it('passes static Claude addDirs of an entry to the request, and none otherwise', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      roster: defineRoster({
        Docs: { harness: 'claude', tools: ['Read', 'Grep', 'Glob'], addDirs: ['docs'] },
      }),
      async run(ctx) {
        await ctx.roster.Docs.text('docs', { prompt });
        return (await ctx.claude.text('plain', { prompt })).output;
      },
    });
    await runs.run(definition, { stateDir, runId, input: null, harness });
    const [docs, plain] = invoke.mock.calls.map(([request]) => request.options);
    expect(docs?.addDirs).toEqual(['docs']);
    expect(plain).not.toHaveProperty('addDirs');
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['docs']?.request?.addDirs).toEqual(['docs']);
    expect(saved.steps['plain']?.request).not.toHaveProperty('addDirs');
  });

  it('never accepts addDirRoots as a call option, even with strictProfiles: false', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      strictProfiles: false,
      async run(ctx) {
        const options = { prompt, addDirRoots: ['/'] } as { prompt: string };
        return (await ctx.claude.text('read', options)).output;
      },
    });
    await expect(runs.run(definition, { stateDir, runId, input: null, harness })).rejects.toThrow(
      'Unrecognized key(s) "addDirRoots"',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['claude', claudeDefinition.capabilityKeys, claudeCapabilityKeys],
    ['codex', codexDefinition.capabilityKeys, codexCapabilityKeys],
  ] as const)(
    'rejects every shared %s capability key at strict call sites, and only those',
    (harness, declared, shared) => {
      // One list drives the definition, the runtime check and the call-site types.
      expect(declared).toBe(shared);
      const manifest = capabilityManifest(
        defineWorkflow({ ...base, strictProfiles: true, run: () => Promise.resolve('') }),
      );
      const call = (options: Record<string, unknown>) => () =>
        resolveProfileCall(manifest, harness, { prompt, ...options }, [], {}, true);
      for (const key of shared) {
        // The strict check reads only the key's presence; isolation is raw only when inherited.
        const value = key === 'isolation' ? 'inherit' : [];
        expect(call({ [key]: value }), key).toThrow(`strictProfiles forbids call-site ${key};`);
      }
      expect(call({ isolation: 'restricted', model: 'm', effort: 'low' })).not.toThrow();
    },
  );

  it('rejects raw capabilities under strictProfiles; escape-hatch calls still require class grants', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      strictProfiles: true,
      requireGrants: true,
      async run(ctx) {
        // @ts-expect-error -- strictProfiles omits tools at type level too; the runtime still rejects it.
        return (await ctx.claude.text('edit', { prompt, tools: ['Edit'] })).output;
      },
    });
    const options = { stateDir, runId, input: null, harness };
    await expect(runs.run(definition, { ...options, grants: ['all'] })).rejects.toThrow(
      'strictProfiles forbids call-site tools',
    );
    const legacy = { ...definition, strictProfiles: false };
    await expect(
      runs.run(legacy, { ...options, resume: true, grants: ['text'] }),
    ).resolves.toMatchObject({ status: 'completed' }); // saved all grant is sticky
    await expect(runs.run(legacy, { ...options, runId: 'raw', grants: ['text'] })).rejects.toThrow(
      'requires write access',
    );
    await runs.run(legacy, { ...options, runId: 'raw', resume: true, grants: ['write'] });
    expect(invoke.mock.calls.at(-1)?.[0].options).toMatchObject({
      tools: ['Edit'],
      allowedTools: ['Edit'],
    });
  });

  it('runs raw call-site capabilities when strictProfiles is omitted', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.claude.text('t', { prompt, tools: ['Read'] });
        return (await ctx.codex.text('c', { prompt: 'y', sandbox: 'workspace-write' })).output;
      },
    });
    const options = { stateDir, runId, input: null, harness };
    await expect(runs.run(definition, options)).resolves.toMatchObject({ status: 'completed' });
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
      tools: ['Read'],
      allowedTools: ['Read'],
    });
    expect(invoke.mock.calls[1]?.[0].options).toMatchObject({ sandbox: 'workspace-write' });
    // The same calls stay refused under an explicit strictProfiles: true.
    await expect(
      runs.run({ ...definition, strictProfiles: true }, { ...options, runId: 'strict' }),
    ).rejects.toThrow('strictProfiles forbids call-site tools; declare a roster entry.');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('workflow-level settings without roles', () => {
  it('publishes the default role and its access without evaluating the body', () => {
    const run = vi.fn(() => Promise.resolve('done'));
    const manifest = capabilityManifest(defineWorkflow({ ...base, run }));
    expect(run).not.toHaveBeenCalled();
    expect(manifest).toMatchObject({
      strictProfiles: false,
      defaultProfile: 'text',
      requiredGrants: [],
    });
    expect(manifest.defaults).toMatchObject({
      maxTurns: 10,
      maxBudgetUsd: 0.5,
      timeoutMs: 300_000,
      access: 'read',
      claudeAccess: 'none',
      codexAccess: 'read',
      claude: { tools: [], allowedTools: [] },
      codex: { sandbox: 'read-only' },
    });
    expect(capabilityManifest({ strictProfiles: true }).strictProfiles).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { defaults: { idleTimeoutMs: 0 } },
    { strictProfiles: 'true' },
    // defaults.access asserts the text role's inferred access.
    { defaults: { access: 'read', claude: { tools: ['Edit'] } } },
    { defaults: { access: 'none' } },
    { roster: { Bad: { harness: 'claude', tools: ['Read'], allowedTools: ['Write'] } } },
    { roster: { Bad: { harness: 'claude', tools: ['Bash(npm test:*)'] } } },
    { roster: { Bad: { harness: 'claude', idleTimeoutMs: 2_147_483_648 } } },
  ])('rejects invalid workflow settings before the body: %j', (config) => {
    expect(() => capabilityManifest(config as Parameters<typeof capabilityManifest>[0])).toThrow();
  });

  it('lists only the text role and the roster entries, never the removed presets (#726)', () => {
    const manifest = capabilityManifest(
      defineWorkflow({
        ...base,
        roster: defineRoster({
          Reader: { harness: 'claude', tools: ['Read'] },
          Writer: { harness: 'codex', sandbox: 'workspace-write' },
          // A decider entry is not a role.
          Judge: { decider: 'jev' },
        }),
        run: () => Promise.resolve('ok'),
      }),
    );
    expect(Object.keys(manifest.profiles)).toEqual(['text', 'Reader', 'Writer']);
    expect(manifest.defaultProfile).toBe('text');
    expect(manifest.defaults).toEqual(manifest.profiles['text']);
    expect(capabilityManifest({}).profiles).not.toHaveProperty('readonly');
    expect(Object.keys(capabilityManifest({}).profiles)).toEqual(['text']);
  });

  it('defaults expectsToolUse to roles that grant more than the text baseline', () => {
    const manifest = capabilityManifest({
      roster: {
        Writer: { harness: 'codex', sandbox: 'workspace-write' },
        Reader: { harness: 'codex', sandbox: 'read-only' },
        Quiet: { harness: 'claude', tools: ['Read'], expectsToolUse: false },
        Eager: { harness: 'claude', expectsToolUse: true },
        Tooled: { harness: 'claude', tools: ['Read'] },
      },
    });
    const expects = (name: string) => manifest.profiles[name]?.expectsToolUse;
    expect(expects('text')).toBe(false);
    expect(expects('Writer')).toBe(true);
    expect(expects('Reader')).toBe(false);
    expect(expects('Quiet')).toBe(false);
    expect(expects('Eager')).toBe(true);
    expect(expects('Tooled')).toBe(true);
    // A defaults block that widens the text baseline makes the text role expect tools too.
    expect(
      capabilityManifest({ defaults: { claude: { tools: ['Read'] } } }).profiles['text']
        ?.expectsToolUse,
    ).toBe(true);
  });

  it('applies a defaults idleTimeoutMs to the default role and entries', () => {
    const manifest = capabilityManifest({
      defaults: { idleTimeoutMs: 100 },
      roster: {
        Plain: { harness: 'claude' },
        Patient: { harness: 'claude', idleTimeoutMs: 250 },
      },
    });
    expect(manifest.defaults.idleTimeoutMs).toBe(100);
    expect(manifest.profiles['Plain']?.idleTimeoutMs).toBe(100);
    expect(manifest.profiles['Patient']?.idleTimeoutMs).toBe(250);
    expect(capabilityManifest({}).defaults.idleTimeoutMs).toBeUndefined();
  });

  it('rejects idleTimeoutMs inside a registered harness defaults block', () => {
    const tool = defineHarness({
      name: 'tool',
      revision: 1,
      options: z.object({ prompt: z.string() }),
      capabilities: { structuredOutput: 'none' },
      access: () => 'none',
    });
    expect(() =>
      capabilityManifest({
        harnesses: [tool],
        defaults: { harnesses: { tool: { idleTimeoutMs: 100 } } },
      }),
    ).toThrow('cannot set harness tool.idleTimeoutMs');
  });

  it('saves the run-level flag when it is first given to a completed run', async ({
    stateDir,
    runs,
  }) => {
    const definition = defineWorkflow({ ...base, run: () => Promise.resolve('ok') });
    const options = { stateDir, runId, input: null };
    await runs.run(definition, options);
    expect(await readRun({ stateDir, runId })).not.toHaveProperty('requireGrants');
    await runs.run(definition, { ...options, resume: true, requireGrants: true });
    expect((await readRun({ stateDir, runId })).requireGrants).toBe(true);
  });

  it('rejects a requireGrants that is not a boolean before the body', async ({
    stateDir,
    runs,
  }) => {
    const run = vi.fn(() => Promise.resolve('ok'));
    const definition = { ...defineWorkflow({ ...base, run }), requireGrants: 'yes' as never };
    await expect(runs.run(definition, { stateDir, runId, input: null })).rejects.toThrow(
      'Workflow capability-manifest requireGrants must be a boolean.',
    );
    expect(run).not.toHaveBeenCalled();
  });
});
