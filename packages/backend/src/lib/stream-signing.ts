import { createPrivateKey, sign } from 'node:crypto';

export interface StreamSigning {
  host: string;
  keyId: string;
  privateKey: string;
}

/** Local signing keeps management API latency out of playback. */
export function signStreamToken(signing: StreamSigning, uid: string, downloadable = false) {
  if (!/^[a-f0-9]{32}$/.test(uid)) throw new Error('stream_uid_invalid');
  const expires = Math.floor(Date.now() / 1000) + 900;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: signing.keyId })).toString(
    'base64url'
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: uid,
      kid: signing.keyId,
      exp: expires,
      ...(downloadable ? { downloadable: true } : {}),
    })
  ).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(input),
    createPrivateKey(
      signing.privateKey.includes('-----BEGIN')
        ? signing.privateKey.replace(/\\n/g, '\n')
        : Buffer.from(signing.privateKey, 'base64')
    )
  ).toString('base64url');
  return { token: `${input}.${signature}`, expires_at: new Date(expires * 1000).toISOString() };
}

export function isStreamPrivateKeyValid(privateKey: string): boolean {
  try {
    const key = createPrivateKey(
      privateKey.includes('-----BEGIN')
        ? privateKey.replace(/\\n/g, '\n')
        : Buffer.from(privateKey, 'base64')
    );
    return key.asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}
