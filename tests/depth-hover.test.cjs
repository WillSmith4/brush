const {test}=require('node:test');
const assert=require('node:assert/strict');
const {surfaceHeight,hoverPositions}=require('../web/brush-runtime.js');
function packed(z){const value=Math.round(z*16777215);return new Uint8Array([value>>16,(value>>8)&255,value&255,255]);}
const frame={width:1,height:1,size:1},surface={encoding:'linear-camera-v3',near:.001,far:16,distance:8};
test('linear capture depth reconstructs the surface and rejects distant or invalid samples',()=>{
 assert.ok(Math.abs(surfaceHeight(frame,surface,packed((8-.1-.001)/(16-.001)),0,0,0)-.1)<1e-5);
 assert.equal(surfaceHeight(frame,surface,packed(0),0,0,0),null);
 assert.equal(surfaceHeight(frame,surface,packed(1),0,0,0),null);
 assert.equal(surfaceHeight(frame,surface,new Uint8Array(4),0,0,0),null);
 assert.equal(surfaceHeight(frame,{...surface,encoding:undefined},packed(.5),0,0,0),null);
 assert.equal(surfaceHeight(frame,{...surface,far:NaN},packed(.5),0,0,0),null);
});
test('hover preserves independent native outline contours and matches a tilted surface',()=>{
 const polygons=[[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]],[[-.1,-.1],[.1,-.1],[.1,.1],[-.1,.1]]];
 const vertices=hoverPositions(polygons,2,[1,0,0],[0,1,0]);
 assert.equal(vertices.length,16*3);assert.ok([...vertices].every((v,i)=>i%3!==2||v===0));
 assert.equal(Math.max(...vertices),1);assert.equal(Math.min(...vertices),-1);
 assert.throws(()=>hoverPositions([[[0,0],[NaN,1]]],1),/outline/);
});
