/// <reference types="bun-types/test" />
import { describe, expect, test } from 'bun:test';

import { analysesKey, analysisKey, invalidationKeys } from './query-keys';

describe('analysesKey', () => {
  test('is one element when unfiltered, so it prefix-matches every filtered key', () => {
    expect(analysesKey()).toEqual(['analyses']);
  });

  test('carries the filters when given them', () => {
    const filters = { sort: 'createdAt', order: 'desc' };
    expect(analysesKey(filters)).toEqual(['analyses', filters]);
  });
});

describe('analysisKey', () => {
  test('names the row it belongs to', () => {
    expect(analysisKey('a3f1')).toEqual(['analysis', 'a3f1']);
  });
});

describe('invalidationKeys', () => {
  test('invalidates the list and the row when the event carries an id', () => {
    expect(invalidationKeys('a3f1')).toEqual([['analyses'], ['analysis', 'a3f1']]);
  });

  test('invalidates only the list when it does not — a DELETE payload has no new row', () => {
    expect(invalidationKeys(undefined)).toEqual([['analyses']]);
  });

  test('the list key stays a prefix, never a filtered key', () => {
    // useAnalyses keys on ['analyses', filters]; TanStack invalidates by
    // prefix, so a two-element key here would miss every mounted filter.
    expect(invalidationKeys('a3f1')[0]).toEqual(['analyses']);
  });
});
