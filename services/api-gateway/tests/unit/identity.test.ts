import { describe, expect, it } from 'vitest';
import {
  createIdentityContext,
  hasScopeOrPermission,
  type IdentityContext,
} from '../../src/index.js';

describe('Identity Context - Unit Tests', () => {
  it('should successfully create immutable IdentityContext with trimmed fields', () => {
    const identity = createIdentityContext({
      userId: '  user-123  ',
      tenantId: '  tenant-abc  ',
      roles: ['admin', 'member'],
      scopes: ['ai:use', 'read:all'],
      permissions: ['documents:read'],
    });

    expect(identity.userId).toBe('user-123');
    expect(identity.tenantId).toBe('tenant-abc');
    expect(identity.roles).toEqual(['admin', 'member']);
    expect(identity.scopes).toEqual(['ai:use', 'read:all']);
    expect(identity.permissions).toEqual(['documents:read']);
    expect(Object.isFrozen(identity.roles)).toBe(true);
    expect(Object.isFrozen(identity.scopes)).toBe(true);
    expect(Object.isFrozen(identity.permissions)).toBe(true);
  });

  it('should reject empty or whitespace userId', () => {
    expect(() =>
      createIdentityContext({
        userId: '',
        tenantId: 'tenant-abc',
      }),
    ).toThrow('IdentityContext requires a non-empty userId');

    expect(() =>
      createIdentityContext({
        userId: '   ',
        tenantId: 'tenant-abc',
      }),
    ).toThrow('IdentityContext requires a non-empty userId');
  });

  it('should reject empty or whitespace tenantId', () => {
    expect(() =>
      createIdentityContext({
        userId: 'user-123',
        tenantId: '',
      }),
    ).toThrow('IdentityContext requires a non-empty tenantId');

    expect(() =>
      createIdentityContext({
        userId: 'user-123',
        tenantId: '   ',
      }),
    ).toThrow('IdentityContext requires a non-empty tenantId');
  });

  describe('hasScopeOrPermission', () => {
    const identity: IdentityContext = createIdentityContext({
      userId: 'user-1',
      tenantId: 'tenant-1',
      scopes: ['ai:use', 'profile:read'],
      permissions: ['model:invoke'],
      roles: ['ai_developer'],
    });

    it('should return true when scope is present', () => {
      expect(hasScopeOrPermission(identity, 'ai:use')).toBe(true);
      expect(hasScopeOrPermission(identity, 'profile:read')).toBe(true);
    });

    it('should return true when permission is present', () => {
      expect(hasScopeOrPermission(identity, 'model:invoke')).toBe(true);
    });

    it('should return true when role matches', () => {
      expect(hasScopeOrPermission(identity, 'ai_developer')).toBe(true);
    });

    it('should return false when requirement is not satisfied', () => {
      expect(hasScopeOrPermission(identity, 'admin')).toBe(false);
      expect(hasScopeOrPermission(identity, 'ai:manage')).toBe(false);
    });
  });
});
