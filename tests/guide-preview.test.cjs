const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalAt,strokeRequest}=require('../web/brush-runtime.js');

test('densified Feather splines receive a finite normal at every preview point',()=>{
 const raw=Array.from({length:18},(_,i)=>{const angle=-1.1+2.2*i/17;return {x:0,y:Math.sin(angle),z:Math.cos(angle)};});
 const before=JSON.stringify(raw),count=raw.length*3-2;
 const dense=Array.from({length:count},(_,i)=>normalAt(raw,i,count));
 assert.equal(dense.length,52);
 for(const n of dense){assert.ok(Object.values(n).every(Number.isFinite));assert.ok(Math.abs(Math.hypot(n.x,n.y,n.z)-1)<1e-12);}
 assert.deepEqual(dense[0],raw[0]);assert.deepEqual(dense.at(-1),raw.at(-1));
 assert.equal(JSON.stringify(raw),before);
});

test('unavailable normals cannot poison or crash a live stroke',()=>{
 const raw=[{x:0,y:0,z:1},undefined,null,{x:NaN,y:0,z:1},{x:0,y:1,z:0}];
 for(let i=0;i<13;i++)assert.ok(Object.values(normalAt(raw,i,13)).every(Number.isFinite));
 assert.deepEqual(normalAt([],0,1),{x:0,y:0,z:1});
});

test('curved live input with resampled normals reaches the native renderer at its full extent',()=>{
 const count=52,raw=[{x:0,y:-.8,z:.6},{x:0,y:0,z:1},{x:0,y:.8,z:.6}];
 const points=Array.from({length:count},(_,i)=>{const angle=-1.1+2.2*i/(count-1);return {x:0,y:2*Math.sin(angle),z:2*Math.cos(angle)};});
 const normals=points.map((_,i)=>normalAt(raw,i,count));
 const {body}=strokeRequest({points,normals,size:.3,color:[255,255,0,1]},'paint',.01,{preview:true});
 assert.equal(body.points.length,count);assert.ok(body.points.flat().every(Number.isFinite));
 assert.notEqual(body.points[0][1],body.points.at(-1)[1]);
});
