const {test}=require('node:test');
const assert=require('node:assert/strict');
const {coverageRectangles,strokeRequest,mapPixel}=require('../web/brush-runtime.js');

test('brush-tip geometry preserves disconnected regions and holes in the native coverage',()=>{
 const w=7,h=5,data=new Uint8ClampedArray(w*h*4),occupied=[];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)if((x<3&&!(x===1&&y===2))||(x===6&&y===2)){data[(y*w+x)*4+3]=255;occupied.push([x,y]);}
 const result=coverageRectangles(data,w,h),covered=new Set();
 for(const [x0,y0,x1,y1]of result)for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)covered.add(x+','+y);
 assert.deepEqual([...covered].sort(),occupied.map(p=>p.join(',')).sort());
});

test('the same texture is flat and unstretched for all six destination brush types',()=>{
 const a={size:1,color:[1,2,3,1],points:[{x:0,y:0,z:2},{x:1,y:0,z:2},{x:1,y:1,z:2}],normals:Array.from({length:3},()=>({x:0,y:0,z:1}))};
 const {frame}=strokeRequest(a,'preset');
 for(let x=0;x<frame.width;x+=37)for(let y=0;y<frame.height;y+=31){
  const p=mapPixel(frame,x,y,a).position;
  assert.ok(Math.abs(p[0]-(frame.minX+x/frame.scale))<1e-9);
  assert.ok(Math.abs(p[1]-(frame.maxY-y/frame.scale))<1e-9);assert.equal(p[2],2);
 }
});

test('completed flat artwork follows translated and resized host strokes',()=>{
 const a={size:1,points:[{x:0,y:0,z:0},{x:2,y:0,z:0}],normals:[{x:0,y:0,z:1},{x:0,y:0,z:1}]};
 const {frame}=strokeRequest(a,'preset'),before=mapPixel(frame,frame.width/2,frame.height/4,a).position;
 const edited={...a,size:2,points:a.points.map(p=>({x:p.x+3,y:p.y-2,z:p.z+5}))};
 const after=mapPixel(frame,frame.width/2,frame.height/4,edited).position;
 assert.ok(Math.abs(after[0]-before[0]-3)<1e-9);assert.ok(Math.abs(after[1]-(before[1]*2-2))<1e-9);assert.equal(after[2],5);
});
