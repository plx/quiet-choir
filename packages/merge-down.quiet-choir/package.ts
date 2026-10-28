// The merge-down package (ADR 0065): merge-down-pr ported from the native Claude Code workflow
// script merge-down-pr.js (removed in #693; last at commit 657334c) and its helper CLI. See
// README.md.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import mergeDownPr from './workflows/merge-down-pr.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'merge-down',
  version: '1',
  description:
    'Land one PR: rebase onto main, review against its issue with a local Codex review, triage threads, fix, gate on CI + Codex, merge (squash by default), report',
  whenToUse:
    'Merging down a stack of agent-authored PRs (or Dependabot PRs) one PR per run, in stack order. Input: {pr, repo?, followupEpic?, parentEpic?, until?}.',
  workflows: [mergeDownPr],
  entry: mergeDownPr,
  prompts: [prompts],
});
