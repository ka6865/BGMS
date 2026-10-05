import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('BGMSR2v1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function archiveKey(secret: string): Buffer {
  if (!secret.trim()) throw new Error('r2-recovery-secret-missing');
  return createHash('sha256').update('bgms:r2-recovery:v1\0').update(secret).digest();
}

/** Decrypt one authenticated in-memory recovery object without touching files. */
export function openRecoveryBytes(input: Buffer, secret: string): Buffer {
  const headerBytes = MAGIC.length + IV_BYTES;
  if (!Buffer.isBuffer(input) || input.length <= headerBytes + TAG_BYTES
    || !input.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('r2-recovery-invalid-archive');
  }
  const decipher = createDecipheriv('aes-256-gcm', archiveKey(secret), input.subarray(MAGIC.length, headerBytes));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(input.subarray(input.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(input.subarray(headerBytes, input.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/** Small per-object recovery payloads are encrypted before durable R2 storage. */
export function sealRecoveryBytes(input: Buffer, secret: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', archiveKey(secret), iv);
  cipher.setAAD(MAGIC);
  return Buffer.concat([MAGIC, iv, cipher.update(input), cipher.final(), cipher.getAuthTag()]);
}

/** Public Actions artifacts must contain only authenticated ciphertext. */
export async function sealRecoveryArchive(input: string, output: string, secret: string): Promise<void> {
  if (resolve(input) === resolve(output)) throw new Error('r2-recovery-path-conflict');
  const key = archiveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const destination = await open(output, 'wx', 0o600);
  try {
    await destination.writeFile(Buffer.concat([MAGIC, iv]));
    await destination.close();
    await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'a', mode: 0o600 }));
    await appendFile(output, cipher.getAuthTag());
  } catch (error) {
    await destination.close().catch(() => undefined);
    await unlink(output).catch(() => undefined);
    throw error;
  }
}

/** Publish plaintext only after the whole archive passes authentication. */
export async function openRecoveryArchive(input: string, output: string, secret: string): Promise<void> {
  if (resolve(input) === resolve(output)) throw new Error('r2-recovery-path-conflict');
  const key = archiveKey(secret);
  const source = await open(input, 'r');
  const temp = `${output}.${randomBytes(8).toString('hex')}.partial`;
  try {
    const size = (await source.stat()).size;
    const header = Buffer.alloc(MAGIC.length + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    if (size <= header.length + tag.length) throw new Error('r2-recovery-invalid-archive');
    await source.read(header, 0, header.length, 0);
    await source.read(tag, 0, tag.length, size - tag.length);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('r2-recovery-invalid-archive');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(input, { start: header.length, end: size - tag.length - 1 }),
      decipher,
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
    );
    // Opening exclusively prevents an existing recovery file being replaced.
    const destination = await open(output, 'wx', 0o600);
    await destination.close();
    try { await rename(temp, output); }
    catch (error) { await unlink(output).catch(() => undefined); throw error; }
  } finally {
    await source.close();
    await unlink(temp).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, input, output] = process.argv.slice(2);
  const operation = mode === 'seal' ? sealRecoveryArchive : mode === 'open' ? openRecoveryArchive : null;
  if (!operation || !input || !output || process.argv.length !== 5) {
    console.error('Usage: r2_recovery_archive.ts seal|open INPUT OUTPUT');
    process.exitCode = 1;
  } else {
    operation(input, output, process.env.R2_RECOVERY_ARCHIVE_KEY ?? '').catch(() => {
      console.error('R2 recovery archive operation failed.');
      process.exitCode = 1;
    });
  }
}
