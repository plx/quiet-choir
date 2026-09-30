import { afterEach, beforeEach, onTestFinished } from 'vitest';
import { setStorageSyncForTesting } from '../../src/workflow/runtime/storage-io.js';

/** Run every test in the enclosing file or `describe` block with real fsyncs. */
export function useRealStorageSync(): void {
  const previous: boolean[] = [];
  beforeEach(() => {
    previous.push(setStorageSyncForTesting(true));
  });
  afterEach(() => {
    setStorageSyncForTesting(previous.pop() ?? false);
  });
}

/** Call inside one test body to run that test with real fsyncs. Restored when the test finishes. */
export function enableRealStorageSync(): void {
  const previous = setStorageSyncForTesting(true);
  onTestFinished(() => {
    setStorageSyncForTesting(previous);
  });
}
