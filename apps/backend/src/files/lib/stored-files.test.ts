import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SEARCH_LIMIT } from './file-places.js';
import {
  commitPlan, committedAs, DEAD_AFTER_MS, expired, folderPlan, FOLDER_TYPE, idOfObjectKey, isUnder, listing, movePlan, nameOf, objectKey, parentOf,
  sameScope, scopeMovePlan, scopeProblem, scopeText, searching, STORED_FILES_BUCKET, STORED_SCOPE_KINDS, TOUCH_EVERY_MS, touchDue,
  uploadIsDead, uploadPlan, type StoredFileRecord, type StoredScope,
} from './stored-files.js';

const AT = '2026-11-07T10:00:00.000Z';
const LATER = '2026-11-07T11:00:00.000Z';
const PROJECT: StoredScope = { kind: 'project', id: 'p1' };
const ms = (iso: string): number => Date.parse(iso);
const iso = (time: number): string => new Date(time).toISOString();

const file = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => ({
  id, objectId: id, ownerId: 'u1', scope: { ...PROJECT }, path, kind: 'file', size: 3, contentType: 'text/plain', version: 1,
  madeAt: AT, changedAt: AT, state: 'stored', touchedAt: AT, ...extra,
});
const folder = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => file(id, path, { kind: 'folder', size: 0, contentType: FOLDER_TYPE, ...extra });
const uploading = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => file(id, path, { state: 'uploading', version: 0, size: 0, ...extra });

const holds = (property: fc.IRawProperty<unknown[]>): void => {
  expect(() => fc.assert(property)).not.toThrow();
};

const segment = fc.constantFrom('a', 'b', 'c', 'd');
const pathArb = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('/'));

const consistentRecords = (paths: readonly string[]): StoredFileRecord[] => {
  const unique = [...new Set(paths)];
  const leaves = unique.filter((path) => !unique.some((other) => other !== path && isUnder(other, path)));
  return leaves.map((path, index) => file(`f${index}`, path));
};

describe('the constants stored files are kept by', () => {
  it('keeps every kind of place files can belong to, and the bucket, folder type and timings', () => {
    expect(STORED_SCOPE_KINDS).toEqual(['project', 'person', 'conversation', 'run']);
    expect(STORED_FILES_BUCKET).toBe('koala');
    expect(FOLDER_TYPE).toBe('inode/directory');
    expect(TOUCH_EVERY_MS).toBe(30_000);
    expect(DEAD_AFTER_MS).toBe(600_000);
  });
});

describe('object keys', () => {
  it('keeps a file\'s bytes under files/ and its id', () => {
    expect(objectKey('abc')).toBe('files/abc');
  });

  it('reads the id back from a key under files/', () => {
    expect(idOfObjectKey('files/abc')).toBe('abc');
    expect(idOfObjectKey('files/a/b')).toBe('a/b');
  });

  it('names no id for files/ alone, a key elsewhere or one only containing files/', () => {
    expect(idOfObjectKey('files/')).toBeUndefined();
    expect(idOfObjectKey('artifacts/abc')).toBeUndefined();
    expect(idOfObjectKey('x/files/abc')).toBeUndefined();
    expect(idOfObjectKey('files')).toBeUndefined();
    expect(idOfObjectKey('')).toBeUndefined();
  });

  it('reads back every id it made a key for', () => {
    holds(fc.property(fc.string({ minLength: 1 }), (id) => idOfObjectKey(objectKey(id)) === id));
  });
});

describe('scopes', () => {
  it('takes two scopes as the same only when both kind and id match', () => {
    expect(sameScope({ kind: 'project', id: 'p1' }, { kind: 'project', id: 'p1' })).toBe(true);
    expect(sameScope({ kind: 'project', id: 'p1' }, { kind: 'person', id: 'p1' })).toBe(false);
    expect(sameScope({ kind: 'project', id: 'p1' }, { kind: 'project', id: 'p2' })).toBe(false);
  });

  it('says a scope as its kind and id', () => {
    expect(scopeText({ kind: 'conversation', id: 'c9' })).toBe('conversation c9');
  });

  it('finds no problem with any known kind that has an id', () => {
    for (const kind of STORED_SCOPE_KINDS) expect(scopeProblem({ kind, id: 'x' })).toBeUndefined();
  });

  it('refuses a kind that is not a place files are kept', () => {
    expect(scopeProblem({ kind: 'tree' as never, id: 'x' })).toBe('tree is not a place files are kept');
  });

  it('refuses an empty or blank id, naming the kind', () => {
    expect(scopeProblem({ kind: 'run', id: '' })).toBe('a run\'s files need the run\'s id');
    expect(scopeProblem({ kind: 'person', id: '   ' })).toBe('a person\'s files need the person\'s id');
  });
});

describe('paths', () => {
  it('names the folder a path is in, the root for a top-level one', () => {
    expect(parentOf('a/b/c.txt')).toBe('a/b');
    expect(parentOf('a/c.txt')).toBe('a');
    expect(parentOf('c.txt')).toBe('');
  });

  it('names the last part of a path', () => {
    expect(nameOf('a/b/c.txt')).toBe('c.txt');
    expect(nameOf('c.txt')).toBe('c.txt');
  });

  it('takes a path as under a folder when it is the folder or inside it, never a sibling sharing its start', () => {
    expect(isUnder('a/b', 'a')).toBe(true);
    expect(isUnder('a', 'a')).toBe(true);
    expect(isUnder('ab', 'a')).toBe(false);
    expect(isUnder('a', 'a/b')).toBe(false);
    expect(isUnder('b/a', 'a')).toBe(false);
  });

  it('takes every path as under itself and under the root', () => {
    holds(fc.property(pathArb, (path) => isUnder(path, path) && isUnder(path, '')));
  });

  it('puts a path back together from its folder and name', () => {
    holds(fc.property(pathArb, (path) => (parentOf(path) ? `${parentOf(path)}/${nameOf(path)}` : nameOf(path)) === path));
  });
});

describe('when an upload has died', () => {
  it('calls an upload dead once it has not been touched for exactly the dead time', () => {
    expect(uploadIsDead({ state: 'uploading', touchedAt: AT }, iso(ms(AT) + DEAD_AFTER_MS))).toBe(true);
  });

  it('keeps an upload alive one millisecond before the dead time', () => {
    expect(uploadIsDead({ state: 'uploading', touchedAt: AT }, iso(ms(AT) + DEAD_AFTER_MS - 1))).toBe(false);
  });

  it('never calls a stored file dead however long ago it was touched', () => {
    expect(uploadIsDead({ state: 'stored', touchedAt: AT }, iso(ms(AT) + DEAD_AFTER_MS * 10))).toBe(false);
  });
});

describe('when an upload is touched again', () => {
  it('touches once the touch interval has passed exactly, and not a millisecond before', () => {
    expect(touchDue(1000, 1000 + TOUCH_EVERY_MS)).toBe(true);
    expect(touchDue(1000, 1000 + TOUCH_EVERY_MS - 1)).toBe(false);
    expect(touchDue(1000, 1000 + TOUCH_EVERY_MS + 1)).toBe(true);
  });
});

describe('when a file has expired', () => {
  it('never expires a file with no end', () => {
    expect(expired({}, LATER)).toBe(false);
    expect(expired({ expiresAt: undefined }, LATER)).toBe(false);
  });

  it('expires a file at its end and after it, not before', () => {
    expect(expired({ expiresAt: AT }, AT)).toBe(true);
    expect(expired({ expiresAt: AT }, LATER)).toBe(true);
    expect(expired({ expiresAt: AT }, iso(ms(AT) - 1))).toBe(false);
  });
});

describe('listing a folder', () => {
  it('lists the root\'s files and folders, folders first, each by name', () => {
    const records = [file('1', 'z.txt', { size: 9 }), file('2', 'docs/a.txt'), folder('3', 'empty'), file('4', 'b.txt', { changedAt: LATER })];
    expect(listing(records, '')).toEqual([
      { name: 'docs', path: 'docs', type: 'dir' },
      { name: 'empty', path: 'empty', type: 'dir', modified: AT },
      { id: '4', name: 'b.txt', path: 'b.txt', type: 'file', size: 3, modified: LATER },
      { id: '1', name: 'z.txt', path: 'z.txt', type: 'file', size: 9, modified: AT },
    ]);
  });

  it('lists only what is directly inside a folder, folding deeper paths into their folder once', () => {
    const records = [file('1', 'docs/a.txt'), file('2', 'docs/deep/b.txt'), file('3', 'docs/deep/c.txt'), file('4', 'other/x.txt'), file('5', 'docsx.txt')];
    expect(listing(records, 'docs')).toEqual([
      { name: 'deep', path: 'docs/deep', type: 'dir' },
      { id: '1', name: 'a.txt', path: 'docs/a.txt', type: 'file', size: 3, modified: AT },
    ]);
  });

  it('leaves out uploads still in flight and the folder\'s own record', () => {
    expect(listing([uploading('1', 'docs/a.txt'), folder('2', 'docs'), file('3', 'docs/b.txt')], 'docs')).toEqual([
      { id: '3', name: 'b.txt', path: 'docs/b.txt', type: 'file', size: 3, modified: AT },
    ]);
  });

  it('keeps a folder\'s own record over a second one at the same path', () => {
    expect(listing([folder('1', 'a', { changedAt: AT }), folder('2', 'a', { changedAt: LATER })], '')).toEqual([{ name: 'a', path: 'a', type: 'dir', modified: AT }]);
  });

  it('lets a file at a path win over a folder seen there before it', () => {
    expect(listing([folder('1', 'a'), file('2', 'a')], '')).toEqual([{ id: '2', name: 'a', path: 'a', type: 'file', size: 3, modified: AT }]);
  });

  it('keeps the folder a deeper path made when the folder\'s own record comes after it', () => {
    expect(listing([file('1', 'a/x'), folder('2', 'a')], '')).toEqual([{ name: 'a', path: 'a', type: 'dir' }]);
  });

  it('lists nothing for a folder nothing is in', () => {
    expect(listing([file('1', 'a.txt')], 'nothing')).toEqual([]);
  });

  it('never lists an entry twice and always puts folders before files', () => {
    holds(fc.property(fc.array(pathArb, { maxLength: 20 }), fc.constantFrom('', 'a', 'a/b'), (paths, dir) => {
      const entries = listing(consistentRecords(paths), dir);
      const seen = entries.map((entry) => entry.path);
      const firstFile = entries.findIndex((entry) => entry.type === 'file');
      return new Set(seen).size === seen.length
        && (firstFile === -1 || entries.slice(firstFile).every((entry) => entry.type === 'file'))
        && entries.every((entry) => parentOf(entry.path) === dir);
    }));
  });
});

describe('searching by name', () => {
  it('finds stored files whose name holds the words, whatever their case, sorted by path', () => {
    const records = [file('1', 'b/Report.PDF'), file('2', 'a/report-2.txt'), file('3', 'reports/x.txt'), folder('4', 'report'), uploading('5', 'report-3.txt')];
    expect(searching(records, '  REPORT ')).toEqual([
      { id: '2', name: 'report-2.txt', path: 'a/report-2.txt', type: 'file', size: 3, modified: AT },
      { id: '1', name: 'Report.PDF', path: 'b/Report.PDF', type: 'file', size: 3, modified: AT },
    ]);
  });

  it('finds nothing for an empty or blank search', () => {
    expect(searching([file('1', 'a.txt')], '')).toEqual([]);
    expect(searching([file('1', 'a.txt')], '   ')).toEqual([]);
  });

  it('stops at the search limit', () => {
    const records = Array.from({ length: SEARCH_LIMIT + 1 }, (_, index) => file(`${index}`, `f${String(index).padStart(4, '0')}.txt`));
    const found = searching(records, 'f');
    expect(found).toHaveLength(SEARCH_LIMIT);
    expect(found.at(-1)?.path).toBe(`f${String(SEARCH_LIMIT - 1).padStart(4, '0')}.txt`);
  });
});

describe('planning a move', () => {
  it('refuses a source or a target that is not a path, as a bad request', () => {
    expect(movePlan([], '../x', 'y')).toEqual({ ok: false, status: 400, why: '../x would leave the project\'s files' });
    expect(movePlan([], 'x', '')).toEqual({ ok: false, status: 400, why: 'a file needs a name' });
  });

  it('moves nothing when the source and the target are the same path', () => {
    expect(movePlan([file('1', 'a')], '/a/', 'a')).toEqual({ ok: true, moves: [] });
  });

  it('refuses moving a folder inside itself', () => {
    expect(movePlan([file('1', 'a/x')], 'a', 'a/b')).toEqual({ ok: false, status: 400, why: 'a cannot move inside itself' });
  });

  it('refuses a source nothing stored is at, uploads in flight not counting', () => {
    expect(movePlan([uploading('1', 'a')], 'a', 'b')).toEqual({ ok: false, status: 404, why: 'a is not there' });
  });

  it('moves a file to its new path', () => {
    expect(movePlan([file('1', 'a.txt'), file('2', 'b.txt')], 'a.txt', 'c/a.txt')).toEqual({ ok: true, moves: [{ id: '1', path: 'c/a.txt' }] });
  });

  it('moves a folder with everything in it, not a sibling sharing its start', () => {
    const records = [folder('1', 'a'), file('2', 'a/x'), file('3', 'a/b/y'), file('4', 'ab')];
    expect(movePlan(records, 'a', 'z')).toEqual({ ok: true, moves: [{ id: '1', path: 'z' }, { id: '2', path: 'z/x' }, { id: '3', path: 'z/b/y' }] });
  });

  it('refuses a target something else is already at, a file or a folder holding things', () => {
    expect(movePlan([file('1', 'a'), file('2', 'b')], 'a', 'b')).toEqual({ ok: false, status: 409, why: 'b is already there' });
    expect(movePlan([file('1', 'a'), file('2', 'b/c')], 'a', 'b')).toEqual({ ok: false, status: 409, why: 'b is already there' });
  });

  it('lets an upload in flight at the target not stand in the way', () => {
    expect(movePlan([file('1', 'a'), uploading('2', 'b')], 'a', 'b')).toEqual({ ok: true, moves: [{ id: '1', path: 'b' }] });
  });

  it('refuses a target inside a file', () => {
    expect(movePlan([file('1', 'a'), file('2', 'f')], 'a', 'f/a')).toEqual({ ok: false, status: 409, why: 'f is a file, not a folder' });
  });

  it('moves into a folder that is there', () => {
    expect(movePlan([file('1', 'a'), folder('2', 'f')], 'a', 'f/a')).toEqual({ ok: true, moves: [{ id: '1', path: 'f/a' }] });
  });

  it('maps every moved record once, under the target, without landing on anything that stays', () => {
    holds(fc.property(fc.array(pathArb, { maxLength: 12 }), pathArb, pathArb, (paths, from, to) => {
      const records = consistentRecords(paths);
      const plan = movePlan(records, from, to);
      if (!plan.ok) return true;
      const ids = plan.moves.map((move) => move.id);
      const moved = new Set(ids);
      const staying = records.filter((record) => !moved.has(record.id));
      return new Set(ids).size === ids.length
        && ids.length === records.filter((record) => isUnder(record.path, from) && from !== to).length
        && plan.moves.every((move) => isUnder(move.path, to))
        && plan.moves.every((move) => !staying.some((record) => record.path === move.path));
    }));
  });
});

describe('planning a move to another place', () => {
  it('keeps every path as it was under the root', () => {
    expect(scopeMovePlan([file('1', 'a'), file('2', 'b/c')], '')).toEqual([{ id: '1', path: 'a' }, { id: '2', path: 'b/c' }]);
    expect(scopeMovePlan([file('1', 'a')], '/')).toEqual([{ id: '1', path: 'a' }]);
  });

  it('puts every path under the folder named, cleaned', () => {
    expect(scopeMovePlan([file('1', 'a'), file('2', 'b/c')], '/from/chat/')).toEqual([{ id: '1', path: 'from/chat/a' }, { id: '2', path: 'from/chat/b/c' }]);
  });

  it('refuses a folder that is not a path', () => {
    expect(() => scopeMovePlan([file('1', 'a')], '../up')).toThrow('../up would leave the project\'s files');
  });

  it('prefixes every path with the folder, one move per record', () => {
    holds(fc.property(fc.array(pathArb, { maxLength: 10 }), pathArb, (paths, under) => {
      const records = paths.map((path, index) => file(`${index}`, path));
      const moves = scopeMovePlan(records, under);
      return moves.length === records.length && moves.every((move, index) => move.id === records[index]!.id && move.path === `${under}/${records[index]!.path}`);
    }));
  });
});

describe('planning a folder', () => {
  it('refuses a path that is not one', () => {
    expect(folderPlan([], '')).toEqual({ ok: false, status: 400, why: 'a file needs a name' });
  });

  it('makes a folder where nothing is', () => {
    expect(folderPlan([file('1', 'other')], 'a')).toEqual({ ok: true, exists: false });
  });

  it('says a folder is already there when its record or something inside it is', () => {
    expect(folderPlan([folder('1', 'a')], 'a')).toEqual({ ok: true, exists: true });
    expect(folderPlan([file('1', 'a/x')], 'a')).toEqual({ ok: true, exists: true });
  });

  it('refuses a folder where a file is, or inside one', () => {
    expect(folderPlan([file('1', 'a')], 'a')).toEqual({ ok: false, status: 409, why: 'a is a file' });
    expect(folderPlan([file('1', 'a')], 'a/b')).toEqual({ ok: false, status: 409, why: 'a is a file' });
  });

  it('pays no attention to uploads in flight', () => {
    expect(folderPlan([uploading('1', 'a'), uploading('2', 'b/x')], 'a')).toEqual({ ok: true, exists: false });
    expect(folderPlan([uploading('2', 'b/x')], 'b')).toEqual({ ok: true, exists: false });
  });

  it('takes a folder above the path as no obstacle', () => {
    expect(folderPlan([folder('1', 'a')], 'a/b')).toEqual({ ok: true, exists: false });
  });
});

describe('planning an upload', () => {
  it('refuses a path that is not one', () => {
    expect(uploadPlan([], 'a/../b')).toEqual({ ok: false, status: 400, why: 'a/../b would leave the project\'s files' });
  });

  it('lets a file in where nothing is, or replace a file at its own path', () => {
    expect(uploadPlan([], 'a')).toEqual({ ok: true });
    expect(uploadPlan([file('1', 'a')], 'a')).toEqual({ ok: true });
  });

  it('refuses a file where a folder holds things', () => {
    expect(uploadPlan([file('1', 'a/x')], 'a')).toEqual({ ok: false, status: 409, why: 'a is a folder' });
  });

  it('refuses a file inside a file', () => {
    expect(uploadPlan([file('1', 'a')], 'a/b')).toEqual({ ok: false, status: 409, why: 'a is a file, not a folder' });
  });

  it('lets a file in under a folder', () => {
    expect(uploadPlan([folder('1', 'a')], 'a/b')).toEqual({ ok: true });
  });

  it('refuses a file where an empty folder is', () => {
    expect(uploadPlan([folder('1', 'a')], 'a')).toEqual({ ok: false, status: 409, why: 'a is a folder' });
  });

  it('pays no attention to uploads in flight', () => {
    expect(uploadPlan([uploading('1', 'a/x'), uploading('2', 'b'), uploading('3', 'c', { kind: 'folder' })], 'a')).toEqual({ ok: true });
    expect(uploadPlan([uploading('2', 'b')], 'b/x')).toEqual({ ok: true });
    expect(uploadPlan([uploading('3', 'c', { kind: 'folder' })], 'c')).toEqual({ ok: true });
  });
});

describe('planning a commit', () => {
  const none = (): StoredFileRecord[] => [];

  it('stores an upload as its first version with its size and the time of the commit, keeping when it was made', () => {
    const record = uploading('u1', 'a.txt', { madeAt: AT });
    expect(commitPlan([record], [{ id: 'u1', size: 42 }], () => [record], { replace: false }, LATER)).toEqual({
      ok: true, replaced: [], absorbed: [],
      stored: [{ ...record, state: 'stored', size: 42, version: 1, madeAt: AT, changedAt: LATER, touchedAt: LATER }],
    });
  });

  it('refuses an upload that is missing or not the one named', () => {
    expect(commitPlan([undefined], [{ id: 'u1', size: 1 }], none, { replace: true }, LATER)).toEqual({ ok: false, status: 404, why: 'the upload u1 is not waiting to be kept' });
    expect(commitPlan([uploading('other', 'a')], [{ id: 'u1', size: 1 }], none, { replace: true }, LATER)).toEqual({ ok: false, status: 404, why: 'the upload u1 is not waiting to be kept' });
    expect(commitPlan([], [{ id: 'u1', size: 1 }], none, { replace: true }, LATER)).toEqual({ ok: false, status: 404, why: 'the upload u1 is not waiting to be kept' });
  });

  it('hands back a record already stored as it is, without looking at the place again', () => {
    const record = file('u1', 'a', { version: 4 });
    const plan = commitPlan([record], [{ id: 'u1', size: 99 }], () => { throw new Error('not asked'); }, { replace: false }, LATER);
    expect(plan).toEqual({ ok: true, stored: [record], replaced: [], absorbed: [] });
  });

  it('hands back as it is a stored file whose bytes are the upload\'s, so a commit retried after it replaced a file changes nothing', () => {
    const record = file('f1', 'a', { objectId: 'u1', version: 2 });
    const plan = commitPlan([record], [{ id: 'u1', size: 99 }], () => { throw new Error('not asked'); }, { replace: true }, LATER);
    expect(plan).toEqual({ ok: true, stored: [record], replaced: [], absorbed: [] });
  });

  it('knows a record as the commit\'s by its id or by its bytes, and nothing else', () => {
    expect(committedAs(file('u1', 'a'), { id: 'u1', size: 1 })).toBe(true);
    expect(committedAs(file('f1', 'a', { objectId: 'u1' }), { id: 'u1', size: 1 })).toBe(true);
    expect(committedAs(file('f1', 'a', { objectId: 'o1' }), { id: 'u1', size: 1 })).toBe(false);
    expect(committedAs(undefined, { id: 'u1', size: 1 })).toBe(false);
  });

  it('refuses two uploads to one path in one place at once', () => {
    const first = uploading('u1', 'a');
    const second = uploading('u2', 'a');
    expect(commitPlan([first, second], [{ id: 'u1', size: 1 }, { id: 'u2', size: 1 }], none, { replace: true }, LATER))
      .toEqual({ ok: false, status: 409, why: 'a is uploaded twice at once' });
  });

  it('lets one path be uploaded at once in two places', () => {
    const first = uploading('u1', 'a');
    const second = uploading('u2', 'a', { scope: { kind: 'person', id: 'u1' } });
    const plan = commitPlan([first, second], [{ id: 'u1', size: 1 }, { id: 'u2', size: 2 }], none, { replace: false }, LATER);
    expect(plan.ok && plan.stored.map((record) => [record.id, record.size])).toEqual([['u1', 1], ['u2', 2]]);
  });

  it('refuses what the upload plan refuses in the record\'s own place', () => {
    const record = uploading('u1', 'a');
    expect(commitPlan([record], [{ id: 'u1', size: 1 }], () => [record, file('f', 'a/x')], { replace: true }, LATER))
      .toEqual({ ok: false, status: 409, why: 'a is a folder' });
  });

  it('refuses to replace a stored file when replacing is not allowed, naming it', () => {
    const record = uploading('u1', 'a');
    expect(commitPlan([record], [{ id: 'u1', size: 1 }], () => [record, file('old', 'a')], { replace: false }, LATER))
      .toEqual({ ok: false, status: 409, why: 'a is already there', exists: ['a'] });
  });

  it('names every file of a batch that is already there when replacing is not allowed, and keeps none of the batch', () => {
    const a = uploading('u1', 'a');
    const b = uploading('u2', 'b');
    const c = uploading('u3', 'c/d');
    const there = [a, b, c, file('old-a', 'a'), file('old-d', 'c/d')];
    expect(commitPlan([a, b, c], [{ id: 'u1', size: 1 }, { id: 'u2', size: 1 }, { id: 'u3', size: 1 }], () => there, { replace: false }, LATER))
      .toEqual({ ok: false, status: 409, why: '2 files are already there: a, c/d', exists: ['a', 'c/d'] });
  });

  it('gives a stored file the upload\'s bytes as its next version: the file keeps its id and when it was first made, the upload\'s record is absorbed and the old bytes are replaced', () => {
    const record = uploading('u1', 'a', { madeAt: LATER, contentType: 'text/markdown' });
    const old = file('old', 'a', { objectId: 'old-bytes', version: 3, madeAt: '2026-01-01T00:00:00.000Z' });
    expect(commitPlan([record], [{ id: 'u1', size: 7 }], () => [record, old], { replace: true }, LATER)).toEqual({
      ok: true, replaced: ['old-bytes'], absorbed: ['u1'],
      stored: [{ ...old, objectId: 'u1', size: 7, contentType: 'text/markdown', version: 4, changedAt: LATER, touchedAt: LATER }],
    });
  });

  it('gives the new version the upload\'s expiry, and none when the upload has none', () => {
    const old = file('old', 'a', { expiresAt: AT });
    const later = commitPlan([uploading('u1', 'a', { expiresAt: LATER })], [{ id: 'u1', size: 1 }], () => [old], { replace: true }, LATER);
    expect(later.ok && later.stored[0]!.expiresAt).toBe(LATER);
    const never = commitPlan([uploading('u1', 'a')], [{ id: 'u1', size: 1 }], () => [old], { replace: true }, LATER);
    expect(never.ok && 'expiresAt' in never.stored[0]!).toBe(false);
  });

  it('keeps every file\'s id through any run of new versions, replacing each version\'s bytes once', () => {
    holds(fc.property(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 12 }), (choices) => {
      const paths = ['a', 'b', 'c/d'];
      let place: StoredFileRecord[] = [];
      const firstIds = new Map<string, string>();
      const replaced: string[] = [];
      for (const [n, choice] of choices.entries()) {
        const path = paths[choice]!;
        const upload = uploading(`u${n}`, path);
        const plan = commitPlan([upload], [{ id: upload.id, size: n }], () => [...place, upload], { replace: true }, LATER);
        if (!plan.ok) return false;
        const kept = plan.stored[0]!;
        if (!firstIds.has(path)) firstIds.set(path, kept.id);
        if (kept.id !== firstIds.get(path) || kept.objectId !== upload.id || kept.size !== n) return false;
        replaced.push(...plan.replaced);
        place = [...place.filter((record) => record.path !== path), kept];
        const again = commitPlan([kept], [{ id: upload.id, size: n }], () => { throw new Error('not asked'); }, { replace: true }, LATER);
        if (!again.ok || again.replaced.length > 0 || again.stored[0] !== kept) return false;
      }
      const live = new Set(place.map((record) => record.objectId));
      return new Set(replaced).size === replaced.length
        && replaced.length === choices.length - place.length
        && replaced.every((objectId) => !live.has(objectId))
        && place.every((record) => record.version === choices.filter((choice) => paths[choice] === record.path).length);
    }));
  });

  it('replaces only a stored file at the same path, never an upload in flight there', () => {
    const record = uploading('u1', 'a');
    const plan = commitPlan([record], [{ id: 'u1', size: 1 }], () => [record, uploading('other', 'a', { version: 5 })], { replace: false }, LATER);
    expect(plan).toEqual({ ok: true, replaced: [], absorbed: [], stored: [expect.objectContaining({ id: 'u1', version: 1 })] });
  });

  it('commits nothing for no commits', () => {
    expect(commitPlan([], [], none, { replace: false }, LATER)).toEqual({ ok: true, stored: [], replaced: [], absorbed: [] });
  });

  it('never stores a file inside a file committed in the same batch', () => {
    const outer = uploading('u1', 'a');
    const inner = uploading('u2', 'a/b');
    const plan = commitPlan([outer, inner], [{ id: 'u1', size: 1 }, { id: 'u2', size: 1 }], () => [outer, inner], { replace: true }, LATER);
    expect(plan.ok).toBe(false);
  });
});
