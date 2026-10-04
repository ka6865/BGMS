import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRecoveryArchive, sealRecoveryArchive, sealRecoveryBytes } from '../scripts/r2_recovery_archive';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bgms-r2-archive-'));
  directories.push(directory);
  const input = join(directory, 'source.tar.gz');
  const sealed = join(directory, 'recovery.enc');
  const restored = join(directory, 'restored.tar.gz');
  const original = Buffer.from('private original telemetry bytes'.repeat(100));
  await writeFile(input, original);
  return { directory, input, sealed, restored, original };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('encrypted R2 recovery artifacts', () => {
  it('opens durable per-object ciphertext using the independently stored recovery key', async () => {
    const f = await fixture();
    await writeFile(f.sealed, sealRecoveryBytes(f.original, 'fixture-secret'));
    await openRecoveryArchive(f.sealed, f.restored, 'fixture-secret');
    expect(await readFile(f.restored)).toEqual(f.original);
  });
  it('roundtrips bytes without exposing plaintext in a public artifact', async () => {
    const f = await fixture();
    await sealRecoveryArchive(f.input, f.sealed, 'fixture-secret');
    expect((await readFile(f.sealed)).includes(f.original.subarray(0, 30))).toBe(false);
    expect((await stat(f.sealed)).mode & 0o777).toBe(0o600);
    await openRecoveryArchive(f.sealed, f.restored, 'fixture-secret');
    expect(await readFile(f.restored)).toEqual(f.original);
  });
  it.each(['wrong-key', 'tampered'])('rejects %s without publishing a partial original', async mode => {
    const f = await fixture();
    await sealRecoveryArchive(f.input, f.sealed, 'fixture-secret');
    if (mode === 'tampered') {
      const bytes = await readFile(f.sealed);
      bytes[25] ^= 1;
      await writeFile(f.sealed, bytes);
    }
    await expect(openRecoveryArchive(f.sealed, f.restored, mode === 'wrong-key' ? 'wrong-secret' : 'fixture-secret')).rejects.toThrow();
    expect(await readdir(f.directory)).toEqual(expect.not.arrayContaining(['restored.tar.gz']));
    expect((await readdir(f.directory)).some(name => name.endsWith('.partial'))).toBe(false);
  });
  it('preserves an existing destination and rejects empty secrets', async () => {
    const f = await fixture();
    await expect(sealRecoveryArchive(f.input, f.sealed, '')).rejects.toThrow('r2-recovery-secret-missing');
    await sealRecoveryArchive(f.input, f.sealed, 'fixture-secret');
    await writeFile(f.restored, 'existing');
    await expect(openRecoveryArchive(f.sealed, f.restored, 'fixture-secret')).rejects.toThrow();
    expect(await readFile(f.restored, 'utf8')).toBe('existing');
    const before = await readFile(f.sealed);
    await expect(sealRecoveryArchive(f.input, f.sealed, 'fixture-secret')).rejects.toThrow();
    expect(await readFile(f.sealed)).toEqual(before);
  });
});
