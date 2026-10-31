import { startStandInIssuer } from '../../apps/backend/src/accounts/services/sign-in/stand-in-issuer.js';

void startStandInIssuer({ redirectUris: process.argv.slice(2) }).then((issuer) => {
  process.stdout.write(`${JSON.stringify({ issuer: issuer.issuer, clientId: issuer.clientId, clientSecret: issuer.clientSecret })}\n`);
  const stop = () => { void issuer.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
});
