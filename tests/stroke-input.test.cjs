const {test} = require('node:test');
const assert = require('node:assert/strict');
const {strokeRequest, SHAPES} = require('../web/brush-runtime.js');

test('Krita receives the actual planar path, pressure, color, and opacity', () => {
  const attributes = {points: [{x:0,y:0,z:0},{x:3,y:0,z:0},{x:3,y:4,z:0}],
    size: 1, pressures: [0.2,0.5,1], color:[80,120,240,0.6]};
  const before = JSON.stringify(attributes);
  const result = strokeRequest(attributes, 'preset');
  assert.deepEqual(result.body.points.map(p => p[2]), [0.2,0.5,1]);
  assert.ok(Math.abs(result.body.points[2][0] - result.body.points[0][0] - 3 * result.frame.scale)<1e-8);
  assert.ok(Math.abs(result.body.points[2][1] - result.body.points[0][1] + 4 * result.frame.scale)<1e-8);
  assert.deepEqual(result.body.color,[80,120,240]);
  assert.equal(result.body.opacity,0.6);
  assert.equal(JSON.stringify(attributes),before);
  assert.ok(result.body.points[0][0]>0 && result.body.points.at(-1)[0]<result.body.width);
});

test('long strokes remain bounded and keep both pressure endpoints', () => {
  const points=Array.from({length:15000},(_,i)=>({x:i,y:0,z:0}));
  const pressures=points.map((_,i)=>i/(points.length-1));
  const {body}=strokeRequest({points,pressures,size:0.1,color:[1,2,3,1]},'preset');
  assert.ok(body.width<=4096 && body.height<=4096 && body.width*body.height<=2097152);
  assert.equal(body.points.length,4096);
  assert.equal(body.points[0][2],0);
  assert.equal(body.points.at(-1)[2],1);
});

test('six verified identifiers remain selectable; malformed geometry is rejected', () => {
  assert.deepEqual(SHAPES,['POINTY','RECT','CUBE','MARKER','WIDEBRUSH','RIBBON']);
  assert.throws(()=>strokeRequest({points:[{x:0,y:0,z:0},{x:NaN,y:1,z:0}]},'preset'),/coordinates/);
});

test('live and completed rendering share the same world-space diameter and pressure',()=>{
 const attributes={points:[{x:0,y:0,z:0},{x:1,y:0,z:0}],size:.2,color:[10,20,30,1],pressures:[.4,1]};
 const live=strokeRequest(attributes,'preset',.01,{preview:true}),final=strokeRequest(attributes,'preset');
 assert.deepEqual(live.body,final.body);
 assert.deepEqual(live.frame,final.frame);
 assert.ok(Math.abs(live.body.size/live.frame.scale-attributes.size)<1e-10);
 assert.ok(Math.abs(final.body.size/final.frame.scale-attributes.size)<1e-10);
 assert.deepEqual(live.body.points.map(p=>p[2]),final.body.points.map(p=>p[2]));
});
