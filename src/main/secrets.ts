import { safeStorage } from 'electron';

/**
 * API-key encryption backed by the OS keychain via Electron safeStorage.
 * Falls back to obfuscated plaintext when no safe backend is available
 * (e.g. Linux without a keyring), clearly marked so callers can warn.
 */
const PLAIN_PREFIX = 'plain:';

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64');
  }
  return PLAIN_PREFIX + Buffer.from(plain, 'utf8').toString('base64');
}

export function decryptSecret(enc: string | undefined): string | null {
  if (!enc) return null;
  try {
    if (enc.startsWith(PLAIN_PREFIX)) {
      return Buffer.from(enc.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
    }
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}
