import { describe, it, expect } from 'vitest'
import { computePageRange } from '../utils/computePageRange';

describe('computePageRange', () => {
  it('8 total pages, current page 1 → shows [1, 2, 3, 4, 5, "ellipsis", 8]', () => {
    expect(computePageRange(1, 8)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 8]);
  });

  it('8 total pages, current page 4 → [1, "ellipsis", 3, 4, 5, "ellipsis", 8]', () => {
    expect(computePageRange(4, 8)).toEqual([1, 'ellipsis', 3, 4, 5, 'ellipsis', 8]);
  });

  it('8 total pages, current page 8 → [1, "ellipsis", 4, 5, 6, 7, 8]', () => {
    expect(computePageRange(8, 8)).toEqual([1, 'ellipsis', 4, 5, 6, 7, 8]);
  });

  it('3 total pages, current page 2 → [1, 2, 3]', () => {
    expect(computePageRange(2, 3)).toEqual([1, 2, 3]);
  });

  it('7 total pages, current page 4 → [1, 2, 3, 4, 5, 6, 7]', () => {
    expect(computePageRange(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('1 total page, current page 1 → [1]', () => {
    expect(computePageRange(1, 1)).toEqual([1]);
  });

  it('12 total pages, current page 6 → [1, "ellipsis", 5, 6, 7, "ellipsis", 12]', () => {
    expect(computePageRange(6, 12)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 12]);
  });
});
