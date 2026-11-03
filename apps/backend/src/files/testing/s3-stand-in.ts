import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface S3StandIn {
  port: number;
  objects: Map<string, Buffer>;
  close(): Promise<void>;
}

const NO_SUCH_KEY = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>';

export async function s3StandIn(): Promise<S3StandIn> {
  const buckets = new Set<string>();
  const objects = new Map<string, Buffer>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://s3.test');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.on('end', () => {
      if (!key && url.searchParams.has('location')) {
        response.setHeader('content-type', 'application/xml');
        response.end('<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>');
      } else if (!key && request.method === 'HEAD') {
        response.statusCode = buckets.has(bucket) ? 200 : 404;
        response.end();
      } else if (!key && request.method === 'PUT') {
        buckets.add(bucket);
        response.end();
      } else if (request.method === 'PUT') {
        objects.set(`${bucket}/${key}`, Buffer.concat(body));
        response.setHeader('etag', '"standin"');
        response.end();
      } else if (request.method === 'GET' && objects.has(`${bucket}/${key}`)) {
        response.end(objects.get(`${bucket}/${key}`));
      } else if (request.method === 'DELETE') {
        objects.delete(`${bucket}/${key}`);
        response.statusCode = 204;
        response.end();
      } else {
        response.statusCode = 404;
        response.setHeader('content-type', 'application/xml');
        response.end(NO_SUCH_KEY);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, objects, close: () => new Promise((done) => { server.close(() => done()); }) };
}
