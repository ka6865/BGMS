import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describeBody, objectGroup } from '../scripts/audit_r2_retention';

describe('read-only audit evidence', () => {
  it('distinguishes root JSON, cache versions and protected prefixes', () => {
    expect(objectGroup('match_nick_analyze.json')).toBe('(root)');
    expect(objectGroup('telemetry-map/v61/steam/id/hash/lite.json')).toBe('telemetry-map/v61');
    expect(objectGroup('backups/recovery/file.enc')).toBe('backups');
  });
  it('recognizes legacy event arrays and reports no invented match stats', () => {
    const report = describeBody(gzipSync('[{"_T":"LogMatchStart","_D":"2026-09-01T00:00:00Z"}]'));
    expect(report.kind).toBe('array');
    expect(report.eventCount).toBe(1);
    expect(report.eventTypes).toEqual({ LogMatchStart: 1 });
    expect(report.stats).toBeUndefined();
    expect(report.matchInfo).toBeUndefined();
  });
  it('proves equal projected events without treating different envelopes as equal files', () => {
    const events = [{ _T: 'LogMatchStart', _D: '2026-09-01T00:00:00Z' }];
    const first = describeBody(Buffer.from(JSON.stringify({ identity: { player: 'a' }, events })));
    const second = describeBody(gzipSync(JSON.stringify({ identity: { player: 'b' }, events })));
    expect(first.eventsSha256).toBe(second.eventsSha256);
    expect(first.sha256).not.toBe(second.sha256);
  });
  it('does not silently accept corrupt JSON', () => {
    expect(() => describeBody(Buffer.from('invalid-json'))).toThrow();
  });
  it('finds legacy actor evidence without including raw names or account IDs in the participant report', () => {
    const report = describeBody(Buffer.from(JSON.stringify([
      { _T: 'LogPlayerCreate', character: { name: 'ExamplePlayer', accountId: 'account.example' } },
    ])));
    expect(report.participants).toEqual([{
      playerHash: createHash('sha256').update('exampleplayer').digest('hex'),
      accountHash: createHash('sha256').update('account.example').digest('hex').slice(0, 32),
      platform: undefined,
    }]);
    expect(JSON.stringify(report.participants)).not.toContain('ExamplePlayer');
    expect(JSON.stringify(report.participants)).not.toContain('account.example');
  });
});
