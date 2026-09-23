// Local-only, dependency-free fixture server. Never forwards to a model API.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!/^\/(?:src\/[a-z0-9-]+\.js|locales\/(?:en|zh-cn|zh-tw)\.json|message-cost\.css|test\/fixtures\/message-cost\.html)$/.test(pathname)) {
        response.writeHead(404).end();
        return;
    }
    try {
        const data = await readFile(fileURLToPath(new URL(`.${pathname}`, root)));
        response.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8'
            : pathname.endsWith('.css') ? 'text/css; charset=utf-8'
                : pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(data);
    } catch { response.writeHead(404).end(); }
});
server.listen(18764, '127.0.0.1', () => console.log('http://127.0.0.1:18764/test/fixtures/message-cost.html'));
