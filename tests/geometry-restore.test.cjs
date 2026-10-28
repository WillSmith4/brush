const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const THREE = require(process.env.FEATHER_TEST_THREE || 'three');
const runtime = fs.readFileSync(require('node:path').join(__dirname,'../web/brush-runtime.js'),'utf8');
const tick = () => new Promise(resolve=>setImmediate(resolve));

function fixture() {
  const errors=[];
  const requests=[];
  const context = {console, document:{readyState:'complete'},setTimeout,clearTimeout,queueMicrotask,
    Image:class {async decode(){}}, CustomEvent:class {}, dispatchEvent(){},
    webkit:{messageHandlers:{FeatherKrita:{async postMessage(body){
      requests.push(body);
      if(body.command==='error')errors.push(body.message);
      if(body.command==='selectPreset')return {ok:true,bindings:{RECT:'saved-native-preset'}};
      return body.command==='render'?{ok:true,width:body.width,height:body.height,png:'fixture'}:{ok:true};
    }}}}};
  vm.createContext(context);vm.runInContext(runtime,context);
  class Manager {
    constructor(){this.sceneGroup=new THREE.Group();this.curveIdToGeomInfo=new Map();}
    makeCurves(){} makeCurve(){} updateCurve(){} copyCurveGeom(){} removeCurve(){} removeCurves(){}
    clear(){this.curveIdToGeomInfo.clear();}
    turnOnOff(on){this.geom.geometry.setDrawRange(0,on?60:0);}
    timelapse(count){this.geom.geometry.setDrawRange(0,count);}
    getGeomFromInfo(){return this.geom;}
  }
  context.FeatherKrita.attach(Manager,{Geometry:THREE.BufferGeometry,Attribute:THREE.BufferAttribute,
    Mesh:THREE.Mesh,ShaderMaterial:THREE.ShaderMaterial,Texture:THREE.Texture,LinearFilter:THREE.LinearFilter,fallbackSize:0.02});
  const manager=new Manager(), geometry=new THREE.BufferGeometry();
  const position=new Float32Array(Array.from({length:36},(_,i)=>i/12));
  geometry.setAttribute('position',new THREE.BufferAttribute(position,3));
  geometry.setAttribute('color',new THREE.BufferAttribute(new Uint8Array(48).fill(255),4));
  geometry.setIndex(Array.from({length:60},(_,i)=>i%12));
  const material=new THREE.ShaderMaterial({vertexShader:'void main() { gl_Position=vec4(position,1.0); }',
    fragmentShader:'varying vec4 vColor; void main() { vec4 diffuseColor = vColor; gl_FragColor=diffuseColor; }'});
  const mesh=new THREE.Mesh(geometry,material);manager.sceneGroup.add(mesh);manager.geom={geometry,mesh};
  manager.curveIdToGeomInfo.set('curve',{numOfPoints:3,geomAttributes:0,geomIndex:0,
    attributes:{shape:'RECT',size:1,color:[50,100,200,0.5],pressures:[1,.5,1],points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:2,y:1,z:0}]}});
  return {context,manager,geometry,position,errors,requests};
}

test('inject keeps original geometry and indices; restore removes the replacement',async()=>{
  const {context,manager,geometry,position,errors}=fixture();
  const originalIndices=Array.from(geometry.index.array);
  context.FeatherKrita.setBindings({RECT:'preset'});manager.makeCurves();
  await tick();await tick();
  assert.deepEqual(errors,[]);assert.equal(manager.sceneGroup.children.length,2);
  assert.equal(geometry.attributes.position.array,position);
  assert.deepEqual(Array.from(geometry.index.array),originalIndices);
  const rendered=manager.sceneGroup.children[1].geometry;
  assert.deepEqual(Array.from(rendered.attributes.position.array),Array.from(position));
  assert.ok(geometry.attributes.fkHide.array.every(v=>v===1));
  context.FeatherKrita.setBindings({});
  assert.equal(manager.sceneGroup.children.length,1);
  assert.ok(geometry.attributes.fkHide.array.every(v=>v===0));
  assert.deepEqual(Array.from(geometry.index.array),originalIndices);
});

test('an unrelated brush type is untouched',async()=>{
  const {context,manager,geometry}=fixture();
  context.FeatherKrita.setBindings({RIBBON:'preset'});manager.makeCurves();
  await tick();assert.equal(manager.sceneGroup.children.length,1);
  assert.equal(geometry.attributes.fkHide,undefined);
});

test('restoring during native rendering cannot reapply a stale result',async()=>{
  const {context,manager}=fixture();
  context.FeatherKrita.setBindings({RECT:'preset'});manager.makeCurves();
  context.FeatherKrita.setBindings({});
  await tick();await tick();assert.equal(manager.sceneGroup.children.length,1);
});

test('visibility changes and timelapse also constrain replacement geometry',async()=>{
  const {context,manager}=fixture();
  context.FeatherKrita.setBindings({RECT:'preset'});manager.makeCurves();
  await tick();await tick();
  const replacement=manager.sceneGroup.children[1];
  manager.turnOnOff(false);assert.equal(replacement.geometry.drawRange.count,0);
  manager.turnOnOff(true);assert.equal(replacement.geometry.drawRange.count,60);
  manager.timelapse(24);assert.equal(replacement.geometry.drawRange.count,24);
});

test('saving and recalling a host preset restores its native brush binding',async()=>{
  const {context,manager,requests}=fixture();
  context.FeatherKrita.savePreset('host-preset','RECT');
  await context.FeatherKrita.selectPreset('host-preset','RECT');
  manager.makeCurves();await tick();await tick();
  assert.equal(requests.find(r=>r.command==='savePreset').id,'host-preset');
  assert.equal(requests.find(r=>r.command==='render').preset,'saved-native-preset');
  assert.equal(manager.sceneGroup.children.length,2);
});
