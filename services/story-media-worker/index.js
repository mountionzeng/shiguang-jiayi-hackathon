const http=require('node:http');

function createServer({voiceRunner,narrationRunner}={}) {
  const server=http.createServer((request,response)=>{
    if(request.url==='/health'){
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({ok:true,service:'story-media-worker'}));
      return;
    }
    response.writeHead(404,{'content-type':'application/json'});
    response.end(JSON.stringify({error:'NOT_FOUND'}));
  });
  const runners=[voiceRunner,narrationRunner].filter(Boolean);
  if(runners.length){server.once('listening',()=>runners.forEach(runner=>runner.start()));server.once('close',()=>runners.forEach(runner=>runner.stop()));}
  return server;
}

if(require.main===module)createServer().listen(Number(process.env.PORT || 8080));
module.exports={createServer};
