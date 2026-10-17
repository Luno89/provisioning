import { describe, expect, it } from 'vitest';
import { dkimValue, mailDnsActions } from './mail-dns.js';

const OPENDKIM = `koala._domainkey\tIN\tTXT\t( "v=DKIM1; k=rsa; "
\t  "p=MIIBIjANBgkq+/abc"
\t  "DEF=" )  ; ----- DKIM key koala for koala.dev`;

const wanted = { domain: 'koala.dev', ip: '203.0.113.7', selector: 'koala', dkim: 'v=DKIM1; k=rsa; p=MIIBIjANBgkq+/abcDEF=' };

describe('the DKIM record OpenDKIM writes', () => {
  it('becomes one TXT value', () => {
    expect(dkimValue(OPENDKIM)).toBe('v=DKIM1; k=rsa; p=MIIBIjANBgkq+/abcDEF=');
    expect(() => dkimValue('nonsense')).toThrow('that is not an OpenDKIM key record');
  });
});

describe('the records mail needs', () => {
  it('creates everything on a domain that has none, and says what must be set by hand', () => {
    const actions = mailDnsActions(wanted, []);
    expect(actions.filter((action) => action.do === 'create').map((action) => 'record' in action && [action.record.type, action.record.name, action.record.content])).toEqual([
      ['A', 'mail.koala.dev', '203.0.113.7'],
      ['TXT', 'koala.dev', 'v=spf1 ip4:203.0.113.7 ~all'],
      ['TXT', 'koala._domainkey.koala.dev', wanted.dkim],
      ['TXT', '_dmarc.koala.dev', 'v=DMARC1; p=none'],
    ]);
    expect(actions.at(-1)).toEqual({ do: 'tell', why: expect.stringContaining('reverse DNS (PTR) of 203.0.113.7 to mail.koala.dev') });
  });

  it('never rewrites a record the person made: their SPF, their DMARC, their mail host', () => {
    const actions = mailDnsActions(wanted, [
      { id: '1', type: 'TXT', name: 'koala.dev', content: '"v=spf1 include:_spf.google.com ~all"' },
      { id: '2', type: 'TXT', name: '_dmarc.koala.dev', content: 'v=DMARC1; p=reject' },
      { id: '3', type: 'A', name: 'mail.koala.dev', content: '198.51.100.1' },
    ]);
    expect(actions.filter((action) => action.do === 'update')).toEqual([]);
    expect(actions.filter((action) => action.do === 'tell').map((action) => action.why)).toEqual([
      expect.stringContaining('points at 198.51.100.1'),
      expect.stringContaining('Add ip4:203.0.113.7 to it'),
      expect.stringContaining('reverse DNS'),
    ]);
  });

  it('keeps what is already right, and replaces only the key under its own selector', () => {
    const actions = mailDnsActions(wanted, [
      { id: '1', type: 'TXT', name: 'koala.dev', content: 'v=spf1 ip4:203.0.113.7 ~all' },
      { id: '2', type: 'TXT', name: 'koala._domainkey.koala.dev', content: 'v=DKIM1; k=rsa; p=OLD' },
      { id: '3', type: 'A', name: 'mail.koala.dev', content: '203.0.113.7' },
    ]);
    expect(actions.map((action) => action.do)).toEqual(['keep', 'keep', 'update', 'create', 'tell']);
    expect(actions[2]).toMatchObject({ record: { id: '2', content: wanted.dkim } });
  });
});
