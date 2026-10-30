import { describe, expect, it } from 'vitest';

import { addSearch, MAX_SEARCHES } from './searchHistory';

describe('search history', () => {
  it('puts the newest search first without repeating it', () => {
    expect(addSearch(['dune', 'alien'], '  Alien  ')).toEqual(['Alien', 'dune']);
    expect(addSearch(['dune'], 'the   office')).toEqual(['the office', 'dune']);
  });

  it('ignores searches that are too short and keeps a limit', () => {
    const list = ['a1', 'b2'];
    expect(addSearch(list, ' x ')).toBe(list);
    const full = Array.from({ length: MAX_SEARCHES }, (_, index) => `search ${index}`);
    expect(addSearch(full, 'new')).toEqual(['new', ...full.slice(0, MAX_SEARCHES - 1)]);
  });
});
