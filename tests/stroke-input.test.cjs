const {test} = require('node:test');
const assert = require('node:assert/strict');
const {strokeRequest, SHAPES} = require('../web/brush-runtime.js');

test('3D arc length and pressure are preserved when forming a Krita strip', () => {
  const attributes = {points: [{x:0,y:0,z:0},{x:3,y:0,z:0},{x:3,y:4,z:0}],
    size: 1, pressures: [0.2,0.5,1], color:[80,120,240,0.6]};
  const before = JSON.stringify(attributes);
  const result = strokeRequest(attributes, 'preset');
  assert.deepEqual(result.body.points.map(p => p[2]), [0.2,0.5,1]);
  assert.equal(result.body.points[2][0] - result.body.points[0][0], 7 * 128);
  assert.deepEqual(result.body.color,[80,120,240]);
  assert.equal(result.body.opacity,0.6);
  assert.equal(JSON.stringify(attributes),before);
  assert.ok(result.u[0] > 0 && result.u.at(-1) < 1);
});

test('long strokes remain bounded and keep both pressure endpoints', () => {
  const points=Array.from({length:15000},(_,i)=>({x:i,y:0,z:0}));
  const pressures=points.map((_,i)=>i/(points.length-1));
  const {body}=strokeRequest({points,pressures,size:0.1,color:[1,2,3,1]},'preset');
  assert.ok(body.width<=4096 && body.height<=1024);
  assert.equal(body.points.length,4096);
  assert.equal(body.points[0][2],0);
  assert.equal(body.points.at(-1)[2],1);
});

test('six verified identifiers remain selectable; malformed geometry is rejected', () => {
  assert.deepEqual(SHAPES,['POINTY','RECT','CUBE','MARKER','WIDEBRUSH','RIBBON']);
  assert.throws(()=>strokeRequest({points:[{x:0,y:0,z:0},{x:NaN,y:1,z:0}]},'preset'),/coordinates/);
});
