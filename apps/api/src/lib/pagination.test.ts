import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { DEFAULT_LIMIT, MAX_LIMIT, pageQuery, paginated, repeatable } from './pagination';

const query = pageQuery(['createdAt', 'score'], 'createdAt');

describe('pageQuery', () => {
  test('applies defaults to an empty query', () => {
    expect(query.parse({})).toEqual({
      limit: DEFAULT_LIMIT,
      offset: 0,
      sort: 'createdAt',
      order: 'desc',
    });
  });

  test('coerces limit and offset from the strings a query string carries', () => {
    const parsed = query.parse({ limit: '5', offset: '10' });

    expect(parsed.limit).toBe(5);
    expect(parsed.offset).toBe(10);
  });

  test('rejects a limit above MAX_LIMIT rather than silently clamping it', () => {
    expect(query.safeParse({ limit: String(MAX_LIMIT + 1) }).success).toBe(false);
    expect(query.safeParse({ limit: String(MAX_LIMIT) }).success).toBe(true);
  });

  test('rejects a limit below 1', () => {
    expect(query.safeParse({ limit: '0' }).success).toBe(false);
  });

  test('rejects a negative offset', () => {
    expect(query.safeParse({ offset: '-1' }).success).toBe(false);
  });

  test('rejects a fractional limit', () => {
    expect(query.safeParse({ limit: '1.5' }).success).toBe(false);
  });

  test('accepts a sort key from the allowlist and rejects one outside it', () => {
    expect(query.parse({ sort: 'score' }).sort).toBe('score');
    expect(query.safeParse({ sort: 'password' }).success).toBe(false);
  });

  test('takes the default sort key and order given to it', () => {
    const ascending = pageQuery(['name'], 'name', 'asc');

    expect(ascending.parse({})).toMatchObject({ sort: 'name', order: 'asc' });
  });
});

describe('repeatable', () => {
  const schema = z.object({ status: repeatable(z.enum(['QUEUED', 'FAILED'])) });

  test('is undefined when the param is absent', () => {
    expect(schema.parse({}).status).toBeUndefined();
  });

  test('wraps the single occurrence Hono reports as a bare string', () => {
    expect(schema.parse({ status: 'QUEUED' }).status).toEqual(['QUEUED']);
  });

  test('keeps the array Hono reports for a repeated param', () => {
    expect(schema.parse({ status: ['QUEUED', 'FAILED'] }).status).toEqual(['QUEUED', 'FAILED']);
  });

  test('rejects a value outside the item schema', () => {
    expect(schema.safeParse({ status: 'DELETED' }).success).toBe(false);
    expect(schema.safeParse({ status: ['QUEUED', 'DELETED'] }).success).toBe(false);
  });

  test('rejects an empty repetition rather than filtering everything out', () => {
    expect(schema.safeParse({ status: [] }).success).toBe(false);
  });
});

describe('paginated', () => {
  const page = { limit: 20, offset: 20 };

  test('reports hasMore while rows remain beyond this page', () => {
    expect(paginated(new Array(20).fill('row'), page, 47).page).toEqual({
      limit: 20,
      offset: 20,
      total: 47,
      hasMore: true,
    });
  });

  test('reports hasMore false on a short last page', () => {
    expect(paginated(new Array(7).fill('row'), { limit: 20, offset: 40 }, 47).page.hasMore).toBe(
      false,
    );
  });

  test('reports hasMore false when a full page exactly consumes the total', () => {
    expect(paginated(new Array(20).fill('row'), page, 40).page.hasMore).toBe(false);
  });

  test('reports hasMore false for an empty result', () => {
    expect(paginated([], { limit: 20, offset: 0 }, 0).page.hasMore).toBe(false);
  });

  test('passes the rows through untouched', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];

    expect(paginated(rows, { limit: 20, offset: 0 }, 2).items).toBe(rows);
  });
});
