const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const THREE=require(process.env.FEATHER_TEST_THREE || 'three');
const runtime=fs.readFileSync(path.join(__dirname,'../web/brush-runtime.js'),'utf8');
const clone=o=>JSON.parse(JSON.stringify(o));
const tick=()=>new Promise(r=>setImmediate(r));
async function settled(){for(let i=0;i<12;i++)await tick();}
function fixture(store=new Map(),deferRender,deferOutline,extraApi={}){
 const requests=[],errors=[],pixelPackets=new Map(),streams=new Map();let pixelSequence=0;
 class Image {set src(value){Object.assign(this,JSON.parse(Buffer.from(value.split(',')[1],'base64').toString()));}async decode(){}}
 const context={console,setTimeout,clearTimeout,queueMicrotask,Image,CustomEvent:class{},dispatchEvent(){},document:{readyState:'complete',createElement(){
  let image;return {getContext(){return {clearRect(){},drawImage(i){image=i;},getImageData(){const data=new Uint8ClampedArray(image.width*image.height*4);if(image.depthSplit){for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){const height=x<image.width/2?0:1.5,z=(8-height-.001)/(16-.001),value=Math.round(z*16777215),at=(y*image.width+x)*4;data.set([value>>16,(value>>8)&255,value&255,255],at);}return {data};}for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)if(image.tip==='rect'||(x/image.width-.5)**2+(y/image.height-.5)**2<.22)data[(y*image.width+x)*4+3]=255;return {data};}}}};
 }},webkit:{messageHandlers:{FeatherKrita:{async postMessage(body){
   requests.push(clone(body));
   if(body.command==='error')errors.push(body.message);
   if(body.command==='saveStroke'){store.set(body.id,clone(body.record));return {ok:true};}
   if(body.command==='loadStroke')return {ok:true,record:store.has(body.id)?clone(store.get(body.id)):null};
   if(body.command==='presetInfo'){
    if(deferOutline)await deferOutline;
    return {ok:true,extent:1,samplesBackdrop:false,strokeStreaming:extraApi.nativeStreaming?1:undefined,previewPixels:!!extraApi.nativePixels,previewSessions:!!extraApi.nativeSessions,outline:body.preset==='rect'?[[[-.5,-.25],[.5,-.25],[.5,.25],[-.5,.25]]]:[[[0,-.5],[.5,0],[0,.5],[-.5,0]]]};
   }
   if(body.command==='selectPreset')return {ok:true,bindings:{RECT:'saved'}};
   if(body.command==='render'){
    if(body.previewEnd){streams.delete(body.previewSession);return {ok:true,closed:true};}
    if(deferRender)await deferRender;
    if(body.streamFrom!==undefined){
     if(body.streamBegin){assert.ok(!streams.has(body.previewSession));streams.set(body.previewSession,{count:0,points:[]});}
     const state=streams.get(body.previewSession);assert.ok(state);assert.equal(body.streamFrom,state.count);assert.ok(body.points.length<=64);
     state.count+=body.points.length;state.points.push(...body.points);
     const x=Math.floor(state.points[0][0]/256)*256,y=Math.floor(state.points[0][1]/256)*256;
     if(body.streamFinish){const png=Buffer.from(JSON.stringify({width:256,height:256,tip:'rect'})).toString('base64');streams.delete(body.previewSession);return {ok:true,width:256,height:256,png,coverage:png,composited:false,streamCount:state.count,streamX:x,streamY:y,streamScale:1};}
     if(extraApi.quietStreaming)return {ok:true,tiles:[],pixels:'',streamCount:state.count,pendingTiles:false,composited:false};
     const token='00000000-0000-4000-8000-'+String(++pixelSequence).padStart(12,'0')+'.rgba',n=258*258,bytes=new Uint8Array(n*5);for(let i=0;i<n;i++)bytes.set([50,100,200,255],i*4);bytes.fill(255,n*4);pixelPackets.set(token,bytes);
     return {ok:true,tiles:[{x:x-1,y:y-1,width:258,height:258,offset:0}],pixels:token,streamCount:state.count,pendingTiles:false,composited:false};
    }
    if(body.previewPixels){
     const token='00000000-0000-4000-8000-'+String(++pixelSequence).padStart(12,'0')+'.rgba',n=body.width*body.height,bytes=new Uint8Array(n*5);
     for(let i=0;i<n;i++)bytes.set([Math.floor(i/body.width)%256,i%body.width%256,80,128],i*4);bytes.fill(255,n*4);
     pixelPackets.set(token,bytes);return {ok:true,width:body.width,height:body.height,pixels:token,composited:false};
    }
    const png=Buffer.from(JSON.stringify({width:body.width,height:body.height,tip:body.preset,input:JSON.stringify(body)})).toString('base64');
    return {ok:true,width:body.width,height:body.height,png,coverage:png,composited:false};
   }
   return {ok:true};
 }}}}};
 if(extraApi.nativePixels||extraApi.nativeStreaming)context.fetch=async url=>{const token=url.split('/').at(-1),bytes=pixelPackets.get(token);pixelPackets.delete(token);return {ok:!!bytes,arrayBuffer:async()=>extraApi.invalidPixels?new ArrayBuffer(5):bytes.buffer};};
 vm.createContext(context);vm.runInContext(runtime,context);
 class Manager{
  constructor(){this.sceneGroup=new THREE.Group();this.curveIdToGeomInfo=new Map();this.geoms=new Map();}
  makeCurves(curves=[]){for(const {id,attributes}of curves)this.makeCurve(id,attributes);}
  makeCurve(id,attributes){
   const geometry=new THREE.BufferGeometry(),positions=[];
   for(const p of attributes.points)for(const [dy,dz]of [[-.5,-.25],[.5,-.25],[.5,.25],[-.5,.25]])positions.push(p.x,p.y+dy,p.z+dz);
   geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
   geometry.setAttribute('color',new THREE.Uint8BufferAttribute(new Uint8Array(attributes.points.length*16).fill(255),4));
   geometry.setIndex(Array.from({length:(attributes.points.length-1)*24+12},(_,i)=>i%(attributes.points.length*4)));
   const material=new THREE.ShaderMaterial({vertexShader:'void main() {gl_Position=vec4(position,1.0);}',fragmentShader:'varying vec4 vColor;void main() {vec4 diffuseColor = vColor;gl_FragColor=diffuseColor;}'});
   const mesh=new THREE.Mesh(geometry,material);this.sceneGroup.add(mesh);
   const info={numOfPoints:attributes.points.length,geomAttributes:0,geomIndex:0,attributes:clone(attributes)};
   this.curveIdToGeomInfo.set(id,info);this.geoms.set(info,{geometry,mesh});return this.geoms.get(info);
  }
  updateCurve(info,attributes){info.attributes=clone(attributes);}
  copyCurveGeom(){}removeCurves(){}
  removeCurve(id){const info=this.curveIdToGeomInfo.get(id);this.geoms.get(info)?.mesh.removeFromParent();this.curveIdToGeomInfo.delete(id);}
  clear(){for(const {mesh}of this.geoms.values())mesh.removeFromParent();this.curveIdToGeomInfo.clear();}
  turnOnOff(on){for(const {geometry}of this.geoms.values())geometry.setDrawRange(0,on?geometry.index.count:0);}
  timelapse(count){for(const {geometry}of this.geoms.values())geometry.setDrawRange(0,count);}
  getGeomFromInfo(info){return this.geoms.get(info);}
 }
 context.FeatherKrita.attach(Manager,{Geometry:THREE.BufferGeometry,Attribute:THREE.BufferAttribute,Mesh:THREE.Mesh,LineSegments:THREE.LineSegments,Vector3:THREE.Vector3,ShaderMaterial:THREE.ShaderMaterial,Texture:THREE.Texture,LinearFilter:THREE.LinearFilter,fallbackSize:.01,...extraApi});
 const attributes={shape:'RECT',size:1,color:[50,100,200,.75],pressures:[.2,.5,1],points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:2,y:0,z:0}],normals:[{x:0,y:0,z:1},{x:0,y:0,z:1},{x:0,y:0,z:1}]};
 const manager=new Manager(),fk=context.FeatherKrita;
 function draw(id,a=attributes){fk.birth(id,a);manager.makeCurve(id,a);}
 return {context,manager,fk,attributes,draw,requests,errors,store,pixelPackets,streams};
}
test('Inject affects only new strokes; Restore retains Krita artwork and permits new original strokes',async()=>{
 const {fk,manager,draw,attributes,errors,requests,store}=fixture();
 draw('before');await settled();const old=manager.getGeomFromInfo(manager.curveIdToGeomInfo.get('before')).geometry;
 const original=Array.from(old.attributes.position.array);
 fk.setBindings({RECT:'circle'});await settled();assert.equal(manager.sceneGroup.children.length,1);
 draw('painted');await settled();assert.deepEqual(errors,[]);assert.equal(manager.sceneGroup.children.length,3);
 const replacement=manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);
 assert.ok(replacement);assert.ok(Array.from(replacement.geometry.attributes.position.array).every((v,i)=>i%3!==2||v===0));
 assert.equal(old.attributes.fkHide,undefined);assert.deepEqual(Array.from(old.attributes.position.array),original);
 const pixels=store.get('painted').result.png;
 fk.setBindings({});assert.equal(manager.sceneGroup.children.length,3);assert.equal(store.get('painted').result.png,pixels);
 draw('after');await settled();assert.equal(manager.sceneGroup.children.length,4);
 assert.equal(requests.filter(r=>r.command==='render').length,1);assert.equal(store.has('before'),false);assert.equal(store.has('after'),false);
});
test('different injected tips keep independent flat footprints after both bindings are restored',async()=>{
 const {fk,draw,manager,store}=fixture();
 fk.setBindings({RECT:'circle'});draw('circle');await settled();
 const circular=manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV).geometry.index.count;
 fk.setBindings({RECT:'rect'});draw('rect');await settled();fk.setBindings({});
 assert.equal(store.get('circle').preset,'circle');assert.equal(store.get('rect').preset,'rect');
 const geoms=manager.sceneGroup.children.filter(m=>m.geometry.attributes.fkUV).map(m=>m.geometry);
 assert.equal(geoms.length,2);assert.ok(geoms.some(g=>g.index.count!==circular));
});
test('undo/redo and reopening retain baked paint with no active binding or native rerender',async()=>{
 const first=fixture();first.fk.setBindings({RECT:'rect'});first.draw('saved');await settled();first.fk.setBindings({});
 first.manager.removeCurve('saved');await settled();assert.equal(first.manager.sceneGroup.children.length,0);
 first.manager.makeCurve('saved',first.attributes);await settled();assert.equal(first.manager.sceneGroup.children.length,2);
 const reopened=fixture(first.store);reopened.manager.makeCurve('saved',reopened.attributes);await settled();
 assert.deepEqual(reopened.errors,[]);assert.equal(reopened.manager.sceneGroup.children.length,2);
 assert.equal(reopened.requests.filter(r=>r.command==='render'||r.command==='presetInfo').length,0);
});
test('Restore during native rendering keeps the committed new stroke',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=fixture(new Map(),pending);
 f.fk.setBindings({RECT:'rect'});f.draw('pending');await tick();f.fk.setBindings({});release();await settled();
 assert.deepEqual(f.errors,[]);assert.equal(f.manager.sceneGroup.children.length,2);assert.ok(f.store.get('pending').result);
});
test('a delayed renderer result cannot reappear after undo',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=fixture(new Map(),pending);
 f.fk.setBindings({RECT:'rect'});f.draw('pending');await tick();f.manager.removeCurve('pending');release();await settled();
 assert.equal(f.manager.sceneGroup.children.length,0);
 f.manager.makeCurve('pending',f.attributes);await settled();assert.equal(f.manager.sceneGroup.children.length,2);
});
test('copies inherit baked artwork while visibility, timelapse, and edits still apply',async()=>{
 const f=fixture();f.fk.setBindings({RECT:'rect'});f.draw('source');await settled();f.fk.setBindings({});
 f.fk.inherit('copy','source');const moved=clone(f.attributes);moved.points.forEach(p=>p.z+=4);f.manager.makeCurve('copy',moved);await settled();
 assert.equal(f.requests.filter(r=>r.command==='render').length,1);assert.ok(f.store.get('copy').result);
 const replacements=()=>f.manager.sceneGroup.children.filter(m=>m.geometry.attributes.fkUV);
 assert.equal(replacements().length,2);assert.ok(replacements().some(m=>m.geometry.attributes.position.getZ(0)===4));
 f.manager.turnOnOff(false);assert.ok(replacements().every(m=>m.geometry.drawRange.count===0));
 f.manager.turnOnOff(true);assert.ok(replacements().every(m=>m.geometry.drawRange.count>0));
 f.manager.timelapse(24);assert.ok(replacements().every(m=>m.geometry.drawRange.count<m.geometry.index.count));
});

test('Pencil hover uses the imported outline, scales with brush size, and Restore unmasks Feather',async()=>{
 const f=fixture();f.manager.makeCurve('cursor',f.attributes);await settled();
 const {mesh,geometry}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('cursor'));
 const original=Array.from(geometry.attributes.position.array);
 f.fk.setBindings({RECT:'rect'});f.fk.hover(mesh,f.attributes,.2);await settled();
 assert.deepEqual(f.errors,[]);assert.equal(mesh.children.length,1);const line=mesh.children[0];
 assert.equal(line.isLineSegments,true);assert.equal(line.geometry.attributes.position.count,8);
 line.geometry.computeBoundingBox();assert.ok(Math.abs(line.geometry.boundingBox.max.x-line.geometry.boundingBox.min.x-1)<1e-6);
 assert.ok(geometry.attributes.fkHide.array.every(x=>x===1));
 assert.equal(line.material.uniforms.fkHoverOpacity.value,.8);
 f.fk.hover(mesh,{...f.attributes,size:2},.5);await settled();line.geometry.computeBoundingBox();
 assert.ok(Math.abs(line.geometry.boundingBox.max.x-line.geometry.boundingBox.min.x-2)<1e-6);
 assert.equal(line.material.uniforms.fkHoverOpacity.value,.5);
 assert.equal(f.requests.filter(r=>r.command==='presetInfo').length,1);
 f.fk.setBindings({});assert.equal(mesh.children.length,0);assert.ok(geometry.attributes.fkHide.array.every(x=>x===0));
 assert.deepEqual(Array.from(geometry.attributes.position.array),original);
 assert.equal(f.requests.filter(r=>r.command==='saveStroke').length,0);
 assert.equal(f.requests.filter(r=>r.command==='render').length,0);
});

test('switching injected presets changes the hover outline without changing the host tip',async()=>{
 const f=fixture();f.manager.makeCurve('cursor',f.attributes);await settled();
 const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('cursor'));
 f.fk.setBindings({RECT:'rect'});f.fk.hover(mesh,f.attributes);await settled();const first=Array.from(mesh.children[0].geometry.attributes.position.array);
 f.fk.setBindings({RECT:'diamond'});await settled();const second=Array.from(mesh.children[0].geometry.attributes.position.array);
 assert.notDeepEqual(first,second);assert.equal(f.requests.filter(r=>r.command==='presetInfo').length,2);
 mesh.visible=false;assert.equal(mesh.children[0].parent.visible,false);
 f.fk.hoverEnd(mesh);assert.equal(mesh.children.length,0);assert.equal(mesh.visible,false);
 assert.deepEqual(f.errors,[]);
});

test('a delayed native outline cannot return after Restore or Pencil-down',async()=>{
 let release;const pending=new Promise(r=>release=r),f=fixture(new Map(),null,pending);
 f.manager.makeCurve('cursor',f.attributes);await settled();const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('cursor'));
 f.fk.setBindings({RECT:'rect'});f.fk.hover(mesh,f.attributes);f.fk.setBindings({});f.fk.hoverEnd(mesh);release();await settled();
 assert.equal(mesh.children.length,0);assert.equal(mesh.visible,false);assert.deepEqual(f.errors,[]);
});

test('saved v2 blending keeps its pixels but never loads its corrupt depth map',async()=>{
 const first=fixture();first.fk.setBindings({RECT:'rect'});first.draw('legacy');await settled();
 const saved=first.store.get('legacy'),png=saved.result.png;
 saved.surface={depth:'invalid-legacy-depth',distance:8,near:.001,far:16};saved.result.composited=true;
 const f=fixture(first.store);f.manager.makeCurve('legacy',f.attributes);await settled();
 assert.deepEqual(f.errors,[]);assert.equal(f.requests.filter(r=>r.command==='render'||r.command==='saveStroke').length,0);
 const flat=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);
 assert.ok(flat);assert.ok(Array.from(flat.geometry.attributes.position.array).every((v,i)=>i%3!==2||v===0));
 assert.equal(first.store.get('legacy').result.png,png);
});

test('separate substrate depths never form long bridging triangles',async()=>{
 const first=fixture();first.fk.setBindings({RECT:'rect'});first.draw('layers');await settled();
 const saved=first.store.get('layers'),{width,height}=saved.result;
 saved.surface={encoding:'linear-camera-v3',distance:8,near:.001,far:16,depth:Buffer.from(JSON.stringify({width,height,depthSplit:true})).toString('base64')};
 saved.result.composited=true;
 const f=fixture(first.store);f.manager.makeCurve('layers',f.attributes);await settled();assert.deepEqual(f.errors,[]);
 for(let i=0;i<200&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
 const surface=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);assert.ok(surface);
 const {index,attributes:{position}}=surface.geometry;assert.ok(index.count>0);
 for(let i=0;i<index.count;i+=3){const zs=[0,1,2].map(k=>position.getZ(index.getX(i+k)));assert.ok(Math.max(...zs)-Math.min(...zs)<.01);}
});

test('drawing ordinary Feather strokes does not rebuild any existing Krita surfaces',async()=>{
 const f=fixture();f.fk.setBindings({RECT:'rect'});f.draw('krita');await settled();
 const original=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);assert.ok(original);
 let disposed=0;original.geometry.addEventListener('dispose',()=>disposed++);
 f.fk.setBindings({});for(let i=0;i<40;i++)f.draw('ordinary-'+i);
 await settled();assert.equal(disposed,0);assert.ok(f.manager.sceneGroup.children.includes(original));
 assert.equal(f.requests.filter(r=>r.command==='render').length,1);assert.deepEqual(f.errors,[]);
});

test('editing one Krita stroke keeps all unrelated meshes and textures',async()=>{
 const f=fixture();f.fk.setBindings({RECT:'rect'});f.draw('one');await settled();f.draw('two');await settled();
 const meshes=f.manager.sceneGroup.children.filter(m=>m.geometry.attributes.fkUV),info=f.manager.curveIdToGeomInfo.get('one');
 assert.equal(meshes.length,2);let disposed=0;meshes.forEach(m=>m.geometry.addEventListener('dispose',()=>disposed++));
 f.manager.updateCurve(info,{...f.attributes,size:2});await settled();
 assert.equal(disposed,1);assert.ok(f.manager.sceneGroup.children.includes(meshes[1]));
});

test('live Krita texture becomes visible before Pencil-up even with continuous input',async()=>{
 let release;const pending=new Promise(r=>release=r),f=fixture(new Map(),pending);
 f.manager.makeCurve('live',f.attributes);await settled();const {mesh,geometry}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));
 geometry.setDrawRange(0,60);f.fk.setBindings({RECT:'rect'});
 f.fk.preview(mesh,f.attributes);assert.ok(geometry.attributes.fkHide.array.every(v=>v===1));
 await new Promise(r=>setTimeout(r,5));
 for(let i=0;i<15;i++)f.fk.preview(mesh,{...f.attributes,points:f.attributes.points.map(p=>({...p,x:p.x+i*.001}))});
 release();for(let i=0;i<200&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));assert.deepEqual(f.errors,[]);
 // Only the in-flight render and newest queued update are needed, not 16 jobs.
 assert.ok(f.requests.filter(r=>r.command==='render'&&r.points.length>1).length<=2);
 assert.equal(f.requests.filter(r=>r.command==='render'&&r.points.length===1).length,0);
 geometry.setDrawRange(0,0);f.fk.preview(mesh,{});await new Promise(r=>setTimeout(r,20));
 assert.ok(!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));
 assert.ok(geometry.attributes.fkHide.array.every(v=>v===0));
 assert.equal(f.requests.filter(r=>r.command==='saveStroke').length,0);
});

test('ordinary live drawing does not invoke Krita or mask the Feather brush',async()=>{
 const f=fixture();f.manager.makeCurve('live',f.attributes);const {mesh,geometry}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));geometry.setDrawRange(0,60);
 f.fk.preview(mesh,f.attributes);await settled();assert.equal(geometry.attributes.fkHide,undefined);
 assert.equal(f.requests.filter(r=>r.command==='render'||r.command==='presetInfo').length,0);
});

test('injected presets receive normalized Pencil pressure without Feather shape scaling',()=>{
 const f=fixture();assert.equal(f.fk.pressureInput([.2,.8],3,'RECT'),undefined);
 f.fk.setBindings({RECT:'rect',CUBE:'rect'});
 assert.deepEqual(Array.from(f.fk.pressureInput([.2,.8],3,'RECT')),[.2,.5,.8]);
 assert.deepEqual(Array.from(f.fk.pressureInput([.2,.8],3,'CUBE')),[.2,.5,.8]);
 assert.deepEqual(Array.from(f.fk.pressureInput([.2,.8],3,'RECT',false)),[]);
});

test('geometry construction yields to input and saving a completed stroke does not gate its display',async()=>{
 const f=fixture();let releaseSave;const blocked=new Promise(r=>releaseSave=r),post=f.context.webkit.messageHandlers.FeatherKrita.postMessage;
 f.context.webkit.messageHandlers.FeatherKrita.postMessage=async body=>{const result=await post(body);if(body.command==='saveStroke'&&body.record.result)await blocked;return result;};
 const long={...f.attributes,points:Array.from({length:100},(_,i)=>({x:i*.1,y:Math.sin(i*.04),z:0})),normals:Array.from({length:100},()=>({x:0,y:0,z:1}))};
 f.fk.setBindings({RECT:'rect'});let heartbeats=0;const timer=setInterval(()=>heartbeats++,1);f.draw('big',long);
 for(let i=0;i<400&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
 clearInterval(timer);releaseSave();assert.ok(heartbeats>1);assert.ok(f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));assert.deepEqual(f.errors,[]);
});

test('native preview and committed paint receive identical render requests and show identical results',async()=>{
 for(const preset of ['rect','masking-brush','charcoal-dynamics']){
  const f=fixture();f.manager.makeCurve('live',f.attributes);await settled();const {mesh,geometry}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));geometry.setDrawRange(0,60);
  f.fk.setBindings({RECT:preset});f.fk.preview(mesh,f.attributes);
  for(let i=0;i<200&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
  const shown=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);assert.ok(shown);
  const liveInput=shown.material.uniforms.fkBrush.value.image.input;
  geometry.setDrawRange(0,0);f.fk.preview(mesh,{});f.draw('committed');await settled();
  const completed=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);assert.ok(completed);
  assert.equal(completed.material.uniforms.fkBrush.value.image.input,liveInput);
  const renders=f.requests.filter(r=>r.command==='render');assert.equal(renders.length,2);assert.deepEqual(renders[0],renders[1]);
  assert.ok(renders.every(r=>r.points.length===3));assert.deepEqual(f.errors,[]);
 }
});

test('while a new native prefix is delayed the previous native result remains unchanged and visible',async()=>{
 const f=fixture();f.manager.makeCurve('live',f.attributes);await settled();const {mesh,geometry}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));geometry.setDrawRange(0,60);
 f.fk.setBindings({RECT:'rect'});f.fk.preview(mesh,f.attributes);
 for(let i=0;i<200&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
 const first=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV),before=Array.from(first.geometry.attributes.position.array),texture=first.material.uniforms.fkBrush.value;
 let release;const delayed=new Promise(r=>release=r),post=f.context.webkit.messageHandlers.FeatherKrita.postMessage;
 f.context.webkit.messageHandlers.FeatherKrita.postMessage=async body=>{if(body.command==='render')await delayed;return post(body);};
 for(let i=0;i<10;i++)f.fk.preview(mesh,{...f.attributes,points:f.attributes.points.map(p=>({...p,y:p.y+i*.1*p.x}))});
 await tick();assert.ok(first.visible&&first.parent);assert.equal(first.material.uniforms.fkBrush.value,texture);assert.deepEqual(Array.from(first.geometry.attributes.position.array),before);
 release();for(let i=0;i<200&&first.material.uniforms.fkBrush.value===texture;i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(first.parent);assert.notEqual(first.material.uniforms.fkBrush.value,texture);
 geometry.setDrawRange(0,0);f.fk.preview(mesh,{});await new Promise(r=>setTimeout(r,30));
 assert.ok(!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));assert.deepEqual(f.errors,[]);
});

test('unchanged live fragments are cached and growing previews reuse their mesh and buffers',async()=>{
 const f=fixture();f.manager.makeCurve('live',f.attributes);await settled();
 const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));
 mesh.geometry.setDrawRange(0,mesh.geometry.index.count);
 f.fk.setBindings({RECT:'rect'});f.fk.preview(mesh,f.attributes);
 const wait=async predicate=>{for(let i=0;i<300&&!predicate();i++)await new Promise(r=>setTimeout(r,5));assert.ok(predicate());};
 await wait(()=>f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));
 const paint=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV),geometry=paint.geometry,material=paint.material,buffer=geometry.attributes.position.array;
 const texture=material.uniforms.fkBrush.value,mask=material.uniforms.fkCoverage.value;let disposed=0;
 texture.addEventListener('dispose',()=>disposed++);mask.addEventListener('dispose',()=>disposed++);
 for(let i=0;i<25;i++)f.fk.preview(mesh,clone(f.attributes));
 await new Promise(r=>setTimeout(r,40));assert.equal(f.requests.filter(r=>r.command==='render').length,1);
 assert.equal(material.uniforms.fkBrush.value,texture);
 f.fk.preview(mesh,{...f.attributes,points:f.attributes.points.map(p=>({...p,x:p.x*1.5}))});
 await wait(()=>material.uniforms.fkBrush.value!==texture);
 assert.equal(f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV),paint);
 assert.equal(paint.geometry,geometry);assert.equal(paint.material,material);
 assert.ok(geometry.attributes.position.array.length>=buffer.length);
 assert.equal(disposed,2);assert.ok(geometry.drawRange.count>0&&geometry.drawRange.count<=geometry.index.count);assert.deepEqual(f.errors,[]);
 const capacity=geometry.attributes.position.array,secondTexture=material.uniforms.fkBrush.value;
 f.fk.preview(mesh,{...f.attributes,points:f.attributes.points.map(p=>({...p,x:p.x*1.2}))});
 await wait(()=>material.uniforms.fkBrush.value!==secondTexture);assert.equal(geometry.attributes.position.array,capacity);
 const next=material.uniforms.fkBrush.value;next.addEventListener('dispose',()=>disposed++);
 mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});assert.equal(disposed,3);
});

test('nonplanar live geometry yields during construction and can be cancelled without reviving paint',async()=>{
 const f=fixture(),a={...f.attributes,size:.2,pressures:[],points:[],normals:[]};
 for(let i=0;i<1200;i++){const t=i*.025;a.points.push({x:3*Math.cos(t),y:3*Math.sin(t),z:.1*Math.sin(t*3)});a.normals.push({x:0,y:0,z:1});}
 f.manager.makeCurve('live',a);await settled();const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));
 f.fk.setBindings({RECT:'rect'});let beats=0;const timer=setInterval(()=>beats++,1);f.fk.preview(mesh,a);
 for(let i=0;i<600&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
 clearInterval(timer);assert.ok(beats>2);assert.ok(f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));
 f.fk.preview(mesh,{...a,size:.3});await tick();mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});
 await new Promise(r=>setTimeout(r,150));assert.ok(!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));assert.deepEqual(f.errors,[]);
});

test('transparent paint does not write depth and preserves its layer order after redraw',async()=>{
 const f=fixture();f.fk.setBindings({RECT:'rect'});f.draw('first');await settled();f.draw('second');await settled();
 const meshes=f.manager.sceneGroup.children.filter(m=>m.geometry.attributes.fkUV);
 assert.equal(meshes.length,2);assert.ok(meshes.every(m=>!m.material.depthWrite&&m.material.depthTest&&m.material.forceSinglePass));
 assert.ok(meshes[0].renderOrder<meshes[1].renderOrder);
 const orders=meshes.map(m=>m.renderOrder);f.manager.clear();await settled();
 f.manager.makeCurve('second',f.attributes);f.manager.makeCurve('first',f.attributes);await settled();
 const recreated=f.manager.sceneGroup.children.filter(m=>m.geometry.attributes.fkUV).map(m=>m.renderOrder).sort((a,b)=>a-b);
 assert.deepEqual(recreated,orders);
});

test('reopening different-colored strokes preserves saved drawing order even when loading is reversed',async()=>{
 const first=fixture();first.fk.setBindings({RECT:'rect'});
 first.draw('red',{...first.attributes,color:[255,0,0,.5]});await settled();
 first.draw('blue',{...first.attributes,color:[0,0,255,.5]});await settled();
 const expected=[first.store.get('red').paintOrder,first.store.get('blue').paintOrder];assert.ok(expected[0]<expected[1]);
 const opened=fixture(first.store);
 opened.manager.makeCurve('blue',{...opened.attributes,color:[0,0,255,.5]});
 opened.manager.makeCurve('red',{...opened.attributes,color:[255,0,0,.5]});await settled();
 const layers=opened.manager.sceneGroup.children.filter(m=>m.geometry.attributes.fkUV).sort((a,b)=>a.renderOrder-b.renderOrder);
 assert.deepEqual(layers.map(m=>m.renderOrder),expected);
 assert.deepEqual(Array.from(layers[0].material.uniforms.fkBaseColor.value),[1,0,0,.5]);
 assert.deepEqual(Array.from(layers[1].material.uniforms.fkBaseColor.value),[0,0,1,.5]);
});

test('densified live normals use the same native raster frame as raw normals in the committed stroke',async()=>{
 const f=fixture(),raw=[{x:0,y:0,z:1},{x:0,y:.6,z:.8},{x:0,y:0,z:1}];
 const points=Array.from({length:7},(_,i)=>({x:i/3,y:Math.sin(i*.4)*.1,z:0}));
 const final={...f.attributes,points,normals:raw,pressures:[]};
 f.manager.makeCurve('live',final);await settled();const {mesh,geometry}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));geometry.setDrawRange(0,geometry.index.count);
 f.fk.setBindings({RECT:'rect'});
 const dense=points.map((_,i)=>f.fk.normalAt(raw,i,points.length));f.fk.preview(mesh,{...final,normals:dense,renderNormals:raw});
 for(let i=0;i<200&&!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV);i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));
 geometry.setDrawRange(0,0);f.fk.preview(mesh,{});f.draw('finished',final);await settled();
 const requests=f.requests.filter(r=>r.command==='render');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(f.errors,[]);
});

test('busy direct preview coalesces thousands of Pencil events without rebuilding the host tube or reprojecting',async()=>{
 let release;const waiting=new Promise(r=>release=r);let projections=0,notifications=0;
 const brush={shape:'RECT',size:1,color:[50,100,200],opacity:.75,pressureParameter:'OFF',materialStyle:{type:'FLAT',pattern:'NONE'}};
 let f;const state={meshes:[],pointsCacheMap:new Map(),normalCacheMap:new Map()},host={getState:()=>state};
 const extra={nativeSessions:true,currentBrush:()=>brush,previewReady:p=>p.length>1,previewMirrors:()=>[new THREE.Matrix4()],previewShading:()=>false,notifyPreview:()=>notifications++,
  projectPreview(points){projections++;return {splinePointsArray:[points],normalsArray:[points.map(()=>new THREE.Vector3(0,0,1))]};},
  createPreview(){const {mesh}=f.manager.makeCurve('template'+state.meshes.length,f.attributes);mesh.geometry.setDrawRange(0,0);state.meshes.push(mesh);},
  previewMaterial:()=>new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=vec4(position,1.0);}',fragmentShader:'varying vec4 vColor;void main(){vec4 diffuseColor = vColor;gl_FragColor=diffuseColor;}'})};
 f=fixture(new Map(),waiting,null,extra);
 const points=Array.from({length:6000},(_,i)=>new THREE.Vector3(Math.cos(i*.01),Math.sin(i*.01),0));
 assert.equal(f.fk.inputPreview(host,{clientPointers:points,pressures:[]}),false);assert.equal(projections,0);
 f.fk.setBindings({RECT:'rect'});f.fk.inputPreview(host,{clientPointers:points.slice(0,3),pressures:[]});
 for(let i=0;i<200&&!f.requests.some(r=>r.command==='render');i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(projections,1);
 for(let i=0;i<2000;i++)f.fk.inputPreview(host,{clientPointers:points,pressures:[]});
 assert.equal(projections,1);assert.equal(f.requests.filter(r=>r.command==='render').length,1);
 release();
 for(let i=0;i<600&&!f.requests.some(r=>r.points?.length===4096);i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(projections,2);assert.equal(notifications,2);
 const renders=f.requests.filter(r=>r.command==='render'&&!r.previewEnd);assert.equal(renders.length,2);assert.equal(renders[0].previewSession,renders[1].previewSession);
 f.fk.endInputPreview(host);await new Promise(r=>setTimeout(r,150));
 assert.ok(f.requests.some(r=>r.previewEnd&&r.previewSession===renders[0].previewSession));
 assert.ok(!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));assert.deepEqual(f.errors,[]);
});

test('ending direct input before its scheduled work drops it and keeps original brushes untouched',async()=>{
 let projections=0;const state={meshes:[]},host={getState:()=>state};
 const brush={shape:'RECT'};const f=fixture(new Map(),null,null,{currentBrush:()=>brush,projectPreview(){projections++;throw Error('Cancelled work ran');},createPreview(){},previewReady:()=>true});
 f.fk.setBindings({RECT:'rect'});assert.equal(f.fk.inputPreview(host,{clientPointers:[],pressures:[]}),true);f.fk.endInputPreview(host);
 await new Promise(r=>setTimeout(r,25));assert.equal(projections,0);assert.deepEqual(f.errors,[]);
 f.fk.setBindings({});assert.equal(f.fk.inputPreview(host,{clientPointers:[],pressures:[]}),false);assert.equal(projections,0);
});

test('raw preview pixels reach GPU textures with correct row orientation and without a saved raw result',async()=>{
 const f=fixture(new Map(),null,null,{nativePixels:true});f.manager.makeCurve('live',f.attributes);await settled();
 const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));mesh.geometry.setDrawRange(0,60);
 f.fk.setBindings({RECT:'rect'});await f.fk.preview(mesh,f.attributes);
 const paint=f.manager.sceneGroup.children.find(m=>m.geometry.attributes.fkUV);assert.ok(paint);assert.deepEqual(f.errors,[]);
 const texture=paint.material.uniforms.fkBrush.value,mask=paint.material.uniforms.fkCoverage.value;
 assert.equal(texture.isDataTexture,true);assert.equal(texture.flipY,false);assert.equal(texture.image.data[0],(texture.image.height-1)%256);
 assert.equal(texture.image.data[(texture.image.height-1)*texture.image.width*4],0);
 assert.equal(mask.format,1028);assert.ok(mask.image.data.every(v=>v===255));assert.match(paint.material.fragmentShader,/fkCoverage, fkTexCoord\)\.r/);
 assert.equal(f.pixelPackets.size,0);assert.ok(f.requests.some(r=>r.previewPixels&&!r.previewSession));
 mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});f.draw('final');await settled();
 assert.ok(f.store.get('final').result.png);assert.equal(f.store.get('final').result.pixels,undefined);
 assert.ok(!f.requests.some(r=>r.previewEnd));
});

test('truncated raw packets are rejected before creating textures',async()=>{
 const f=fixture(new Map(),null,null,{nativePixels:true,invalidPixels:true});f.manager.makeCurve('live',f.attributes);await settled();
 const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));mesh.geometry.setDrawRange(0,60);f.fk.setBindings({RECT:'rect'});
 await f.fk.preview(mesh,f.attributes);assert.equal(f.errors.length,1);assert.match(f.errors[0],/pixel dimensions/);
 assert.ok(!f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});
});

test('one live native stroke appends each sample once and bakes that same stroke at Pencil-up',async()=>{
 const f=fixture(new Map(),null,null,{nativeStreaming:true});
 const points=Array.from({length:240},(_,i)=>({x:i/240,y:Math.sin(i*.03)*.1,z:0})),a={...f.attributes,points,normals:points.map(()=>({x:0,y:0,z:1})),pressures:[]};
 f.manager.makeCurve('live',a);await settled();const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));mesh.geometry.setDrawRange(0,6);f.fk.setBindings({RECT:'rect'});
 await f.fk.preview(mesh,{...a,points:points.slice(0,120),normals:a.normals.slice(0,120),sourceTemplate:true});
 await f.fk.preview(mesh,{...a,sourceTemplate:true});
 assert.deepEqual(f.errors,[]);const updates=f.requests.filter(r=>r.streamFrom!==undefined);assert.equal(updates.filter(r=>r.streamBegin).length,1);assert.equal(updates.reduce((n,r)=>n+r.points.length,0),237);
 assert.ok(updates.every(r=>r.points.length<=64));assert.equal(f.streams.size,1);assert.ok(f.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));
 f.fk.birth('saved-stream',a);mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});f.manager.makeCurve('saved-stream',a);
 for(let i=0;i<1000&&!f.store.get('saved-stream')?.result;i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(f.store.get('saved-stream')?.result?.png);assert.deepEqual(f.errors,[]);assert.equal(f.streams.size,0);
 const all=f.requests.filter(r=>r.streamFrom!==undefined);assert.equal(all.reduce((n,r)=>n+r.points.length,0),240);assert.equal(all.filter(r=>r.streamFinish).length,1);
 assert.ok(!f.requests.some(r=>r.command==='render'&&r.streamFrom===undefined&&!r.previewEnd));
 assert.equal(f.store.get('saved-stream').result.pixels,undefined);assert.equal(f.pixelPackets.size,0);
 const reopened=fixture(f.store);reopened.manager.makeCurve('saved-stream',a);await settled();assert.deepEqual(reopened.errors,[]);assert.ok(reopened.manager.sceneGroup.children.some(m=>m.geometry.attributes.fkUV));assert.ok(!reopened.requests.some(r=>r.command==='render'));
});

test('an uncommitted streaming stroke closes its native painter on cancellation',async()=>{
 const f=fixture(new Map(),null,null,{nativeStreaming:true});f.manager.makeCurve('live',f.attributes);await settled();const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));mesh.geometry.setDrawRange(0,6);f.fk.setBindings({RECT:'rect'});
 await f.fk.preview(mesh,{...f.attributes,sourceTemplate:true});assert.equal(f.streams.size,1);mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});await settled();assert.equal(f.streams.size,0);assert.ok(f.requests.some(r=>r.previewEnd));assert.deepEqual(f.errors,[]);
});

test('a growing 6000-sample gesture never resubmits earlier native samples or expands a batch',async()=>{
 const f=fixture(new Map(),null,null,{nativeStreaming:true,quietStreaming:true});const points=Array.from({length:6000},(_,i)=>({x:Math.cos(i*.02),y:Math.sin(i*.02),z:0}));
 const a={...f.attributes,points,normals:points.map(()=>({x:0,y:0,z:1})),pressures:points.map((_,i)=>.1+.9*(i%100)/99)};
 f.manager.makeCurve('live',a);await settled();const {mesh}=f.manager.getGeomFromInfo(f.manager.curveIdToGeomInfo.get('live'));mesh.geometry.setDrawRange(0,6);f.fk.setBindings({RECT:'rect'});
 for(const count of [200,500,1000,2000,4000,6000])await f.fk.preview(mesh,{...a,points:points.slice(0,count),normals:a.normals.slice(0,count),pressures:a.pressures.slice(0,count),sourceTemplate:true});
 const calls=f.requests.filter(r=>r.streamFrom!==undefined),samples=calls.flatMap(r=>r.points);
 assert.equal(samples.length,5997);assert.equal(calls.filter(r=>r.streamBegin).length,1);assert.ok(calls.every(r=>r.points.length<=64));
 assert.deepEqual(samples.map(p=>p[3]),samples.map((_,i)=>i*8));assert.deepEqual(samples.map(p=>p[2]),a.pressures.slice(0,5997));assert.deepEqual(f.errors,[]);
 mesh.geometry.setDrawRange(0,0);f.fk.preview(mesh,{});await settled();assert.equal(f.streams.size,0);
});
