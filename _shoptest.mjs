import fs from 'fs';
const KEY = fs.readFileSync('server/data/custom/studio-key.txt','utf8').trim();
const B='http://localhost:3000';
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const H={'x-studio-key':KEY,'Content-Type':'application/json'};
await fetch(B+'/api/studio/save',{method:'POST',headers:H,body:JSON.stringify({def:{id:'ruby_gem',name:'Ruby Gem',type:'block',category:'Custom',price:120,solid:true,hardness:4,frames:1,frameMs:500},iconPng:PNG,studio:{text:'#'}})});
const data = await (await fetch(B+'/api/custom-items')).json();
const { ITEMS, shopCatalog } = await import('./public/js/shared/items.js');
const { CUSTOM_ITEMS } = await import('./public/js/shared/custom-items.js');
for (const id in data){ const def={...data[id]}; ITEMS[id]={...(ITEMS[id]||{}),...def}; CUSTOM_ITEMS[id]=def; }
const customs = Object.keys(CUSTOM_ITEMS).map(id=>ITEMS[id]).filter(it=>it && it.price!=null);
console.log('Custom section shows:', customs.map(it=>it.id+' @'+it.price));
console.log('shopCatalog has ruby_gem:', shopCatalog().some(s=>s.id==='ruby_gem'));
console.log('search "ruby" matches:', shopCatalog().filter(s=>s.name.toLowerCase().includes('ruby')).map(s=>s.id));
