import { beforeEach } from 'vitest';

// Unit tests run without fsync: it dominated the suite (see CONTRIBUTING.md, "Test timeouts and
// storage sync"). Child processes, such as crash, benchmark and CLI tests, never load this file and
// keep real syncs. A test that injects faults through FileHandle.sync opts back in with
// useRealStorageSync() or enableRealStorageSync() from ./durable-sync.js.
//
// The module is imported inside the hook, not at the top of this file: a static import would load
// storage-io.ts before a test file's vi.mock('node:fs/promises') is registered, and the cached
// instance would then bypass that mock.
beforeEach(async () => {
  const { setStorageSyncForTesting } = await import('../../src/workflow/runtime/storage-io.js');
  setStorageSyncForTesting(false);
});
