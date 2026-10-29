const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const THREE=require(process.env.FEATHER_TEST_THREE || 'three');
const runtime=fs.readFileSync(path.join(__dirname,'../web/brush-runtime.js'),'utf8');
const clone=o=>JSON.parse(JSON.stringify(o));
const tick=()=>new Promise(r=>setImmediate(r));
async function settled(){for(let i=0;i<12;i++)await tick();}
function fixture(store=new Map(),deferRender){
 const requests=[],errors=[];
 class Image {set src(value){Object.assign(this,JSON.parse(Buffer.from(value.split(',')[1],'base64').toString()));}async decode(){}}
 const context={console,setTimeout,clearTimeout,queueMicrotask,Image,CustomEvent:class{},dispatchEvent(){},document:{readyState:'complete',createElement(){
  let image;return {getContext(){return {drawImage(i){image=i;},getImageData(){const data=new Uint8ClampedArray(image.width*image.height*4);for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)if(image.tip==='rect'||(x/image.width-.5)**2+(y/image.height-.5)**2<.22)data[(y*image.width+x)*4+3]=255;return {data};}}}};
 }},webkit:{messageHandlers:{FeatherKrita:{async postMessage(body){
   requests.push(clone(body));
   if(body.command==='error')errors.push(body.message);
   if(body.command==='saveStroke'){store.set(body.id,clone(body.record));return {ok:true};}
   if(body.command==='loadStroke')return {ok:true,record:store.has(body.id)?clone(store.get(body.id)):null};
   if(body.command==='presetInfo')return {ok:true,extent:1,samplesBackdrop:false};
   if(body.command==='selectPreset')return {ok:true,bindings:{RECT:'saved'}};
   if(body.command==='render'){
    if(deferRender)await deferRender;
    const png=Buffer.from(JSON.stringify({width:body.width,height:body.height,tip:body.preset})).toString('base64');
    return {ok:true,width:body.width,height:body.height,png,coverage:png,composited:false};
   }
   return {ok:true};
 }}}}};
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
 context.FeatherKrita.attach(Manager,{Geometry:THREE.BufferGeometry,Attribute:THREE.BufferAttribute,Mesh:THREE.Mesh,ShaderMaterial:THREE.ShaderMaterial,Texture:THREE.Texture,LinearFilter:THREE.LinearFilter,fallbackSize:.01});
 const attributes={shape:'RECT',size:1,color:[50,100,200,.75],pressures:[.2,.5,1],points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:2,y:0,z:0}],normals:[{x:0,y:0,z:1},{x:0,y:0,z:1},{x:0,y:0,z:1}]};
 const manager=new Manager(),fk=context.FeatherKrita;
 function draw(id,a=attributes){fk.birth(id,a);manager.makeCurve(id,a);}
 return {context,manager,fk,attributes,draw,requests,errors,store};
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
