import { describe, expect, it } from 'vitest';
import { throwConversationRpcError, ConversationRepositoryError } from './conversation-errors.js';
import { toFolderError, ChatFolderRepositoryError } from './ChatFolderRepository.js';
import { safeError } from '../../platform/observability/events.js';

describe('database error conversion diagnostics', () => {
  it.each(['PGRST202', '42P01', 'ECONNRESET'])(
    'retains %s in the safe cause without private messages',
    (code) => {
      const original = { code, message: 'private fixture body', details: 'private fixture detail' };
      let caught: unknown;
      try {
        throwConversationRpcError(original, 'compatible message');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).cause).toBe(original);
      expect((caught as Error).message).toBe('compatible message：private fixture body');
      expect(safeError(caught).cause?.code).toBe(code);
      expect(JSON.stringify(safeError(caught))).not.toContain('private fixture');
    }
  );

  it('keeps mapped public codes and original causes separate', () => {
    const original = { code: 'P0002', message: 'private fixture' };
    let caught: unknown;
    try {
      throwConversationRpcError(original, 'fixture');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConversationRepositoryError);
    expect(caught).toMatchObject({ code: 'session_not_found', cause: original });
    expect(safeError(caught).cause?.code).toBe('P0002');
  });

  it.each([
    ['23503', 'folder_not_found'],
    ['23505', 'folder_name_taken'],
    ['PGRST202', 'folders_unavailable'],
  ])('retains folder mapping %s and its database cause', (code, publicCode) => {
    const original = { code, message: 'private fixture' };
    const error = toFolderError(original, 'fixture');
    expect(error).toBeInstanceOf(ChatFolderRepositoryError);
    expect(error).toMatchObject({ code: publicCode, cause: original });
    expect(safeError(error).cause?.code).toBe(code);
    expect(JSON.stringify(safeError(error))).not.toContain('private fixture');
  });

  it('keeps unknown database errors diagnosable without forwarding arbitrary codes', () => {
    const original = { code: 'private-code', message: 'private fixture' };
    const error = toFolderError(original, 'compatible fallback');
    expect(error.message).toBe('compatible fallback：private fixture');
    expect(error.cause).toBe(original);
    expect(JSON.stringify(safeError(error))).not.toContain('private');
  });
});
