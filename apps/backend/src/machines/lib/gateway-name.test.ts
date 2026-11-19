import { describe, expect, it } from 'vitest';
import { gatewayServerName } from './gateway-name.js';

const NAMED = "-----BEGIN CERTIFICATE-----\nMIIBqjCCAVCgAwIBAgIUDMuCT8Uko0wVZ3QZtvux+m1pkdwwCgYIKoZIzj0EAwIw\nGDEWMBQGA1UEAwwNbHVuby10ZW1wb3JhbDAeFw0yNjExMTkwOTMzNTNaFw0zNjEx\nMTYwOTMzNTNaMBgxFjAUBgNVBAMMDWx1bm8tdGVtcG9yYWwwWTATBgcqhkjOPQIB\nBggqhkjOPQMBBwNCAATg7P1Pkd7uQ+bJFyRZc88z0sQJ600+8byURC7fWJRKPapA\n8F4m4M6tTTAHHF3zm2Q84pO7dl5M4Ampexwn/ZKBo3gwdjAdBgNVHQ4EFgQUYy0U\nn+6RJxSd5rmXyByIOLn45NIwHwYDVR0jBBgwFoAUYy0Un+6RJxSd5rmXyByIOLn4\n5NIwDwYDVR0TAQH/BAUwAwEB/zAjBgNVHREEHDAagg1sdW5vLXRlbXBvcmFsggls\nb2NhbGhvc3QwCgYIKoZIzj0EAwIDSAAwRQIgcL7mUmbI8Vsi8C5+YgKBuLosrl1r\ngvzNJlkBUSCBvkoCIQDpILXBod4B/86vpB1+khQ5xL/5MaKUAIlJIWzmCpUc5g==\n-----END CERTIFICATE-----\n";
const UNNAMED = "-----BEGIN CERTIFICATE-----\nMIIBdjCCARugAwIBAgIUdfHMLSXuR0WKo2WuVQ3y4+ZqZk0wCgYIKoZIzj0EAwIw\nEDEOMAwGA1UECgwFS29hbGEwHhcNMjYxMTE5MDkzMzUzWhcNMzYxMTE2MDkzMzUz\nWjAQMQ4wDAYDVQQKDAVLb2FsYTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABODs\n/U+R3u5D5skXJFlzzzPSxAnrTT7xvJRELt9YlEo9qkDwXibgzq1NMAccXfObZDzi\nk7t2XkzgCal7HCf9koGjUzBRMB0GA1UdDgQWBBRjLRSf7pEnFJ3muZfIHIg4ufjk\n0jAfBgNVHSMEGDAWgBRjLRSf7pEnFJ3muZfIHIg4ufjk0jAPBgNVHRMBAf8EBTAD\nAQH/MAoGCCqGSM49BAMCA0kAMEYCIQDvX1PzomZ9lhCOaZyKRXhg5lugZlU7BX27\nbQuPDgMLEAIhAMHfqWT9wJj6NcNC8lfnu9IvnBjXjHAz/FaJMXJKWSCV\n-----END CERTIFICATE-----\n";

describe('the name a machine checks its gateway\'s certificate by', () => {
  it('is the name the certificate was made for', () => {
    expect(gatewayServerName(NAMED)).toBe('luno-temporal');
  });

  it('refuses a certificate that names no server, rather than let a machine check it by nothing', () => {
    expect(() => gatewayServerName(UNNAMED)).toThrow('the machine gateway\'s certificate names no server');
  });
});
