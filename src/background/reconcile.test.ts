import { describe, it, expect } from 'vitest';
import {
  decideBookmarkAction,
  decideRenameAction,
  namesMatch,
  decideOrder,
  orderInSlots,
  planOrderMoves,
  type BookmarkSnapshot,
  type BookmarkAction,
} from './reconcile';

describe('ordering decisions', () => {
  it('uses browser order initially and appends remote-only entries', () => {
    expect(decideOrder(undefined, [2, 1], [3, 1], [1, 2, 3])).toEqual([2, 1, 3]);
  });

  it.each([
    [[2, 1, 3], [1, 2, 3], [2, 1, 3]],
    [[1, 2, 3], [3, 1, 2], [3, 1, 2]],
    [[2, 1, 3], [3, 1, 2], [3, 1, 2]],
    [[1, 3], [3, 1], [3, 1]],
    [[1, 2, 3, 4], [1, 2, 3], [1, 2, 3, 4]],
    [[1, 2, 3], [1, 4, 2, 3], [1, 4, 2, 3]],
  ])('resolves browser %j and remote %j', (b, r, expected) => {
    expect(decideOrder({ baseline: [1, 2, 3] }, b, r, expected)).toEqual(expected);
  });

  it('resumes a partial target, removes departed items and appends new ones', () => {
    expect(decideOrder({ baseline: [1, 2, 3], pending: { order: [3, 2, 1], browserOrder: [], raindropOrder: [] } }, [3, 2, 4], [2, 3, 4], [2, 3, 4]))
      .toEqual([3, 2, 4]);
  });

  it('keeps fixed slots for every permutation and moves only eligible nodes', () => {
    const permutations = <T>(items: T[]): T[][] => items.length === 0 ? [[]]
      : items.flatMap((id, i) => permutations(items.filter((_, j) => j !== i)).map((rest) => [id, ...rest]));
    const current = [1, 'folder', 2, 'unsupported', 3, 4];
    for (const order of permutations([1, 2, 3, 4])) {
      const actual: (number | string)[] = [...current];
      for (const { id, index } of planOrderMoves<number | string>(current, order)) {
        expect(order).toContain(id);
        actual.splice(actual.indexOf(id), 1);
        actual.splice(index, 0, id);
      }
      expect(actual).toEqual(orderInSlots(current, order));
      expect(planOrderMoves(actual, order)).toEqual([]);
      const intended = orderInSlots(current, order);
      const interrupted: (number | string)[] = [...current];
      for (const step of planOrderMoves<number | string>(current, order)) {
        interrupted.splice(interrupted.indexOf(step.id), 1);
        interrupted.splice(step.index, 0, step.id);
        const resumed = [...interrupted];
        for (const { id, index } of planOrderMoves<number | string>(resumed, order, intended)) {
          expect(order).toContain(id);
          resumed.splice(resumed.indexOf(id), 1);
          resumed.splice(index, 0, id);
        }
        expect(resumed).toEqual(intended);
      }
    }
    expect(planOrderMoves([1, 2, 3, 4], [4, 1, 2, 3])).toEqual([{ id: 4, index: 0 }]);
  });
});

const base: BookmarkSnapshot = { hash: 'h0', mappingId: 'm1' };
const same: BookmarkSnapshot = { hash: 'h0', mappingId: 'm1' };
const edited: BookmarkSnapshot = { hash: 'h1', mappingId: 'm1' };
const moved: BookmarkSnapshot = { hash: 'h0', mappingId: 'm2' };

describe('decideBookmarkAction (three-way table)', () => {
  const cases: [string, BookmarkSnapshot | null, BookmarkSnapshot | null, BookmarkAction][] = [
    // [name, browserSide, raindropSide, expected]
    ['both unchanged → none', same, same, 'none'],
    ['browser edited, raindrop same → push', edited, same, 'push-update'],
    ['browser moved, raindrop same → push', moved, same, 'push-update'],
    ['raindrop edited, browser same → pull', same, edited, 'pull-update'],
    ['raindrop moved, browser same → pull', same, moved, 'pull-update'],
    ['both edited → conflict → Raindrop wins', edited, edited, 'pull-update'],
    ['browser moved + raindrop edited → pull', moved, edited, 'pull-update'],
    ['deleted in browser, raindrop same → delete in Raindrop', null, same, 'delete-in-raindrop'],
    ['deleted in browser, raindrop edited → pull (resurrect)', null, edited, 'pull-update'],
    ['deleted in raindrop, browser same → delete in browser', same, null, 'delete-in-browser'],
    ['deleted in raindrop, browser edited → Raindrop wins → delete in browser', edited, null, 'delete-in-browser'],
    ['gone both sides → drop-link', null, null, 'drop-link'],
  ];
  it.each(cases)('%s', (_name, b, r, expected) => {
    expect(decideBookmarkAction(base, b, r)).toBe(expected);
  });
});

describe('decideRenameAction', () => {
  it('browser renamed, raindrop same → push-rename', () => {
    expect(decideRenameAction('Work', 'Job', 'Work')).toBe('push-rename');
  });
  it('raindrop renamed, browser same → pull-rename', () => {
    expect(decideRenameAction('Work', 'Work', 'Career')).toBe('pull-rename');
  });
  it('both renamed → conflict → pull-rename (Raindrop wins)', () => {
    expect(decideRenameAction('Work', 'Job', 'Career')).toBe('pull-rename');
  });
  it('unchanged → none', () => {
    expect(decideRenameAction('Work', 'Work', 'Work')).toBe('none');
  });
  it('case/whitespace drift is NOT a rename (ci + trim)', () => {
    expect(decideRenameAction('Work', ' work ', 'WORK')).toBe('none');
  });
});

describe('namesMatch', () => {
  it('is case-insensitive and trimmed', () => {
    expect(namesMatch(' Work ', 'work')).toBe(true);
    expect(namesMatch('Work', 'Job')).toBe(false);
  });
});
