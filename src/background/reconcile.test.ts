import { describe, it, expect } from 'vitest';
import {
  decideBookmarkAction,
  decideRenameAction,
  namesMatch,
  type BookmarkSnapshot,
  type BookmarkAction,
} from './reconcile';

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
