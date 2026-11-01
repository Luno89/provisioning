import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  caddyDnsEnv, caddyModules, caddyTlsSnippet, credentialEnvOf, credentialsFromEnv, DNS_PROVIDER_NAMES, DNS_PROVIDERS,
  dnsProviderNamed, providerForNameservers, rootDnsSettingsFrom,
} from './dns-providers.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const repoFile = (path: string): string => readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');

describe('the DNS provider registry', () => {
  it('names the same providers in its type as it describes', () => {
    expect([...DNS_PROVIDER_NAMES].sort()).toEqual(DNS_PROVIDERS.map((provider) => provider.name).sort());
  });

  it('refuses a provider it does not know, naming the ones it does', () => {
    expect(() => dnsProviderNamed('route53')).toThrow(/knows cloudflare, porkbun/);
  });
});

describe('who serves a zone, from its nameservers', () => {
  it('finds Cloudflare and Porkbun, trailing dots and capitals aside', () => {
    expect(providerForNameservers(['journey.ns.cloudflare.com', 'QUINTON.NS.CLOUDFLARE.COM.'])).toEqual({ provider: 'cloudflare' });
    expect(providerForNameservers(['fortaleza.ns.porkbun.com', 'maceio.ns.porkbun.com'])).toEqual({ provider: 'porkbun' });
  });

  it('refuses nameservers that are no provider Koala knows, or a mix, naming them', () => {
    expect(providerForNameservers(['ns1.example.net'])).toEqual({ problem: containing('ns1.example.net') });
    expect(providerForNameservers(['a.ns.cloudflare.com', 'b.ns.porkbun.com'])).toEqual({ problem: containing('a.ns.cloudflare.com, b.ns.porkbun.com') });
    expect(providerForNameservers([])).toEqual({ problem: containing('no nameservers') });
  });
});

describe('root\'s certificate and DNS settings', () => {
  it('reads an older root\'s ROOT_TLS as the settings it meant', () => {
    expect(rootDnsSettingsFrom({ ROOT_TLS: 'cloudflare' })).toEqual({ certificates: 'acme', domainDns: 'cloudflare', ingressDns: 'cloudflare' });
    expect(rootDnsSettingsFrom({ ROOT_TLS: 'internal' })).toEqual({ certificates: 'internal' });
    expect(rootDnsSettingsFrom({})).toEqual({ certificates: 'acme' });
  });

  it('lets CERTIFICATES and a provider per zone say it, and refuses what it does not know', () => {
    expect(rootDnsSettingsFrom({ CERTIFICATES: 'acme', DOMAIN_DNS: 'cloudflare', INGRESS_DNS: 'porkbun', ROOT_TLS: 'cloudflare' })).toEqual({ certificates: 'acme', domainDns: 'cloudflare', ingressDns: 'porkbun' });
    expect(rootDnsSettingsFrom({ CERTIFICATES: 'letsencrypt' })).toEqual({ problem: containing('acme') });
    expect(rootDnsSettingsFrom({ INGRESS_DNS: 'route53' })).toEqual({ problem: containing('INGRESS_DNS is route53') });
  });
});

describe('what Caddy is given', () => {
  it('a tls snippet from the provider\'s own directive, or its own authority in a lab', () => {
    expect(caddyTlsSnippet('internal')).toBe('tls internal\n');
    expect(caddyTlsSnippet('acme', dnsProviderNamed('cloudflare'))).toBe('tls {\n\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n}\n');
    expect(caddyTlsSnippet('acme', dnsProviderNamed('porkbun'))).toBe('tls {\n\tdns porkbun {\n\t\tapi_key {env.PORKBUN_API_KEY}\n\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}\n\t}\n}\n');
    expect(() => caddyTlsSnippet('acme')).toThrow(/DNS provider/);
  });

  it('only the credentials its provider needs, refusing one missing or holding a line break', () => {
    expect(caddyDnsEnv(dnsProviderNamed('porkbun'), { PORKBUN_API_KEY: 'pk1_a', PORKBUN_API_SECRET_KEY: 'sk1_b', CLOUDFLARE_API_TOKEN: 'other' })).toBe('PORKBUN_API_KEY=pk1_a\nPORKBUN_API_SECRET_KEY=sk1_b\n');
    expect(caddyDnsEnv(dnsProviderNamed('cloudflare'), { CLOUDFLARE_API_TOKEN: 'cf' })).toBe('CLOUDFLARE_API_TOKEN=cf\n');
    expect(() => caddyDnsEnv(dnsProviderNamed('porkbun'), { PORKBUN_API_KEY: 'pk1_a' })).toThrow(/PORKBUN_API_SECRET_KEY/);
    expect(() => caddyDnsEnv(dnsProviderNamed('cloudflare'), { CLOUDFLARE_API_TOKEN: 'a\nb' })).toThrow(/line break/);
    expect(caddyDnsEnv(undefined, {})).toBe('');
  });

  it('its modules from the pins file, so the image\'s module list is what the registry names', () => {
    const pins = JSON.parse(repoFile('dependencies.pins.json')) as { components: { kind: string; name: string; version: string }[] };
    expect(repoFile('docker/caddy/modules.txt')).toBe(caddyModules(pins.components));
    expect(() => caddyModules([])).toThrow(/pins no version of github.com\/caddy-dns\/cloudflare/);
  });
});

describe('credentials between stored fields and environment variables', () => {
  it('maps a provider\'s fields to its env names and back, aliases and optional fields included', () => {
    const cloudflare = dnsProviderNamed('cloudflare');
    expect(credentialEnvOf(cloudflare, { token: 'cf', zone: 'koala.test' })).toEqual({ CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ZONE: 'koala.test' });
    expect(credentialEnvOf(cloudflare, { token: 'cf' })).toEqual({ CLOUDFLARE_API_TOKEN: 'cf' });
    expect(credentialEnvOf(cloudflare, { zone: 'koala.test' })).toBeUndefined();
    expect(credentialsFromEnv(cloudflare, { CF_API_TOKEN: 'legacy' })).toEqual({ token: 'legacy' });
    expect(credentialsFromEnv(dnsProviderNamed('porkbun'), { PORKBUN_API_KEY: 'pk1_a' })).toBeUndefined();
  });
});
