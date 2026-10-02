const assert = require('node:assert/strict');
const http = require('node:http');
const {getEventListeners} = require('node:events');
const {test} = require('node:test');
const names = ['chatInterview','organizeMemory','generateBiography','storyImages'];

for (const name of names) {
  test(`${name}: Node 16 复用连接，完成后移除取消监听，断流可退出`, async () => {
    const previousAgent = http.globalAgent;
    http.globalAgent = new http.Agent({keepAlive:false}); // Node 16 default.
    const ports = new Set();
    const sockets = new Set();
    const server = http.createServer((request,response) => {
      ports.add(request.socket.remotePort);
      if (request.url === '/hang') { response.writeHead(200); response.write('partial'); return; }
      response.end('{"ok":true}');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    const {nodeFetch} = require(`../cloudfunctions/${name}/httpFetch`);
    const controller = new AbortController();
    try {
      for (let index=0;index<2;index++) assert.deepEqual(await (await nodeFetch(root,{signal:controller.signal})).json(),{ok:true});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(ports.size,1,'sequential provider calls should share a warm TCP connection');
      assert.equal(getEventListeners(controller.signal,'abort').length,0,'completed calls must release the abort listener');
      const interrupted = new AbortController();
      const pending = nodeFetch(root+'/hang',{signal:interrupted.signal});
      setImmediate(() => interrupted.abort());
      await assert.rejects(pending,{name:'AbortError'});
    } finally {
      http.globalAgent.destroy();
      http.globalAgent = previousAgent;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
