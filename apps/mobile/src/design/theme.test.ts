/// <reference types="bun-types/test" />
import { describe, expect, test } from 'bun:test';

import { buildTheme, resolveScheme } from './theme';

describe('resolveScheme', () => {
  test('an explicit preference ignores the system scheme', () => {
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('light', 'dark')).toBe('light');
  });

  test('auto follows the system scheme', () => {
    expect(resolveScheme('auto', 'dark')).toBe('dark');
    expect(resolveScheme('auto', 'light')).toBe('light');
  });

  test('auto falls back to light when the system scheme is unknown', () => {
    expect(resolveScheme('auto', null)).toBe('light');
    expect(resolveScheme('auto', undefined)).toBe('light');
  });
});

describe('buildTheme', () => {
  test('carries the scheme and its palette', () => {
    expect(buildTheme('dark').colors.canvas).toBe('#0A0A0C');
    expect(buildTheme('light').colors.canvas).toBe('#F6F5FA');
    expect(buildTheme('dark').scheme).toBe('dark');
  });

  test('shares scheme-independent scales', () => {
    expect(buildTheme('dark').space).toBe(buildTheme('light').space);
  });
});
