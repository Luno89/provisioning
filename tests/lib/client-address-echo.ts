import express from 'express';
import { trustProxyFrom } from '../../apps/backend/src/platform/lib/client-address.js';

const app = express();
const trusted = trustProxyFrom('1');
if (!('trust' in trusted)) throw new Error(trusted.problem);
app.set('trust proxy', trusted.trust);
app.use((req, res) => {
  res.json({ ip: req.ip, forwardedFor: req.headers['x-forwarded-for'] ?? null, peer: req.socket.remoteAddress });
});
for (const port of process.argv.slice(2).map(Number)) {
  app.listen(port, '0.0.0.0', () => console.log(`answering on ${port}`));
}
