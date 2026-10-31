import { promises as dns } from 'node:dns';
import { connect } from 'node:net';
import {
  BLOCKLIST_TEST_ADDRESS, blocklistQuery, blocklistVerdict, forwardVerdict, mailHostOf, mailReport, MAIL_BLOCKLISTS, port25Verdict,
  PORT_25_PROBE, reverseDnsVerdict, type Blocklist, type DnsAnswer, type MailReadiness, type MailReport,
} from '../lib/mail-reputation.js';

type Reached = { ok: true } | { ok: false; error: string };

export interface MailReputationDeps {
  domain: string;
  ip?: string | undefined;
  relayhost?: string | undefined;
  blocklists?: readonly Blocklist[];
  resolve4?: (name: string) => Promise<string[]>;
  reverse?: (ip: string) => Promise<string[]>;
  reach25?: (host: string) => Promise<Reached>;
  now?: () => Date;
}

export interface MailReputationView {
  report?: MailReport | undefined;
  checking: boolean;
}

const NOT_THERE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export async function answerOf(asked: Promise<string[]>): Promise<DnsAnswer> {
  try {
    const found = await asked;
    return found.length ? { found } : { missing: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (NOT_THERE.has(code)) return { missing: true };
    return { error: code || (error as Error).message };
  }
}

export function reachPort25(host: string, port = 25): Promise<Reached> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, family: 4 });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({ ok: false, error: error.code ?? error.message });
    });
  });
}

export class MailReputation {
  private last: MailReadiness | undefined;
  private running: Promise<MailReadiness> | undefined;

  constructor(private readonly deps: MailReputationDeps) {}

  view(): MailReputationView {
    return { ...(this.last ? { report: mailReport(this.last) } : {}), checking: Boolean(this.running) };
  }

  check(): Promise<MailReadiness> {
    this.running ??= this.checkOnce().then((result) => {
      this.last = result;
      return result;
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkOnce(): Promise<MailReadiness> {
    const resolve4 = this.deps.resolve4 ?? ((name: string) => dns.resolve4(name));
    const reverse = this.deps.reverse ?? ((ip: string) => dns.reverse(ip));
    const host = mailHostOf(this.deps.domain);
    const [forwardAnswer, reached] = await Promise.all([answerOf(resolve4(host)), (this.deps.reach25 ?? ((probe: string) => reachPort25(probe)))(PORT_25_PROBE)]);
    const forward = forwardVerdict(host, forwardAnswer, this.deps.ip);
    const ip = this.deps.ip ?? forward.addresses[0];
    const lists = this.deps.blocklists ?? MAIL_BLOCKLISTS;
    const [reverseDns, blocklists] = ip
      ? await Promise.all([
        answerOf(reverse(ip)).then((answer) => reverseDnsVerdict(ip, host, answer)),
        Promise.all(lists.map(async (list) => blocklistVerdict(
          list,
          ip,
          await answerOf(resolve4(blocklistQuery(BLOCKLIST_TEST_ADDRESS, list.zone))),
          await answerOf(resolve4(blocklistQuery(ip, list.zone))),
        ))),
      ])
      : [undefined, []];
    return {
      domain: this.deps.domain,
      host,
      ...(ip ? { ip } : {}),
      checkedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      forward,
      ...(reverseDns ? { reverseDns } : {}),
      port25: port25Verdict(reached, this.deps.relayhost),
      blocklists,
    };
  }
}
