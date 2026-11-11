import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const DERIV_PAT_COOKIE = 'deriv_pat_session';
export const DERIV_PAT_SESSION_SECONDS = 8 * 60 * 60;

function encryptionKey(): Buffer {
  const secret = process.env.DERIV_PAT_SESSION_SECRET || '';
  if (secret.length < 32) {
    throw new Error('DERIV_PAT_SESSION_SECRET must be set to at least 32 characters.');
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptDerivPAT(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(part => part.toString('base64url')).join('.');
}

export function decryptDerivPAT(value: string): string {
  const [ivPart, tagPart, encryptedPart] = value.split('.');
  if (!ivPart || !tagPart || !encryptedPart) throw new Error('Invalid PAT session.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
