import { describe, expect, it } from 'vitest';
import { zonePlan } from './dns-plan.js';
import { ovhErrorMessage, ovhHeaders, ovhSignature } from './ovh-api.js';
import {
  bootstrapScript, configurationFor, mandatoryOptions, newestRelease, orderStateOf, priceChangeProblem, quoteFromCheckout,
  redacted, rootDnsRecords, rootDomainProblem, setupCodeFrom, withoutOrderSecrets,
} from './server-orders.js';

describe('signing an OVHcloud request', () => {
  it('signs "$1$" + SHA1 of secret, consumer key, method, URL, body and timestamp joined by "+"', () => {
    expect(ovhSignature({ applicationSecret: '7kbG7Bk7S9Nt7ZSV', consumerKey: 'MtU9VPMWg7syNG9JVuoJT33OF8' }, 'GET', 'https://eu.api.ovh.com/1.0/me', '', 1366560945))
      .toBe('$1$cb1decb0d8995862d6ff442bf465cf82a5045064');
    expect(ovhSignature({ applicationSecret: 'AS', consumerKey: 'CK' }, 'post', 'https://ca.api.ovh.com/1.0/order/cart', '{"ovhSubsidiary":"AU"}', 1700000000))
      .toBe('$1$1e8ef25213beeba73d624ed93d3d50e05e1bd9c9');
  });

  it('sends the application, consumer key, timestamp and signature', () => {
    expect(ovhHeaders({ applicationKey: 'AK', applicationSecret: 'AS', consumerKey: 'CK' }, 'POST', 'https://ca.api.ovh.com/1.0/order/cart', '{"ovhSubsidiary":"AU"}', 1700000000)).toEqual({
      'X-Ovh-Application': 'AK',
      'X-Ovh-Consumer': 'CK',
      'X-Ovh-Timestamp': '1700000000',
      'X-Ovh-Signature': '$1$1e8ef25213beeba73d624ed93d3d50e05e1bd9c9',
    });
  });

  it('says what OVHcloud refused in its own words', () => {
    expect(ovhErrorMessage(403, { message: 'This call has not been granted' })).toBe('OVHcloud answered 403: This call has not been granted');
    expect(ovhErrorMessage(500, 'oops')).toBe('OVHcloud answered 500');
  });
});

const checkout = {
  prices: {
    withoutTax: { value: 14, currencyCode: 'AUD' },
    tax: { value: 1.4, currencyCode: 'AUD' },
    withTax: { value: 15.4, currencyCode: 'AUD' },
  },
  details: [
    { description: 'VPS-2 2027', detailType: 'DURATION', totalPrice: { value: 14 } },
    { description: 'Daily backup', detailType: 'DURATION', totalPrice: { value: 0 } },
    { description: 'Setup', detailType: 'INSTALLATION', totalPrice: { value: 0 } },
  ],
  contracts: [{ name: 'General Terms', url: 'https://example.ovh/terms.pdf' }, { name: 3 }],
};

describe('a quote from OVHcloud\'s priced cart', () => {
  it('reads the total charged, the monthly price, the setup fee, the lines and the contracts', () => {
    expect(quoteFromCheckout(checkout)).toEqual({
      currency: 'AUD',
      withoutTax: 14,
      tax: 1.4,
      withTax: 15.4,
      monthly: 14,
      setupFee: 0,
      lines: [{ description: 'VPS-2 2027', amount: 14 }, { description: 'Daily backup', amount: 0 }, { description: 'Setup', amount: 0 }],
      contracts: [{ name: 'General Terms', url: 'https://example.ovh/terms.pdf' }],
    });
  });

  it('refuses a cart priced without a currency', () => {
    expect(() => quoteFromCheckout({ prices: { withTax: { value: 1 } } })).toThrow(/currency/);
  });

  it('buys only at the price the person confirmed and OVHcloud still asks', () => {
    const quoted = quoteFromCheckout(checkout);
    expect(priceChangeProblem(quoted, quoted, 15.4)).toBeUndefined();
    expect(priceChangeProblem(quoted, quoted, 14)).toMatch(/You confirmed 14 AUD/);
    expect(priceChangeProblem(quoted, { ...quoted, withTax: 16.5 }, 15.4)).toMatch(/now prices this at 16.5 AUD.*nothing was bought/);
    expect(priceChangeProblem(quoted, { ...quoted, currency: 'EUR' }, 15.4)).toMatch(/nothing was bought/);
  });
});

describe('the options a plan must have', () => {
  const definitions = [
    { planCode: 'option-auto-backup-2027-7-model2', family: 'automatedBackup', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 3 } }] },
    { planCode: 'option-auto-backup-2027-1-model2', family: 'automatedBackup', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 0 } }] },
    { planCode: 'option-storage-local-2027-model2', family: 'storage', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 0 } }] },
    { planCode: 'option-linux', family: 'os', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 0 } }, { duration: 'P12M', pricingMode: 'upfront12', price: { value: 0 } }] },
    { planCode: 'option-windows', family: 'os', mandatory: false, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 20 } }] },
  ];

  it('takes the cheapest monthly option of each mandatory family, read from the cart', () => {
    expect(mandatoryOptions(definitions).map((option) => option.planCode).sort()).toEqual(['option-auto-backup-2027-1-model2', 'option-linux', 'option-storage-local-2027-model2']);
  });

  it('refuses a mandatory family with no monthly price', () => {
    expect(() => mandatoryOptions([{ planCode: 'option-x', family: 'storage', mandatory: true, prices: [{ duration: 'P12M', pricingMode: 'upfront12', price: { value: 1 } }] }])).toThrow(/storage/);
  });
});

describe('the configuration a cart item asks for', () => {
  it('answers the datacenter and the OS, and checks them against what is offered', () => {
    expect(configurationFor([
      { label: 'vps_datacenter', required: true, allowedValues: ['SYD', 'SGP'] },
      { label: 'vps_os', required: false },
    ], { vps_datacenter: 'SYD', vps_os: 'Ubuntu 24.04' })).toEqual([{ label: 'vps_datacenter', value: 'SYD' }, { label: 'vps_os', value: 'Ubuntu 24.04' }]);
    expect(configurationFor([], { vps_os: 'Ubuntu 24.04' })).toEqual([{ label: 'vps_os', value: 'Ubuntu 24.04' }]);
  });

  it('refuses a datacenter the plan does not offer, and a question Koala cannot answer', () => {
    expect(() => configurationFor([{ label: 'vps_datacenter', required: true, allowedValues: ['GRA'] }], { vps_datacenter: 'SYD' })).toThrow(/offers GRA/);
    expect(() => configurationFor([{ label: 'vps_license', required: true }], { vps_datacenter: 'SYD' })).toThrow(/vps_license/);
  });
});

describe('following the order', () => {
  it('maps OVHcloud\'s order statuses to where the purchase stands', () => {
    expect(orderStateOf('notPaid')).toBe('paying');
    expect(orderStateOf('checking')).toBe('waiting-check');
    expect(orderStateOf('documentsRequested')).toBe('waiting-check');
    expect(orderStateOf('delivering')).toBe('delivering');
    expect(orderStateOf('delivered')).toBe('installing-key');
    expect(orderStateOf('cancelled')).toBe('failed');
    expect(orderStateOf('something new')).toBe('unknown');
  });

  it('finds the newest release tag, ignoring peeled lines and other refs', () => {
    expect(newestRelease([
      'a\trefs/tags/v2026.10.23',
      'b\trefs/tags/v2026.10.23^{}',
      'c\trefs/tags/v2026.10.29',
      'd\trefs/tags/v2026.10.29-2',
      'e\trefs/heads/main',
      'f\trefs/tags/v2099.12.31-lab',
    ].join('\n'))).toBe('v2026.10.29-2');
    expect(newestRelease('')).toBeUndefined();
  });
});

describe('the domains root is reached at', () => {
  it('points app., mesh. and the people\'s wildcard at the server', () => {
    expect(rootDnsRecords('nowrinkles.dev', 'nowrinkles.app', '203.0.113.7').map(({ zone, wanted }) => [zone, wanted.type, wanted.name, wanted.content, wanted.onConflict])).toEqual([
      ['nowrinkles.dev', 'A', 'app.nowrinkles.dev', '203.0.113.7', 'refuse'],
      ['nowrinkles.dev', 'A', 'mesh.nowrinkles.dev', '203.0.113.7', 'refuse'],
      ['nowrinkles.app', 'A', '*.nowrinkles.app', '203.0.113.7', 'refuse'],
    ]);
  });

  it('makes a missing record, keeps a right one, and never rewrites one it did not make', () => {
    const wanted = rootDnsRecords('nowrinkles.dev', 'nowrinkles.app', '203.0.113.7').map((record) => record.wanted);
    const steps = zonePlan(wanted, [{ type: 'A', name: 'mesh.nowrinkles.dev', content: '203.0.113.7' }, { type: 'A', name: '*.nowrinkles.app', content: '198.51.100.1' }]);
    expect(steps.map((step) => step.do)).toEqual(['create', 'keep', 'refuse']);
    expect(steps[2]).toMatchObject({ why: expect.stringMatching(/already points at 198.51.100.1/) });
  });

  it('wants two real domains under different registered domains', () => {
    expect(rootDomainProblem('nowrinkles.dev', 'nowrinkles.app')).toBeUndefined();
    expect(rootDomainProblem('nowrinkles.dev', 'people.nowrinkles.dev')).toMatch(/different registered domain/);
    expect(rootDomainProblem('not a domain', 'nowrinkles.app')).toMatch(/not a domain name/);
  });
});

describe('installing root over SSH', () => {
  const script = bootstrapScript({
    release: 'v2026.10.29', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com',
    domainDns: 'cloudflare', ingressDns: 'porkbun', dnsEnv: { CLOUDFLARE_API_TOKEN: "tok'en", PORKBUN_API_KEY: 'pk1_a', PORKBUN_API_SECRET_KEY: 'sk1_b' },
  });

  it('checks out the signed release, runs bootstrap with the domains, each zone\'s provider and its credentials, starts root and publishes the image', () => {
    expect(script).toContain("git checkout -q --detach 'v2026.10.29'");
    expect(script).toContain("export DOMAIN='nowrinkles.dev' INGRESS_DOMAIN='nowrinkles.app' ACME_EMAIL='me@example.com'");
    expect(script).toContain("export CERTIFICATES=acme DOMAIN_DNS='cloudflare' INGRESS_DNS='porkbun'");
    expect(script).toContain("export CLOUDFLARE_API_TOKEN='tok'\\''en'");
    expect(script).toContain("export PORKBUN_API_SECRET_KEY='sk1_b'");
    expect(() => bootstrapScript({ release: 'v', domain: 'a.dev', ingressDomain: 'b.app', acmeEmail: 'x@y.z', domainDns: 'cloudflare', ingressDns: 'cloudflare', dnsEnv: { 'BAD NAME': 'x' } })).toThrow(/not an environment variable name/);
    expect(script.indexOf('bootstrap.sh')).toBeLessThan(script.indexOf('systemctl start nowrinkles'));
    expect(script.indexOf('systemctl start nowrinkles')).toBeLessThan(script.indexOf('release-watch.sh'));
  });

  it('hands root the sign-in providers\' keys on stdin with the rest, before bootstrap.sh runs', () => {
    const withSignIn = bootstrapScript({
      release: 'v2026.10.30', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com',
      domainDns: 'cloudflare', ingressDns: 'cloudflare', dnsEnv: { CLOUDFLARE_API_TOKEN: 'tok' },
      signInEnv: { OIDC_ISSUER: 'https://login.example.com', OIDC_CLIENT_ID: 'koala', OIDC_CLIENT_SECRET: "s3cr'et", OIDC_LABEL: 'Example staff' },
    });
    expect(withSignIn).toContain("export OIDC_CLIENT_SECRET='s3cr'\\''et'");
    expect(withSignIn).toContain("export OIDC_LABEL='Example staff'");
    expect(withSignIn.indexOf('OIDC_CLIENT_SECRET')).toBeLessThan(withSignIn.indexOf('bash scripts/root-node/bootstrap.sh'));
    expect(script).not.toContain('OIDC_');
  });

  it('keeps every sealed field out of what it sends, however deep', () => {
    expect(withoutOrderSecrets([{ id: 'o', sshPrivateKey: 'k', setupCode: 'c', signInEnv: 'v2:x', signIn: [{ id: 'google', label: 'Google' }] }]))
      .toEqual([{ id: 'o', signIn: [{ id: 'google', label: 'Google' }] }]);
  });

  it('reads the setup code from root\'s env and hides secrets in what it logs', () => {
    expect(setupCodeFrom('PORT=3001\nADMIN_SETUP_CODE=abc123def456\n')).toBe('abc123def456');
    expect(setupCodeFrom('PORT=3001\n')).toBeUndefined();
    expect(redacted('code abc123def456 and token secret-token', ['abc123def456', 'secret-token', 'x'])).toBe('code •••• and token ••••');
  });
});
