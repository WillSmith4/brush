// SPDX-License-Identifier: GPL-3.0-or-later
(function (root) {
  "use strict";
  if (root.FeatherKrita) return;
  const SHAPES = ["POINTY", "RECT", "CUBE", "MARKER", "WIDEBRUSH", "RIBBON"];
  let bindings = Object.create(null), api, attached = false, gesture;
  const managers = new Set(), states = new WeakMap(), latestAttributes = new WeakMap();
  const artworks = new Map(), metadata = new Map(), assets = new Map(), previews = new WeakMap();
  const restoringSurfaces = new Set();
  const hoverStates=new Map();
  const paintOrders=new Map();let lastPaintOrder=0,legacyPaintOrder=0;
  function paintOrder(id,saved){
    // Loaded records may arrive out of document order. A persisted layer order
    // is authoritative, while legacy strokes keep their document traversal.
    if(Number.isFinite(saved))paintOrders.set(id,saved);
    else if(!paintOrders.has(id))paintOrders.set(id,++legacyPaintOrder);
    lastPaintOrder=Math.max(lastPaintOrder,paintOrders.get(id));return paintOrders.get(id);
  }
  function newPaintOrder(id){return paintOrder(id,Math.max(Date.now()*1000,lastPaintOrder+1));}
  let renderTail = Promise.resolve(), textureBytes = 0;
  let nextPreviewSession=0, previewReadyAt=0;
  const inputPreviews=new WeakMap();
  const liveRecords=new WeakMap();
  function sameHostPath(a,b){return a.size===b.size&&a.shape===b.shape&&a.points?.length===b.points?.length&&a.points.every((p,i)=>xyz(p).every((v,k)=>v===xyz(b.points[i])[k]));}
  const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;
  const post = body => root.webkit.messageHandlers.FeatherKrita.postMessage(body);
  const clone = value => JSON.parse(JSON.stringify(value));
  const errors = new Set();
  function fail(error) {
    const message = String(error?.message || error);
    console.error("FeatherKrita:", error);
    if (errors.has(message)) return;
    errors.add(message);
    root.dispatchEvent?.(new CustomEvent("feather-krita-error", {detail: message}));
    post({command: "error", message: message.slice(0, 400)}).catch(() => {});
  }
  async function checked(body) {
    const result = await post(body);
    if (!result?.ok) throw new Error(result?.error || "The brush request failed.");
    return result;
  }
  const xyz = p => Array.isArray(p) ? p : [p.x, p.y, p.z];
  const add = (a,b) => a.map((v,i) => v+b[i]);
  const sub = (a,b) => a.map((v,i) => v-b[i]);
  const mul = (a,s) => a.map(v => v*s);
  const dot = (a,b) => a.reduce((s,v,i) => s+v*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit = (a, fallback=[0,0,1]) => Math.hypot(...a)>1e-9 ? mul(a,1/Math.hypot(...a)) : [...fallback];
  const lerp = (a,b,t) => add(mul(a,1-t),mul(b,t));
  const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
  const now = () => root.performance?.now() ?? Date.now();
  // Yield between bounded batches, including live geometry. Native painting is
  // already asynchronous; a multi-second JS mesh build must not block Pencil.
  function workBudget(enabled, active=()=>true) {
    let deadline=now()+5;
    return {check(){
      if(!active())throw new Error("Preview cancelled");
      if(!enabled||now()<deadline)return null;
      return new Promise(resolve=>setTimeout(resolve,0)).then(()=>{
        if(!active())throw new Error("Preview cancelled");deadline=now()+5;
      });
    }};
  }
  function normalAt(normals,index,count){
    if(!normals?.length)return {x:0,y:0,z:1};
    const f=clamp(index/Math.max(1,count-1),0,1)*(normals.length-1),i=Math.floor(f);
    const read=j=>{const p=normals[j];return p&&xyz(p).every(Number.isFinite)?xyz(p):null;};
    let a=read(i),b=read(Math.min(i+1,normals.length-1));
    if(!a&&!b){for(let j=0;j<normals.length&&!a;j++)a=read(j);}
    a=a||b||[0,0,1];b=b||a;
    const n=unit(lerp(a,b,f-i));
    return {x:n[0],y:n[1],z:n[2]};
  }

  // One isotropic projection, not arc-length UVs wrapped around a host tube.
  // A nonplanar path is lifted back onto its local drawing surface at mesh time.
  function* strokeRequestSteps(attributes, preset, fallbackSize=0.01, meta={}, cameraRight=[1,0,0]) {
    const points=[];
    if(!attributes.points?.length)throw new Error("Invalid 3D stroke coordinates.");
    for(let i=0;i<attributes.points.length;i++){
      if(i%128===0)yield;
      const p=xyz(attributes.points[i]);
      if(p.length!==3||p.some(v=>!Number.isFinite(v)))throw new Error("Invalid 3D stroke coordinates.");points.push(p);
    }
    const size = Number(attributes.size)>0 ? Number(attributes.size) : fallbackSize;
    const normals=[],sum=[0,0,0];
    for(let i=0;i<(attributes.normals?.length||0);i++){
      if(i%128===0)yield;const n=xyz(attributes.normals[i]);
      if(n.some(v=>!Number.isFinite(v)))throw new Error("Invalid stroke normals.");
      normals.push(n);for(let j=0;j<3;j++)sum[j]+=n[j];
    }
    let normal = unit(sum);
    let u = sub(cameraRight,mul(normal,dot(cameraRight,normal)));
    if (Math.hypot(...u)<1e-6) u=cross([0,1,0],normal);
    u=unit(u,[1,0,0]); const v=unit(cross(normal,u));
    const origin=points[0], projected=[];
    for(let i=0;i<points.length;i++){if(i%128===0)yield;const d=sub(points[i],origin);projected.push([dot(d,u),dot(d,v)]);}
    const margin=size*Math.max(0.75,(Number(meta.extent)||1)*0.6,meta.samplesBackdrop?3:0);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of projected){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}
    minX-=margin;minY-=margin;maxX+=margin;maxY+=margin;
    const w=maxX-minX,h=maxY-minY;
    const scale=Math.min(128/size,4094/w,4094/h,Math.sqrt(2090000/(w*h)))*0.999;
    const width=Math.max(2,Math.ceil(w*scale)),height=Math.max(2,Math.ceil(h*scale));
    maxX=minX+width/scale;minY=maxY-height/scale;
    const pressures=attributes.pressures || [];
    const input=[];
    for(let i=0;i<projected.length;i++){
      if(i%128===0)yield;const p=projected[i],sample=[(p[0]-minX)*scale,(maxY-p[1])*scale,
        pressures.length?clamp(Number(pressures[Math.min(i,pressures.length-1)]),0,1):1,i*8];
      if(sample.some(v=>!Number.isFinite(v)))throw new Error("Invalid brush pressure.");input.push(sample);
    }
    const sampled=input.length<=4096?input:Array.from({length:4096},(_,i)=>input[Math.round(i*(input.length-1)/4095)]);
    const color=attributes.color || [0,0,0,1];
    return {body:{command:"render",preset,width,height,size:size*scale,points:sampled,color:color.slice(0,3),opacity:color[3]??1,seed:1},
      frame:{origin,u,v,normal,minX,minY,maxX,maxY,scale,width,height,points,normals,projected,size}};
  }
  function strokeRequest(...args){const steps=strokeRequestSteps(...args);let step;do{step=steps.next();}while(!step.done);return step.value;}
  async function previewRequest(args,active){
    const steps=strokeRequestSteps(...args),budget=workBudget(true,active);let step;
    do{const pause=budget.check();if(pause)await pause;step=steps.next();}while(!step.done);return step.value;
  }

  // Merge occupied pixel runs, retaining holes and irregular brush-tip edges.
  // Fragment coverage still clips exact pixels if a noisy mask needs coarser cells.
  function* coverageRuns(rgba,width,height,minimumStep=1,stride=4) {
    if(rgba.length!==width*height*stride)throw new Error("Invalid brush coverage dimensions.");
    for(let step=minimumStep;step<=16;step*=2){
      const rectangles=[],open=new Map();
      for(let y=0;y<height;y+=step){
        yield;
        const runs=[];let start=-1;
        for(let x=0;x<=width;x+=step){
          let occupied=false;
          if(x<width)for(let yy=y;yy<Math.min(y+step,height)&&!occupied;yy++)for(let xx=x;xx<Math.min(x+step,width);xx++)if(rgba[(yy*width+xx)*stride+stride-1]){occupied=true;break;}
          if(occupied&&start<0)start=x;
          if(!occupied&&start>=0){runs.push([start,Math.min(x,width)]);start=-1;}
          if(x+step>width&&start>=0){runs.push([start,width]);start=-1;}
        }
        const seen=new Set();
        for(const [x0,x1] of runs){const key=x0+":"+x1;seen.add(key);const r=open.get(key);if(r)r[3]=Math.min(y+step,height);else open.set(key,[x0,y,x1,Math.min(y+step,height)]);}
        for(const [key,r] of open)if(!seen.has(key)){rectangles.push(r);open.delete(key);}
      }
      rectangles.push(...open.values());
      if(rectangles.length<=100000)return rectangles;
    }
    throw new Error("The brush footprint is too complex.");
  }
  function coverageRectangles(rgba,width,height,minimumStep=1) {
    const rows=coverageRuns(rgba,width,height,minimumStep);let row;
    do{row=rows.next();}while(!row.done);return row.value;
  }
  async function previewCoverage(rgba,width,height,budget,stride=4){
    const rows=coverageRuns(rgba,width,height,8,stride);let row;
    do{const pause=budget.check();if(pause)await pause;row=rows.next();}while(!row.done);return row.value;
  }
  const segmentTrees=new WeakMap();
  const guideGeometryCache=new WeakMap(),guideDirty=new WeakSet();
  function guideTriangles(mesh){
    mesh.updateWorldMatrix(true,false);
    const geometry=mesh.geometry,position=geometry?.attributes.position,index=geometry?.index;
    if(!position||position.isInterleavedBufferAttribute)return null;
    const key=[geometry.uuid,position.version,index?.version,mesh.matrixWorld.elements.join(",")].join(":");
    const cached=guideGeometryCache.get(mesh);if(cached?.key===key)return cached.triangles;
    const triangles=[],count=index?index.count:position.count;
    if(count>600000)return null;
    const point=i=>new api.Vector3().fromBufferAttribute(position,index?index.getX(i):i).applyMatrix4(mesh.matrixWorld).toArray();
    for(let i=0;i+2<count;i+=3){const a=point(i),b=point(i+1),c=point(i+2),normal=unit(cross(sub(b,a),sub(c,a)));triangles.push({points:[a,b,c],normal});}
    guideGeometryCache.set(mesh,{key,triangles});return triangles;
  }
  function guideSurface(frame,attributes){
    if(!api?.guideMeshes||!api.Raycaster||!api.Vector3||attributes.points.length<2)return null;
    const guides=api.guideMeshes()||[];if(!guides.length)return null;
    guides.forEach(guide=>guide.updateWorldMatrix(true,true));
    const ray=new api.Raycaster(),size=attributes.size||frame.size,offset=Math.max(size*2,.01),votes=new Map();
    for(const i of [...new Set([0,Math.floor((attributes.points.length-1)/2),attributes.points.length-1])]){
      const p=new api.Vector3(...xyz(attributes.points[i])),n=new api.Vector3(...xyz(normalAt(attributes.normals,i,attributes.points.length)));
      ray.set(p.clone().addScaledVector(n,offset),n.clone().negate());ray.far=offset*2;
      const hit=ray.intersectObjects(guides,true).find(h=>h.object.isMesh&&h.point.distanceTo(p)<=Math.max(size*.4,.002));
      if(hit)votes.set(hit.object,(votes.get(hit.object)||0)+1);
    }
    const chosen=[...votes].sort((a,b)=>b[1]-a[1])[0];if(!chosen||chosen[1]<2)return null;
    const triangles=guideTriangles(chosen[0]);if(!triangles)return null;
    const positions=[],normals=[],uv=[];
    for(const triangle of triangles){
      // Only the contacted side of the Guide receives this raster projection.
      if(dot(triangle.normal,frame.normal)<=.02)continue;
      const coords=triangle.points.map(p=>{const d=sub(p,frame.origin);return [(dot(d,frame.u)-frame.minX)*frame.scale/frame.width,(dot(d,frame.v)-frame.minY)*frame.scale/frame.height];});
      if(Math.max(...coords.map(p=>p[0]))<0||Math.min(...coords.map(p=>p[0]))>1||Math.max(...coords.map(p=>p[1]))<0||Math.min(...coords.map(p=>p[1]))>1)continue;
      for(let i=0;i<3;i++){positions.push(...triangle.points[i]);normals.push(...triangle.normal);uv.push(...coords[i]);}
    }
    return positions.length?{version:1,positions,normals,uv}:null;
  }
  async function guidePaintGeometry(source,info,record,attributes,patch,budget){
    const geometry=new api.Geometry(),count=patch.positions.length/3,frame=record.frame;
    const current={points:attributes.points.map(xyz),normals:(attributes.normals||[]).map(xyz)},original={points:record.attributes.points.map(xyz),normals:(record.attributes.normals||[]).map(xyz)};
    const unchanged=attributes.size===record.attributes.size&&current.points.length===original.points.length&&current.points.every((p,i)=>p.every((v,j)=>v===original.points[i][j]));
    const positions=new Float32Array(patch.positions),normals=new Float32Array(patch.normals),progress=new Float32Array(count);
    const uniform=uniformSurfaceAttributes(source,info);
    if(record.preview&&(!uniform||!unchanged))await prepareSegmentTree(frame,budget);
    for(let i=0;i<count;i++){
      if(i%128===0){const pause=budget.check();if(pause)await pause;}
      const x=patch.uv[i*2]*frame.width,y=(1-patch.uv[i*2+1])*frame.height;
      if(!uniform)progress[i]=locate(frame,x,y).progress;
      if(!unchanged){const to=mapPixel(frame,x,y,attributes,current),from=mapPixel(frame,x,y,record.attributes,original);positions.set(add(patch.positions.slice(i*3,i*3+3),sub(to.position,from.position)),i*3);normals.set(to.normal,i*3);}
    }
    for(const [name,attribute]of Object.entries(source.attributes)){
      if(name==="fkHide")continue;
      const array=new attribute.array.constructor(count*attribute.itemSize);
      for(let i=0;i<count;i++){
        const offset=(info.geomAttributes+Math.min(info.numOfPoints-1,Math.round(progress[i]*(info.numOfPoints-1)))*4)*attribute.itemSize;
        for(let j=0;j<attribute.itemSize;j++)array[i*attribute.itemSize+j]=attribute.array[offset+j]||0;
        if(name==="position")array.set(positions.subarray(i*3,i*3+3),i*3);
        else if(name==="normalUp"||name==="normalSide")array.set(normals.subarray(i*3,i*3+3),i*3);
        else if(name==="upDown")array[i]=0;
        else if(name==="color")array.set([...(attributes.color||[0,0,0]).slice(0,3),Math.round((attributes.color?.[3]??1)*255)],i*4);
      }
      geometry.setAttribute(name,new api.Attribute(array,attribute.itemSize,attribute.normalized));
    }
    geometry.setAttribute("fkUV",new api.Attribute(new Float32Array(patch.uv),2));
    geometry.setIndex(new api.Attribute(Uint32Array.from({length:count},(_,i)=>i),1));geometry.computeBoundingSphere();return geometry;
  }
  function segmentTree(frame) {
    if(segmentTrees.has(frame))return segmentTrees.get(frame);
    const parts=frame.projected.slice(0,-1).map((p,i)=>{const q=frame.projected[i+1];return {i,minX:Math.min(p[0],q[0]),maxX:Math.max(p[0],q[0]),minY:Math.min(p[1],q[1]),maxY:Math.max(p[1],q[1])};});
    function build(list){
      const node={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
      for(const p of list){if(p.minX<node.minX)node.minX=p.minX;if(p.minY<node.minY)node.minY=p.minY;if(p.maxX>node.maxX)node.maxX=p.maxX;if(p.maxY>node.maxY)node.maxY=p.maxY;}
      if(list.length<=8)node.items=list;else{const axis=node.maxX-node.minX>node.maxY-node.minY?"X":"Y";list.sort((a,b)=>(a['min'+axis]+a['max'+axis])-(b['min'+axis]+b['max'+axis]));const mid=list.length>>1;node.left=build(list.slice(0,mid));node.right=build(list.slice(mid));}return node;
    }
    const tree=build(parts);segmentTrees.set(frame,tree);return tree;
  }
  async function prepareSegmentTree(frame,budget){
    if(segmentTrees.has(frame))return;
    const parts=[];
    for(let i=0;i+1<frame.projected.length;i++){
      if(i%256===0){const pause=budget.check();if(pause)await pause;}
      const a=frame.projected[i],b=frame.projected[i+1];
      parts.push({i,minX:a[0]<b[0]?a[0]:b[0],maxX:a[0]>b[0]?a[0]:b[0],minY:a[1]<b[1]?a[1]:b[1],maxY:a[1]>b[1]?a[1]:b[1]});
    }
    const tree={},pending=[{node:tree,list:parts}];
    while(pending.length){
      const pause=budget.check();if(pause)await pause;
      const {node,list}=pending.pop();node.minX=node.minY=Infinity;node.maxX=node.maxY=-Infinity;
      for(const p of list){if(p.minX<node.minX)node.minX=p.minX;if(p.minY<node.minY)node.minY=p.minY;if(p.maxX>node.maxX)node.maxX=p.maxX;if(p.maxY>node.maxY)node.maxY=p.maxY;}
      if(list.length<=8)node.items=list;
      else{
        const axis=node.maxX-node.minX>node.maxY-node.minY?"X":"Y";
        list.sort((a,b)=>(a['min'+axis]+a['max'+axis])-(b['min'+axis]+b['max'+axis]));
        const mid=list.length>>1;node.left={};node.right={};
        pending.push({node:node.left,list:list.slice(0,mid)},{node:node.right,list:list.slice(mid)});
      }
    }
    segmentTrees.set(frame,tree);
  }
  function locate(frame,x,y) {
    const p=[frame.minX+x/frame.scale,frame.maxY-y/frame.scale];
    let best=Infinity,index=0,t=0;
    const distance=node=>{
      const dx=p[0]<node.minX?node.minX-p[0]:p[0]>node.maxX?p[0]-node.maxX:0;
      const dy=p[1]<node.minY?node.minY-p[1]:p[1]>node.maxY?p[1]-node.maxY:0;
      return dx*dx+dy*dy;
    };
    function visit(node,bound){
      if(bound>=best)return;
      if(!node.items){
        const left=distance(node.left),right=distance(node.right);
        if(left<right){visit(node.left,left);visit(node.right,right);}else{visit(node.right,right);visit(node.left,left);}return;
      }
      for(const {i} of node.items){
      const a=frame.projected[i],b=frame.projected[i+1],dx=b[0]-a[0],dy=b[1]-a[1];
      const raw=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1),f=raw<0?0:raw>1?1:raw;
      const d=(p[0]-a[0]-f*dx)**2+(p[1]-a[1]-f*dy)**2;
      if(d<best){best=d;index=i;t=f;}
      }
    }
    visit(segmentTree(frame),0);
    return {p,index,t,progress:(index+t)/Math.max(1,frame.points.length-1)};
  }
  function mapPixel(frame,x,y,attributes,prepared) {
    const loc=locate(frame,x,y),i=loc.index,t=loc.t;
    const projected=frame.projected[i+1]?lerp(frame.projected[i],frame.projected[i+1],t):frame.projected[i];
    const points=prepared?.points || (attributes.points || []).map(xyz);
    const f=loc.progress*Math.max(0,points.length-1),j=Math.floor(f);
    const center=points[j+1]?lerp(points[j],points[j+1],f-j):points[j] || frame.points[i];
    const normals=prepared?.normals || (attributes.normals || []).map(xyz);
    const nf=loc.progress*Math.max(0,normals.length-1),ni=Math.floor(nf);
    const n=unit(normals[ni+1]?lerp(normals[ni],normals[ni+1],nf-ni):normals[ni] || frame.normal);
    let u=unit(sub(frame.u,mul(n,dot(frame.u,n))),frame.u);
    // Rotate the saved raster frame with the edited centerline, while keeping
    // stroke width independent of path curvature.
    const oa=frame.points[i],ob=frame.points[i+1]||oa;
    const tangentIndex=clamp(Math.floor((i+0.5)*Math.max(0,points.length-1)/Math.max(1,frame.points.length-1)),0,Math.max(0,points.length-2));
    const a=points[tangentIndex],b=points[Math.min(points.length-1,tangentIndex+1)];
    if(a&&b){const oldT=unit(sub(ob,oa),frame.u),newT=unit(sub(b,a),u),oldS=unit(cross(frame.normal,oldT),frame.v),newS=unit(cross(n,newT),frame.v);u=unit(add(mul(newT,dot(frame.u,oldT)),mul(newS,dot(frame.u,oldS))),u);}
    const v=unit(cross(n,u),frame.v);
    const ratio=(Number(attributes.size)>0?Number(attributes.size):frame.size)/frame.size;
    return {position:add(center,add(mul(u,(loc.p[0]-projected[0])*ratio),mul(v,(loc.p[1]-projected[1])*ratio))),normal:n,progress:loc.progress};
  }

  function save(id,record){return checked({command:"saveStroke",id,record});}
  function birth(id,attributes) {
    if(artworks.has(id))return;
    const preset=(gesture?.bindings || bindings)[attributes.shape];
    if(!preset){artworks.set(id,Promise.resolve(null));return;}
    const record={version:2,preset,paintOrder:newPaintOrder(id),attributes:clone(attributes)};
    const stream=gesture?.streams?.find(s=>!s.claimed&&s.preset===preset&&s.basis&&Math.hypot(...sub(xyz(attributes.points[0]),s.basis.origin))<Math.max(attributes.size*.1,.0001));
    if(stream){stream.claimed=true;stream.finishAttributes=clone(attributes);liveRecords.set(record,stream);}
    artworks.set(id,Promise.resolve(record));save(id,record).catch(fail);
  }
  function artwork(id) {
    paintOrder(id);
    if(!artworks.has(id))artworks.set(id,checked({command:"loadStroke",id}).then(r=>r.record));
    return artworks.get(id);
  }
  function inherit(id,source) {
    const pending=artwork(source).then(async original=>{if(!original)return null;const record=clone(original);record.paintOrder=newPaintOrder(id);await save(id,record);return record;});
    artworks.set(id,pending);pending.catch(fail);
  }
  function presetInfo(preset) {
    if(!metadata.has(preset))metadata.set(preset,checked({command:"presetInfo",preset}).catch(error=>{metadata.delete(preset);throw error;}));
    return metadata.get(preset);
  }
  function cameraRight(){try{return api.camera().matrixWorld.elements.slice(0,3);}catch{return [1,0,0];}}

  function snapshot(frame) {
    if(!api.renderer || !api.scene || !api.camera)throw new Error("Scene sampling is unavailable for this blending brush.");
    const renderer=api.renderer(),scene=api.scene(),camera=api.camera().clone();
    const vec=a=>new api.Vector3(...a),distance=Math.max(frame.size*8,1),near=0.001,far=distance*2;
    camera.matrixAutoUpdate=true;camera.matrixWorldAutoUpdate=true;
    camera.position.copy(vec(add(frame.origin,mul(frame.normal,distance))));
    camera.up.copy(vec(frame.v));camera.lookAt(vec(frame.origin));
    camera.near=near;camera.far=far;camera.isPerspectiveCamera=false;camera.isOrthographicCamera=true;
    camera.projectionMatrix.makeOrthographic(frame.minX,frame.maxX,frame.maxY,frame.minY,near,far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();camera.updateMatrixWorld(true);
    const target=new api.RenderTarget(frame.width,frame.height,{depthBuffer:true,stencilBuffer:false});
    target.depthTexture=new api.DepthTexture(frame.width,frame.height);
    for(const texture of target.textures || [target.texture])texture.colorSpace=renderer.outputColorSpace;
    const copy4={copy(p){this.x=p.x;this.y=p.y;this.z=p.z;this.w=p.w;return this;}};
    const viewport={...renderer.getViewport({...copy4})},scissor={...renderer.getScissor({...copy4})};
    const oldTarget=renderer.getRenderTarget(),scissorTest=renderer.getScissorTest();
    const color=renderer.getClearColor(new api.Color()).clone(),alpha=renderer.getClearAlpha();
    const shadow=renderer.shadowMap.autoUpdate,background=scene.background,fog=scene.fog;
    const hidden=[],captureUniforms=new Map();
    // Only artwork and lights participate. No cursor, grid, ground, or live preview.
    const art=api.artGroup();
    scene.traverse(object=>{
      if(!object.isMesh&&!object.isLine&&!object.isPoints&&!object.isSprite)return;
      let inArt=false;for(let p=object;p;p=p.parent)if(p===art){inArt=true;break;}
      if(!inArt&&object.visible){hidden.push(object);object.visible=false;}
      // Feather writes gl_FragDepth using its near/far uniforms. They must
      // describe this capture camera, otherwise native and Feather meshes use
      // incompatible depth values in the same texture (and reconstruct spikes).
      for(const material of Array.isArray(object.material)?object.material:[object.material]){
        if(!material?.fragmentShader?.includes("gl_FragDepth"))continue;
        for(const [name,value] of [["near",near],["far",far],["fkDepthBias",0]]){
          const uniform=material.uniforms?.[name];if(!uniform)continue;
          if(!captureUniforms.has(uniform))captureUniforms.set(uniform,uniform.value);
          uniform.value=value;
        }
      }
    });
    try{
      renderer.shadowMap.autoUpdate=false;scene.background=null;scene.fog=null;
      renderer.setRenderTarget(target);renderer.setViewport(0,0,frame.width,frame.height);renderer.setScissorTest(false);
      renderer.setClearColor(0,0);renderer.clear(true,true,true);renderer.render(scene,camera);
      const bytes=new Uint8Array(frame.width*frame.height*4);
      renderer.readRenderTargetPixels(target,0,0,frame.width,frame.height,bytes);
      const canvas=document.createElement("canvas");canvas.width=frame.width;canvas.height=frame.height;
      const ctx=canvas.getContext("2d"),image=ctx.createImageData(frame.width,frame.height);
      for(let y=0;y<frame.height;y++){
        const src=(frame.height-1-y)*frame.width*4,dst=y*frame.width*4;
        for(let x=0;x<frame.width;x++){
          const s=src+x*4,d=dst+x*4,a=bytes[s+3];
          // WebGL's normal blending stores premultiplied RGB in the framebuffer.
          image.data[d]=a?Math.min(255,Math.round(bytes[s]*255/a)):0;
          image.data[d+1]=a?Math.min(255,Math.round(bytes[s+1]*255/a)):0;
          image.data[d+2]=a?Math.min(255,Math.round(bytes[s+2]*255/a)):0;
          image.data[d+3]=a;
        }
      }
      ctx.putImageData(image,0,0);const png=canvas.toDataURL("image/png").split(",")[1];
      // Color compositing must not write transparent-stroke depth. Populate
      // depth separately for smudge reconstruction, without touching that color.
      const depthMaterials=new Map(),autoClear=renderer.autoClear;
      scene.traverse(object=>{for(const material of Array.isArray(object.material)?object.material:[object.material])if(material?.userData?.fkPaint&&!depthMaterials.has(material)){depthMaterials.set(material,{depthWrite:material.depthWrite,colorWrite:material.colorWrite});material.depthWrite=true;material.colorWrite=false;}});
      try{renderer.autoClear=false;renderer.render(scene,camera);}finally{renderer.autoClear=autoClear;for(const [material,saved]of depthMaterials){material.depthWrite=saved.depthWrite;material.colorWrite=saved.colorWrite;}}
      // Preserve the sampled surface depth, so smudge paint lies on the artwork
      // it sampled rather than disappearing inside a round Feather stroke.
      const depthTarget=new api.RenderTarget(frame.width,frame.height,{depthBuffer:false});
      const depthGeometry=new api.Geometry();depthGeometry.setAttribute("position",new api.Attribute(new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),3));
      const depthMaterial=new api.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{depthMap:{value:target.depthTexture},size:{value:[frame.width,frame.height]}},
        vertexShader:"void main(){gl_Position=vec4(position,1.0);}",
        fragmentShader:"uniform sampler2D depthMap;uniform vec2 size;void main(){float z=texture2D(depthMap,gl_FragCoord.xy/size).r;if(z>=0.999999){gl_FragColor=vec4(0.0);return;}float v=floor(z*16777215.0+0.5);gl_FragColor=vec4(floor(v/65536.0),mod(floor(v/256.0),256.0),mod(v,256.0),255.0)/255.0;}"});
      const depthScene=new api.Scene(),depthMesh=new api.Mesh(depthGeometry,depthMaterial);
      // Clip-space fullscreen geometry must not be culled against a distant
      // world-space brush position.
      depthMesh.frustumCulled=false;depthScene.add(depthMesh);
      let depth;
      try{
        renderer.setRenderTarget(depthTarget);renderer.clear();renderer.render(depthScene,camera);
        renderer.readRenderTargetPixels(depthTarget,0,0,frame.width,frame.height,bytes);
        for(let y=0;y<frame.height;y++)image.data.set(bytes.subarray((frame.height-1-y)*frame.width*4,(frame.height-y)*frame.width*4),y*frame.width*4);
        ctx.putImageData(image,0,0);depth=canvas.toDataURL("image/png").split(",")[1];
      }finally{depthTarget.dispose();depthGeometry.dispose();depthMaterial.dispose();}
      return {png,depth,near,far,distance};
    }finally{
      for(const [uniform,value] of captureUniforms)uniform.value=value;
      hidden.forEach(o=>o.visible=true);scene.background=background;scene.fog=fog;renderer.shadowMap.autoUpdate=shadow;
      renderer.setRenderTarget(oldTarget);renderer.setViewport(viewport.x,viewport.y,viewport.z,viewport.w);
      renderer.setScissor(scissor.x,scissor.y,scissor.z,scissor.w);renderer.setScissorTest(scissorTest);renderer.setClearColor(color,alpha);target.dispose();
    }
  }
  const rendering=new WeakMap();
  function nativeSerial(body){const job=renderTail.then(()=>checked(body));renderTail=job.catch(()=>{});return job;}
  function streamFrame(s,x,y,width,height,scaleFactor=1,points=s.worldPoints,normals=s.worldNormals){
    const scale=s.basis.scale*scaleFactor,minX=(x-8192)/s.basis.scale,maxY=(8192-y)/s.basis.scale;
    return {...s.basis,scale,width,height,minX,maxX:minX+width/scale,maxY,minY:maxY-height/scale,points,normals,projected:points.map(p=>{const d=sub(p,s.basis.origin);return [dot(d,s.basis.u),dot(d,s.basis.v)];})};
  }
  async function streamBackground(s,points){
    if(!s.meta.samplesBackdrop)return [];
    const tiles=[],margin=Math.max(128*3,128*(s.meta.extent||1));
    for(const p of points)for(let y=Math.max(0,Math.floor((p[1]-margin)/256)*256);y<=Math.min(16128,p[1]+margin);y+=256)for(let x=Math.max(0,Math.floor((p[0]-margin)/256)*256);x<=Math.min(16128,p[0]+margin);x+=256){
      const key=x+':'+y;if(s.backdrops.has(key))continue;
      const frame=streamFrame(s,x-1,y-1,258,258),captured=snapshot(frame),picture=new Image();picture.src='data:image/png;base64,'+captured.png;await picture.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');ctx.drawImage(picture,1,1,256,256,0,0,256,256);
      tiles.push({x,y,png:canvas.toDataURL('image/png').split(',')[1]});s.backdrops.set(key,{encoding:'linear-camera-v3',depth:captured.depth,near:captured.near,far:captured.far,distance:captured.distance});
      if(tiles.length>=64)throw new Error('The blend update covers too many surface tiles.');
    }return tiles;
  }
  async function showStreamTiles(s,result,active){
    if(!result.tiles?.length||!active())return;
    const response=await root.fetch('/feather-krita-preview/'+result.pixels,{cache:'no-store'});if(!response.ok)throw new Error('Cannot load live brush tiles.');
    const bytes=new Uint8Array(await response.arrayBuffer()),state=states.get(s.holder.manager);
    for(const tile of result.tiles){
      if(!active())return;
      const key=(tile.x+1)+':'+(tile.y+1),id='tile:'+key,size=tile.width*tile.height*5;
      if(!Number.isInteger(tile.offset)||tile.offset<0||tile.offset+size>bytes.length)throw new Error('Invalid live tile packet.');
      const selected=[];
      const tx=Math.floor((tile.x+1)/256),ty=Math.floor((tile.y+1)/256);
      for(let y=ty-2;y<=ty+2;y++)for(let x=tx-2;x<=tx+2;x++)for(const i of s.pointCells.get(x+':'+y)||[])selected.push(i);
      selected.sort((a,b)=>a-b);
      if(!selected.length)selected.push(Math.max(0,s.worldPoints.length-1));
      const points=selected.map(i=>s.worldPoints[i]),normals=selected.map(i=>s.worldNormals[i]);if(points.length===1){points.push(points[0]);normals.push(normals[0]);}
      const a={...s.attributes,points,normals,pressures:[]},frame=streamFrame(s,tile.x,tile.y,tile.width,tile.height,1,points,normals);
      const record={version:2,preview:true,preset:s.preset,attributes:a,frame,surface:s.backdrops.get(key),streamClip:true,result:{...tile,pixels:result.pixels,pixelBytes:bytes.subarray(tile.offset,tile.offset+size),composited:result.composited}};
      if(!record.surface)record.guideSurface=guideSurface(frame,a);
      const entry=await loadAssets(record,active);if(!active()){releasePreviewAsset(entry);return;}
      const previous=state.records.get(id);
      // On a fixed Guide, geometry and UVs are independent of how much ink has
      // accumulated. Update its two small textures, not the surface mesh.
      if(previous?.streamGuide&&record.guideSurface){
        entry.refs++;const old=previous.entry;previous.entry=entry;
        previous.mesh.material.uniforms.fkBrush.value=entry.texture;previous.mesh.material.uniforms.fkCoverage.value=entry.mask;
        old.refs--;releasePreviewAsset(old);api.redraw?.();continue;
      }
      const info={attributes:a,numOfPoints:1,geomAttributes:0,geomIndex:0,fkIndexCount:6};s.holder.manager.curveIdToGeomInfo.set(id,info);
      await replaceCurve(s.holder.manager,state,id,info,record,entry,a,active);
      if(state.records.has(id))state.records.get(id).streamGuide=!!record.guideSurface;
      const mesh=state.records.get(id)?.mesh;if(mesh){mesh.material.uniforms.fkTileClip={value:[1/258,1/258,257/258,257/258]};if(!mesh.material.userData.fkTileClip){mesh.material.fragmentShader='uniform vec4 fkTileClip;\n'+mesh.material.fragmentShader.replace('vec4 fkSample =','if(any(lessThan(fkTexCoord,fkTileClip.xy))||any(greaterThanEqual(fkTexCoord,fkTileClip.zw))) discard;\nvec4 fkSample =');mesh.material.userData.fkTileClip=true;mesh.material.needsUpdate=true;}}
    }
  }
  async function streamedResult(s,result){
    const output={result,frame:streamFrame(s,result.streamX,result.streamY,result.width,result.height,result.streamScale),attributes:{...s.attributes,points:s.worldPoints,normals:s.worldNormals,pressures:[]}};
    if(s.meta.samplesBackdrop&&s.backdrops.size){
      const canvas=document.createElement('canvas');canvas.width=result.width;canvas.height=result.height;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
      let first;
      for(const [key,surface]of s.backdrops){first??=surface;const [x,y]=key.split(':').map(Number),image=new Image();image.src='data:image/png;base64,'+surface.depth;await image.decode();ctx.drawImage(image,1,1,256,256,(x-result.streamX)*result.streamScale,(y-result.streamY)*result.streamScale,256*result.streamScale,256*result.streamScale);}
      output.surface={...first,depth:canvas.toDataURL('image/png').split(',')[1]};
    }return output;
  }
  async function appendStream(s,attributes,finish,active=()=>true){
    const points=attributes.points.map(xyz),normals=attributes.normals||[],pressure=attributes.pressures||[];
    if(!s.basis){
      const first=strokeRequest(attributes,s.preset,api.fallbackSize,s.meta,cameraRight()).frame;
      let u=first.u,v=first.v,normal=first.normal;
      // Freeze the camera-facing working plane for the gesture. It covers the
      // visible hemisphere of a round Guide even when surface normals turn.
      try{const m=api.camera().matrixWorld.elements;u=unit(m.slice(0,3));v=unit(m.slice(4,7));normal=unit(m.slice(8,11));}catch{}
      s.basis={origin:first.origin,u,v,normal,scale:128/first.size,size:first.size};s.attributes={...attributes};s.attributes.points=[];s.attributes.normals=[];
    }
    // A Catmull-Rom segment becomes stable once its next control point exists.
    // Keep the mutable trailing segment until more input (or Pencil-up) arrives.
    const end=finish?points.length:Math.max(1,points.length-3);
    while(s.sent<end){
      const stop=Math.min(end,s.sent+64),batch=[];
      for(let i=s.sent;i<stop;i++){
        const d=sub(points[i],s.basis.origin),p=[8192+dot(d,s.basis.u)*s.basis.scale,8192-dot(d,s.basis.v)*s.basis.scale,pressure.length?pressure[Math.min(i,pressure.length-1)]:1,i*8];
        batch.push(p);s.worldPoints.push(points[i]);s.worldNormals.push(xyz(normalAt(normals,i,points.length)));s.nativePoints.push(p);
        const key=Math.floor(p[0]/256)+':'+Math.floor(p[1]/256),cell=s.pointCells.get(key)||[];
        // Geometry needs the local surface, not every repeated paint sample.
        // Preserve native samples separately; bound only this spatial lookup.
        cell.push(s.worldPoints.length-1);if(cell.length>256)cell.splice(1,1);s.pointCells.set(key,cell);
      }
      const body={command:'render',preset:s.preset,previewSession:s.id,streamFrom:s.sent,points:batch,streamTiles:await streamBackground(s,batch)};
      if(!s.started)Object.assign(body,{streamBegin:true,width:16384,height:16384,size:128,color:s.attributes.color.slice(0,3),opacity:s.attributes.color[3]??1,seed:1,streamBackdrop:!!s.meta.samplesBackdrop});
      if(finish&&stop===end)body.streamFinish=true;
      const result=await nativeSerial(body);s.started=true;s.sent=result.streamCount;
      if(body.streamFinish){s.ended=true;return streamedResult(s,result);}
      if(!finish)await showStreamTiles(s,result,active);
      while(result.pendingTiles&&!finish&&active()){
        const drained=await nativeSerial({command:'render',preset:s.preset,previewSession:s.id,streamFrom:s.sent,points:[]});await showStreamTiles(s,drained,active);result.pendingTiles=drained.pendingTiles;
      }
      if(!finish&&!active())return;
    }
    if(finish){
      const result=await nativeSerial({command:'render',preset:s.preset,previewSession:s.id,streamFrom:s.sent,points:[],streamFinish:true});s.ended=true;
      return streamedResult(s,result);
    }
  }
  function finishStream(s,attributes){
    if(!s.final)s.final=s.tail.then(()=>appendStream(s,s.finishAttributes?.points.length>=s.sent?s.finishAttributes:s.latest||attributes,true));return s.final;
  }
  async function liveStroke(holder,attributes,preset,meta,active){
    let s=holder.stream;
    if(!s){s={holder,preset,meta:{...meta,samplesBackdrop:meta.samplesBackdrop||meta.engine==='mypaintbrush'},id:'stroke-'+Date.now()+'-'+(++nextPreviewSession),sent:0,started:false,ended:false,worldPoints:[],worldNormals:[],nativePoints:[],pointCells:new Map(),backdrops:new Map(),tail:Promise.resolve()};holder.stream=s;(gesture.streams??=[]).push(s);}
    s.latest=clone(attributes);delete s.latest.sourceTemplate;
    const job=s.tail.then(()=>appendStream(s,s.latest,false,active));s.tail=job.catch(()=>{});await job;
  }
  function closePreview(cache){
    if(!cache.session||!cache.sessionOpened)return;
    const body={command:"render",preset:cache.preset,previewSession:cache.session,previewEnd:true};cache.sessionOpened=false;
    const closing=renderTail.then(()=>checked(body));renderTail=closing.catch(fail);
  }
  async function renderRecord(id,record,active=()=>true,previewCache=null) {
    if(record.result)return record;
    if(liveRecords.has(record)){
      const s=liveRecords.get(record),finished=await finishStream(s,record.attributes);record.hostAttributes=record.attributes;Object.assign(record,finished);if(id)await save(id,record);liveRecords.delete(record);return record;
    }
    if(rendering.has(record))return rendering.get(record);
    const job=renderTail.then(async()=>{
      if(!active())return null;
      // Rendering a growing prefix must not saturate the app indefinitely.
      // Leave a bounded quiet interval for the host render loop and Pencil.
      if(record.preview)while(now()<previewReadyAt){
        if(!active())return null;
        await new Promise(resolve=>setTimeout(resolve,Math.min(16,previewReadyAt-now())));
      }
      const meta={...await presetInfo(record.preset)};
      if(meta.engine==="mypaintbrush")meta.samplesBackdrop=true;
      if(!active())return null;
      const args=[record.attributes,record.preset,api.fallbackSize,meta,cameraRight()];
      const request=record.preview?await previewRequest(args,active):strokeRequest(...args);
      if(meta.samplesBackdrop){
        // Batch-buffer compaction temporarily removes replacement meshes. Wait
        // for saved paint to return before sampling another brush's substrate.
        await Promise.resolve();await Promise.all([...restoringSurfaces]);
        if(!active())return null;
        const captured=snapshot(request.frame);request.body.backdrop=captured.png;record.surface={encoding:"linear-camera-v3",depth:captured.depth,near:captured.near,far:captured.far,distance:captured.distance};
      }
      const signature=previewCache?JSON.stringify(request.body):null;
      if(record.preview&&meta.previewPixels&&typeof root.fetch==="function")request.body.previewPixels=true;
      else if(record.preview&&meta.previewSessions&&previewCache){
        if(!previewCache.session)previewCache.session='preview-'+Date.now()+'-'+(++nextPreviewSession);
        request.body.previewSession=previewCache.session;previewCache.preset=record.preset;previewCache.sessionOpened=true;
      }
      const started=now(),cached=previewCache?.signature===signature;
      const result=cached?previewCache.result:await checked(request.body);
      if(record.preview&&!cached)previewReadyAt=now()+Math.max(8,(now()-started)*.5);
      if(!active())return null;
      if(previewCache){previewCache.signature=signature;previewCache.result=result;}
      record.frame=request.frame;record.result=result;
      if(id)save(id,record).catch(fail);
      return record;
    });
    rendering.set(record,job);renderTail=job.catch(()=>{});
    try{return await job;}finally{rendering.delete(record);}
  }
  function evict(){for(const [record,entry] of assets){if(textureBytes<=MAX_TEXTURE_BYTES)break;if(entry.refs||!entry.texture)continue;entry.texture.dispose();entry.mask.dispose();textureBytes-=entry.bytes;assets.delete(record);}}
  async function rawPreviewAssets(record,entry,active){
    const r=record.result,w=r.width,h=r.height,n=w*h,budget=workBudget(true,active);
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>4096||h>4096||n>2097152||!/^[-a-fA-F0-9]{36}\.rgba$/.test(r.pixels))throw new Error("Invalid live pixel response.");
    if(!r.pixelBytes){
      const response=await root.fetch('/feather-krita-preview/'+r.pixels,{cache:'no-store'});
      if(!response.ok)throw new Error("Cannot load the live brush pixels.");
      r.pixelBytes=new Uint8Array(await response.arrayBuffer());
    }
    if(r.pixelBytes.length!==n*5)throw new Error("Invalid live pixel dimensions.");
    const coverage=r.pixelBytes.subarray(n*4),rgba=new Uint8Array(n*4),mask=new Uint8Array(n);
    for(let y=0;y<h;y++){
      if(y%32===0){const pause=budget.check();if(pause)await pause;}
      rgba.set(r.pixelBytes.subarray(y*w*4,(y+1)*w*4),(h-1-y)*w*4);
      mask.set(coverage.subarray(y*w,(y+1)*w),(h-1-y)*w);
    }
    entry.rectangles=record.guideSurface&&!record.surface?.depth?[[0,0,w,h]]:await previewCoverage(coverage,w,h,budget,1);
    if(record.surface?.encoding==="linear-camera-v3"){
      const depth=new Image();depth.src="data:image/png;base64,"+record.surface.depth;await depth.decode();
      if(depth.width!==w||depth.height!==h)throw new Error("Invalid live depth dimensions.");
      const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(depth,0,0);entry.depth=ctx.getImageData(0,0,w,h).data;
    }
    // The app does not export its DataTexture class. These are the exact
    // DataTexture fields used by its bundled Three.js WebGLTextures upload path.
    for(const [key,data,format]of [['texture',rgba,1023],['mask',mask,1028]]){
      const texture=new api.Texture();texture.isDataTexture=true;texture.image={data,width:w,height:h};texture.format=format;texture.type=1009;
      texture.flipY=false;texture.unpackAlignment=1;texture.generateMipmaps=false;texture.minFilter=api.LinearFilter;texture.magFilter=api.LinearFilter;texture.needsUpdate=true;entry[key]=texture;
    }
    entry.rawCoverage=true;entry.bytes=n*5;textureBytes+=entry.bytes;return entry;
  }
  async function loadAssets(record,active=()=>true) {
    if(assets.has(record))return assets.get(record).promise;
    const entry={refs:0,preview:!!record.preview,record};assets.set(record,entry);
    entry.promise=(async()=>{
      const result=record.result;
      if(record.preview&&result.pixels)return rawPreviewAssets(record,entry,active);
      const image=new Image(),maskImage=new Image();
      image.src="data:image/png;base64,"+result.png;maskImage.src="data:image/png;base64,"+result.coverage;
      await Promise.all([image.decode(),maskImage.decode()]);
      if(image.width!==result.width||image.height!==result.height||maskImage.width!==result.width||maskImage.height!==result.height)throw new Error("Invalid native brush image dimensions.");
      const exactSurface=record.preview&&record.guideSurface&&!record.surface?.depth;
      let canvas,ctx;
      if(exactSurface){
        // Guide faces already match the final geometry, independently of mask
        // occupancy. Planar previews retain the same occupied rectangles as
        // final paint, including its clipping at the outermost pixel cells.
        entry.rectangles=[[0,0,result.width,result.height]];
      }else{
        canvas=document.createElement("canvas");canvas.width=result.width;canvas.height=result.height;
        ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(maskImage,0,0);
        const coverage=ctx.getImageData(0,0,result.width,result.height).data;
        entry.rectangles=record.preview?await previewCoverage(coverage,result.width,result.height,workBudget(true,active)):coverageRectangles(coverage,result.width,result.height,8);
      }
      // V2 persisted depth with mixed, unrecoverable camera ranges. Preserve
      // its painted pixels but rebuild those surfaces on their original path.
      if(record.surface?.encoding==="linear-camera-v3"){
        const depth=new Image();depth.src="data:image/png;base64,"+record.surface.depth;await depth.decode();
        if(depth.width!==result.width||depth.height!==result.height)throw new Error("Invalid saved brush depth dimensions.");
        ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(depth,0,0);entry.depth=ctx.getImageData(0,0,result.width,result.height).data;
      }
      for(const [key,picture] of [["texture",image],["mask",maskImage]]){
        const texture=new api.Texture(picture);texture.needsUpdate=true;texture.generateMipmaps=false;texture.minFilter=api.LinearFilter;texture.magFilter=api.LinearFilter;entry[key]=texture;
      }
      entry.bytes=result.width*result.height*8;textureBytes+=entry.bytes;return entry;
    })().catch(error=>{assets.delete(record);throw error;});
    return entry.promise;
  }

  function maskSource(source,material) {
    if(!material.userData.fkMask){
      material.vertexShader="attribute float fkHide;\nvarying float fkHidden;\n"+material.vertexShader.replace(/void\s+main\s*\(\s*\)\s*\{/,"$&\n fkHidden = fkHide;");
      material.fragmentShader="varying float fkHidden;\n"+material.fragmentShader.replace(/void\s+main\s*\(\s*\)\s*\{/ ,"$&\n if (fkHidden > 0.5) discard;");
      material.defaultAttributeValues.fkHide=[0];material.userData.fkMask=true;material.needsUpdate=true;
    }
    if(!source.attributes.fkHide || source.attributes.fkHide.count!==source.attributes.position.count)source.setAttribute("fkHide",new api.Attribute(new Float32Array(source.attributes.position.count),1));
    return source.attributes.fkHide;
  }
  function hideCurve(manager,info,state,id) {
    const geom=manager.getGeomFromInfo(info);if(!geom)return;
    const mask=maskSource(geom.geometry,geom.mesh.material),offset=info.geomAttributes,count=info.numOfPoints*4;
    mask.array.fill(1,offset,offset+count);mask.needsUpdate=true;
    state.hidden.set(id,{source:geom.geometry,mask,offset,count});
  }
  function unhideState(state) {
    for(const {source,mask,offset,count} of state.hidden.values())if(source.attributes.fkHide===mask){mask.array.fill(0,offset,offset+count);mask.needsUpdate=true;}
    state.hidden.clear();
  }
  function removeReplacement(state,id){
    const record=state.records.get(id);if(!record)return;
    record.mesh.removeFromParent();record.mesh.geometry.dispose();record.mesh.material.dispose();record.entry.refs--;
    state.records.delete(id);releasePreviewAsset(record.entry);evict();
  }
  function releasePreviewAsset(entry){
    if(!entry?.preview||entry.refs||!assets.has(entry.record))return;
    entry.texture?.dispose();entry.mask?.dispose();textureBytes-=entry.bytes||0;assets.delete(entry.record);
  }
  function clearState(state){
    unhideState(state);state.generation++;state.pending.clear();
    for(const id of [...state.records.keys()])removeReplacement(state,id);
  }
  function materialFor(original,entry,baseColor,size=api.fallbackSize) {
    const material=new api.ShaderMaterial();material.copy(original);
    for(const flag of ["isCurveMaterial","isCutoutMaterial","isSelectionMaterial"])if(flag in original)material[flag]=original[flag];
    material.vertexShader="attribute vec2 fkUV;\nvarying vec2 fkTexCoord;\n"+original.vertexShader.replace(/void\s+main\s*\(\s*\)\s*\{/,"$&\n fkTexCoord = fkUV;");
    const match="vec4 diffuseColor = vColor;";
    if(!original.fragmentShader.includes(match))throw new Error("Unsupported Feather stroke material.");
    material.fragmentShader="varying vec2 fkTexCoord;\nuniform sampler2D fkBrush;\nuniform sampler2D fkCoverage;\nuniform vec4 fkBaseColor;\n"+original.fragmentShader.replace(match,
      "if (any(lessThan(fkTexCoord, vec2(0.0))) || any(greaterThan(fkTexCoord, vec2(1.0)))) discard;\n"+
      "if (texture2D(fkCoverage, fkTexCoord).a < 0.5) discard;\n"+
      "vec4 fkSample = texture2D(fkBrush, fkTexCoord);\n"+
      "fkSample.rgb = clamp(fkSample.rgb + vColor.rgb - fkBaseColor.rgb, 0.0, 1.0);\n"+
      "fkSample.a *= fkBaseColor.a > 0.0001 ? vColor.a / fkBaseColor.a : 0.0;\n"+
      "vec4 diffuseColor = fkSample;");
    if(entry.rawCoverage)material.fragmentShader=material.fragmentShader.replace("texture2D(fkCoverage, fkTexCoord).a","texture2D(fkCoverage, fkTexCoord).r");
    // Feather writes gl_FragDepth explicitly, so fixed-function polygonOffset
    // cannot reliably separate paint from its drawing surface. Apply a small
    // world-space bias in the same linear depth convention as the host.
    if(material.fragmentShader.includes("gl_FragDepth = vDepth;")){
      material.fragmentShader="uniform float fkDepthBias;\nuniform float near;\nuniform float far;\n"+material.fragmentShader.replace("gl_FragDepth = vDepth;","gl_FragDepth = max(0.0, vDepth - fkDepthBias / max(far - near, 0.000001));");
      material.uniforms.fkDepthBias={value:Math.max(Number(size)||api.fallbackSize,0.00001)*0.005};
    }
    material.uniforms.fkBrush={value:entry.texture};material.uniforms.fkCoverage={value:entry.mask};
    material.uniforms.fkBaseColor={value:[baseColor[0]/255,baseColor[1]/255,baseColor[2]/255,baseColor[3]??1]};
    material.defaultAttributeValues.fkHide=[0];
    material.side=2;material.forceSinglePass=true;material.transparent=true;material.blending=1;
    material.depthWrite=false;material.depthTest=true;material.userData.fkPaint=true;
    material.polygonOffset=true;material.polygonOffsetFactor=-1;material.polygonOffsetUnits=-1;
    material.needsUpdate=true;return material;
  }
  function syncUniforms(original,material) {
    for(const [name,uniform] of Object.entries(original.uniforms))material.uniforms[name]=uniform;
    material.uniformsNeedUpdate=true;
    const defines=JSON.stringify(original.defines);
    if(defines!==material.userData.fkDefines){material.defines={...original.defines};material.userData.fkDefines=defines;material.needsUpdate=true;}
  }
  function surfaceHeight(frame,surface,depth,x,y,baseHeight) {
    if(surface?.encoding!=="linear-camera-v3" || !depth)return null;
    if(![surface.near,surface.far,surface.distance,frame.size,baseHeight].every(Number.isFinite)||surface.far<=surface.near)return null;
    const px=clamp(Math.floor(x),0,frame.width-1),py=clamp(Math.floor(y),0,frame.height-1),at=(py*frame.width+px)*4;
    if(depth[at+3]!==255)return null;
    const z=(depth[at]*65536+depth[at+1]*256+depth[at+2])/16777215;
    const height=surface.distance-(surface.near+z*(surface.far-surface.near));
    // Ignore unrelated surfaces beyond the local brush footprint, and invalid
    // far-plane pixels. Never let an outlier pull a vertex across the scene.
    return Number.isFinite(height)&&z<0.999999&&Math.abs(height-baseHeight)<=frame.size*2?height:null;
  }
  function uniformSurfaceAttributes(source,info) {
    // Position, normals and colour come from the raster surface. The remaining
    // Feather attributes (pattern, glow, etc.) are normally constant per stroke.
    // Check them before bypassing expensive nearest-segment searches.
    for(const [name,a]of Object.entries(source.attributes)){
      if(["position","normalUp","normalSide","upDown","color","fkHide"].includes(name))continue;
      if(a.isInterleavedBufferAttribute)return false;
      const begin=info.geomAttributes*a.itemSize,end=Math.min(a.array.length,begin+info.numOfPoints*4*a.itemSize);
      for(let i=begin+a.itemSize;i<end;i++)if(a.array[i]!==a.array[begin+(i-begin)%a.itemSize])return false;
    }
    return true;
  }
  async function surfaceGeometry(source,info,record,entry,attributes,active=()=>true) {
    const budget=workBudget(record.preview,active);
    // Match the support's actual triangles instead of joining tangent-plane
    // rectangles by chords that cut through a curved Guide. Persist only this
    // local patch so hiding/deleting the Guide does not reshape finished paint.
    if(!entry.depth){
      if(!record.guideSurface){const patch=guideSurface(record.frame,record.attributes);if(patch){record.guideSurface=patch;guideDirty.add(record);}}
      if(record.guideSurface)return guidePaintGeometry(source,info,record,attributes,record.guideSurface,budget);
    }
    const {frame}=record,rectangles=[];
    if(record.preview)await prepareSegmentTree(frame,budget);
    const tile=entry.depth?8:32;
    for(const [x0,y0,x1,y1] of entry.rectangles)for(let y=y0;y<y1;y+=tile)for(let x=x0;x<x1;x+=tile){
      if(rectangles.length%64===0){const pause=budget.check();if(pause)await pause;}
      const r=[x,y,Math.min(x+tile,x1),Math.min(y+tile,y1)];rectangles.push({r,progress:locate(frame,(r[0]+r[2])/2,(r[1]+r[3])/2).progress});
    }
    rectangles.sort((a,b)=>a.progress-b.progress);
    const vertices=[],prepared={points:(attributes.points||[]).map(xyz),normals:(attributes.normals||[]).map(xyz)},originalPrepared={points:(record.attributes.points||[]).map(xyz),normals:(record.attributes.normals||[]).map(xyz)};
    const mapped=new Map();
    const pixel=(x,y)=>{
      const key=y*4097+x;let value=mapped.get(key);
      if(!value){
        value=mapPixel(frame,x,y,attributes,prepared);
        mapped.set(key,value);
      }return value;
    };
    let work=0;
    for(const {r:[x0,y0,x1,y1]} of rectangles)for(const [x,y] of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]){
      if(work%64===0){const pause=budget.check();if(pause)await pause;}
      if(++work%1024===0&&!record.preview)await new Promise(resolve=>setTimeout(resolve,0));
      const vertex={x,y,...pixel(x,y)};
      if(entry.depth){
        const original=mapPixel(frame,x,y,record.attributes,originalPrepared).position,baseHeight=dot(sub(original,frame.origin),frame.normal);
        const height=surfaceHeight(frame,record.surface,entry.depth,x,y,baseHeight);
        vertex.sampledHeight=height;
        if(height!==null){
          const projected=add(frame.origin,add(mul(frame.u,frame.minX+x/frame.scale),add(mul(frame.v,frame.maxY-y/frame.scale),mul(frame.normal,height))));
          vertex.position=add(vertex.position,sub(projected,original));
        }
      }
      vertices.push(vertex);
    }
    const geometry=new api.Geometry();
    for(const [name,attribute] of Object.entries(source.attributes)){
      if(name==="fkHide")continue;
      if(attribute.isInterleavedBufferAttribute)throw new Error("Unsupported interleaved stroke attributes.");
      const array=new attribute.array.constructor(vertices.length*attribute.itemSize);
      for(let i=0;i<vertices.length;i++){
        if(i%256===0){const pause=budget.check();if(pause)await pause;}const vertex=vertices[i];
        const src=info.geomAttributes+Math.min(info.numOfPoints-1,Math.round(vertex.progress*(info.numOfPoints-1)))*4;
        for(let k=0;k<attribute.itemSize;k++)array[i*attribute.itemSize+k]=attribute.array[src*attribute.itemSize+k];
        if(name==="position")array.set(vertex.position,i*3);
        else if(name==="normalUp"||name==="normalSide")array.set(vertex.normal,i*3);
        else if(name==="upDown")array[i]=0;
        else if(name==="color")array.set([...(attributes.color || [0,0,0]).slice(0,3),Math.round((attributes.color?.[3]??1)*255)],i*4);
      }
      geometry.setAttribute(name,new api.Attribute(array,attribute.itemSize,attribute.normalized));
    }
    const uv=new Float32Array(vertices.length*2);vertices.forEach((p,i)=>{uv[i*2]=p.x/frame.width;uv[i*2+1]=1-p.y/frame.height;});
    geometry.setAttribute("fkUV",new api.Attribute(uv,2));
    const indices=[];
    rectangles.forEach((_,i)=>{
      for(const triangle of [[i*4,i*4+2,i*4+1],[i*4,i*4+3,i*4+2]]){
        // Do not bridge a silhouette or two disconnected substrate layers.
        // Such edges are the other source of long, needle-like triangles.
        if(entry.depth){
          const values=triangle.map(k=>vertices[k].sampledHeight),valid=values.filter(v=>v!==null);
          if(valid.length&&valid.length!==3)continue;
          if(valid.length){const tolerance=Math.max(frame.size*.1,Math.SQRT2*tile/frame.scale*3);if(Math.max(...valid)-Math.min(...valid)>tolerance)continue;}
        }
        indices.push(...triangle);
      }
    });
    geometry.setIndex(new api.Attribute(new Uint32Array(indices),1));geometry.computeBoundingSphere();return geometry;
  }
  function updatePreviewGeometry(target,next){
    const attributes={...next.attributes,index:next.index},previous={...target.attributes,index:target.index};
    const fits=(a,b)=>a&&a.itemSize===b.itemSize&&a.normalized===b.normalized&&a.array.constructor===b.array.constructor&&a.array.length>=b.array.length;
    // Like Feather's fixed preview buffers: update existing GPU allocations.
    // Grow only at capacity boundaries, releasing the previous GL buffers first.
    if(Object.entries(attributes).some(([name,a])=>!fits(previous[name],a))||Object.keys(target.attributes).some(name=>!next.attributes[name]))target.dispose();
    for(const name of Object.keys(target.attributes))if(!next.attributes[name])target.deleteAttribute(name);
    for(const [name,a]of Object.entries(attributes)){
      let current=previous[name];
      if(!fits(current,a)){
        const capacity=2**Math.ceil(Math.log2(Math.max(1,a.count)))*a.itemSize;
        current=new api.Attribute(new a.array.constructor(capacity),a.itemSize,a.normalized);
        if(name==="index")target.setIndex(current);else target.setAttribute(name,current);
      }
      current.array.set(a.array);current.clearUpdateRanges?.();current.addUpdateRange?.(0,a.array.length);current.needsUpdate=true;
    }
    target.userData.fkUsedIndices=next.index.count;target.boundingSphere=next.boundingSphere;target.boundingBox=next.boundingBox;
    next.dispose();return target;
  }
  async function replaceCurve(manager,state,id,info,record,entry,attributes,active=()=>true) {
    const geom=manager.getGeomFromInfo(info);if(!geom?.geometry?.index)return;
    // Pin textures while yielding between geometry chunks. Another curve can
    // finish and evict unreferenced cache entries during those yields.
    entry.refs++;
    let geometry;
    try{geometry=await surfaceGeometry(geom.geometry,info,record,entry,attributes,active);}catch(error){entry.refs--;releasePreviewAsset(entry);evict();throw error;}
    if(!active()){geometry.dispose();entry.refs--;releasePreviewAsset(entry);evict();return;}
    const previous=state.records.get(id),reuse=record.preview&&previous?.sourceMaterial===geom.mesh.material&&previous.composited===!!record.result.composited;
    if(!reuse)removeReplacement(state,id);
    const material=reuse?previous.mesh.material:materialFor(geom.mesh.material,entry,record.attributes.color || [0,0,0,1],attributes.size);
    if(reuse){
      geometry=updatePreviewGeometry(previous.mesh.geometry,geometry);
      material.uniforms.fkBrush.value=entry.texture;material.uniforms.fkCoverage.value=entry.mask;
      const color=record.attributes.color||[0,0,0,1];material.uniforms.fkBaseColor.value=[color[0]/255,color[1]/255,color[2]/255,color[3]??1];
      if(material.uniforms.fkDepthBias)material.uniforms.fkDepthBias.value=Math.max(Number(attributes.size)||api.fallbackSize,.00001)*.005;
    }
    if(!reuse&&record.result.composited){
      material.blending=5;material.blendSrc=201;material.blendDst=200;material.blendSrcAlpha=201;material.blendDstAlpha=200;
      // The backdrop already contains host shading/patterns. Do not shade it a
      // second time after Krita has blended its colors.
      if(material.fragmentShader.includes("out vec4 gColor"))material.fragmentShader=material.fragmentShader.replace(/}\s*$/,"gColor = fkSample; gBloom = vec4(0.0, 0.0, 0.0, fkSample.a);\n}");
    }
    const mesh=reuse?previous.mesh:new api.Mesh(geometry,material);mesh.castShadow=geom.mesh.castShadow;mesh.receiveShadow=geom.mesh.receiveShadow;
    mesh.renderOrder=record.preview?Number.MAX_SAFE_INTEGER-1:paintOrder(id,record.paintOrder);mesh.matrixAutoUpdate=false;mesh.matrix.copy(geom.mesh.matrix);
    mesh.onBeforeRender=()=>syncUniforms(geom.mesh.material,material);
    const indexCount=info.fkIndexCount??((info.numOfPoints-1)*24+12);
    const syncVisibility=()=>{
      mesh.visible=geom.mesh.visible;mesh.matrix.copy(geom.mesh.matrix);mesh.matrixWorldNeedsUpdate=true;
      const start=geom.geometry.drawRange.start,end=start+geom.geometry.drawRange.count;
      const first=clamp((start-info.geomIndex)/indexCount,0,1),last=clamp((end-info.geomIndex)/indexCount,0,1);
      const used=geometry.userData.fkUsedIndices??geometry.index.count;
      const begin=Math.floor(first*used/6)*6,finish=Math.floor(last*used/6)*6;
      geometry.setDrawRange(begin,Math.max(0,finish-begin));
    };
    syncVisibility();if(!reuse)manager.sceneGroup.add(mesh);
    hideCurve(manager,info,state,id);state.records.set(id,{mesh,entry,syncVisibility,info,source:geom.geometry,sourceMaterial:geom.mesh.material,composited:!!record.result.composited});
    if(reuse){previous.entry.refs--;releasePreviewAsset(previous.entry);}evict();api.redraw?.();
    if(guideDirty.has(record)&&!record.preview){guideDirty.delete(record);save(id,record).catch(fail);}
  }
  function register(manager){if(!states.has(manager)){states.set(manager,{depth:0,generation:0,records:new Map(),hidden:new Map(),pending:new Map(),dirty:new Set()});managers.add(manager);}return states.get(manager);}
  function synchronize(manager) {
    const state=states.get(manager);if(!state||state.depth)return;
    for(const id of [...state.records.keys()])if(!manager.curveIdToGeomInfo.has(id))removeReplacement(state,id);
    for(const id of [...state.pending.keys()])if(!manager.curveIdToGeomInfo.has(id))state.pending.delete(id);
    for(const [id,info] of manager.curveIdToGeomInfo){
      const previous=state.records.get(id),pending=state.pending.get(id),dirty=state.dirty.has(id);
      if(previous?.info===info&&!dirty){hideCurve(manager,info,state,id);previous.syncVisibility();continue;}
      if(pending?.info===info&&!dirty){if(previous||pending.masked)hideCurve(manager,info,state,id);continue;}
      let attributes=latestAttributes.get(info)||info.attributes;const token={info};state.pending.set(id,token);
      const generation=state.generation;
      const active=()=>generation===state.generation&&state.pending.get(id)===token&&manager.curveIdToGeomInfo.get(id)===info;
      const saved=info.fkRecord?Promise.resolve(info.fkRecord):artwork(id);
      saved.then(async record=>{
        if(!record||!active())return;
        if(record.hostAttributes&&sameHostPath(attributes,record.hostAttributes))attributes={...record.attributes,color:attributes.color,materialStyle:attributes.materialStyle};
        hideCurve(manager,info,state,id);
        token.masked=true;
        const restore=async()=>{const entry=await loadAssets(record);if(active())await replaceCurve(manager,state,id,info,record,entry,attributes,active);};
        if(record.result){const ready=restore();restoringSurfaces.add(ready);try{await ready;}finally{restoringSurfaces.delete(ready);}return;}
        const rendered=await renderRecord(info.fkRecord?null:id,record,info.fkRecord?active:()=>true);
        if(!rendered||!active())return;
        if(record.hostAttributes&&sameHostPath(attributes,record.hostAttributes))attributes={...record.attributes,color:attributes.color,materialStyle:attributes.materialStyle};
        const ready=restore();restoringSurfaces.add(ready);try{await ready;}finally{restoringSurfaces.delete(ready);}
      }).catch(error=>{
        if(active()){const h=state.hidden.get(id);if(h){h.mask.array.fill(0,h.offset,h.offset+h.count);h.mask.needsUpdate=true;state.hidden.delete(id);}}
        fail(error);
      }).finally(()=>{if(state.pending.get(id)===token)state.pending.delete(id);});
    }
    state.dirty.clear();
  }
  function attach(Manager,constructors) {
    if(attached)return;api=constructors;attached=true;
    for(const name of ["makeCurves","makeCurve","updateCurve","copyCurveGeom","removeCurve","removeCurves","clear"]){
      const original=Manager.prototype[name];if(typeof original!=="function")throw new Error("Missing Feather operation: "+name);
      Manager.prototype[name]=function(...args){
        const state=register(this);if(state.depth++===0)unhideState(state);
        if(name==="makeCurve")state.dirty.add(args[0]);
        if(name==="updateCurve")for(const [id,info]of this.curveIdToGeomInfo)if(info===args[0])state.dirty.add(id);
        if(name==="copyCurveGeom")state.dirty.add(args[0]?.curveId);
        try{const result=original.apply(this,args);
          if(name==="makeCurve"&&this.curveIdToGeomInfo.has(args[0]))latestAttributes.set(this.curveIdToGeomInfo.get(args[0]),args[1]);
          if(name==="updateCurve"&&args[0]&&args[1])latestAttributes.set(args[0],args[1]);
          return result;
        }finally{state.depth--;if(!state.depth){if(name==="clear"){clearState(state);managers.delete(this);}else{managers.add(this);synchronize(this);}}}
      };
    }
    for(const name of ["turnOnOff","timelapse"]){const original=Manager.prototype[name];if(typeof original!=="function")continue;Manager.prototype[name]=function(...args){const result=original.apply(this,args);for(const r of states.get(this)?.records.values()||[])r.syncVisibility();return result;};}
    const ready=()=>post({command:"ready"}).catch(fail);
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>setTimeout(ready,250),{once:true});else setTimeout(ready,250);
  }
  function setBindings(next){
    bindings=Object.fromEntries(Object.entries(next).filter(([shape,id])=>SHAPES.includes(shape)&&typeof id==="string"));
    for(const [mesh,state] of hoverStates)hover(mesh,state.attributes,state.distance);
  }
  function hoverPositions(polygons,size,u=[1,0,0],v=[0,0,-1]){
    const positions=[];
    for(const polygon of polygons || []){
      if(!Array.isArray(polygon)||polygon.length<2)continue;
      if(polygon.some(p=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])))throw new Error("Invalid native brush outline.");
      for(let i=0;i<polygon.length;i++){
        const p=polygon[i],q=polygon[(i+1)%polygon.length];if(p[0]===q[0]&&p[1]===q[1])continue;
        for(const a of [p,q])positions.push(...add(mul(u,a[0]*size),mul(v,-a[1]*size)));
      }
    }
    if(positions.length>600000)throw new Error("The brush outline is too complex.");
    return new Float32Array(positions);
  }
  function releaseHover(state){
    state.generation++;
    if(state.mask){state.mask.array.fill(0);state.mask.needsUpdate=true;state.mask=null;}
    if(state.line){state.line.removeFromParent();state.line.geometry.dispose();state.line.material.dispose();state.line=null;}
    state.preset=null;state.outline=null;
  }
  function updateHover(mesh,state){
    if(!state.line)return;
    mesh.updateWorldMatrix(true,false);
    const origin=mesh.getWorldPosition(new api.Vector3());
    const n=new api.Vector3(0,1,0).transformDirection(mesh.matrixWorld).toArray();
    const right=cameraRight(),u=unit(sub(right,mul(n,dot(right,n))),unit(cross([0,0,1],n),[1,0,0])),v=unit(cross(n,u));
    const local=a=>mesh.worldToLocal(new api.Vector3(...a).add(origin)).toArray();
    const size=Number(state.attributes.size)>0?Number(state.attributes.size):api.fallbackSize;
    const positions=hoverPositions(state.outline,size,local(u),local(v));
    const attribute=state.line.geometry.attributes.position;
    if(attribute&&attribute.array.length===positions.length){attribute.array.set(positions);attribute.needsUpdate=true;}
    else state.line.geometry.setAttribute("position",new api.Attribute(positions,3));
    state.line.geometry.computeBoundingSphere();
    const color=state.attributes.color || [0,0,0];
    state.line.material.uniforms.fkHoverColor.value=color.slice(0,3).map(c=>c/255);
    state.line.material.uniforms.fkHoverOpacity.value=clamp(1-Number(state.distance||0),0,1);
    state.line.visible=true;
    if(!state.mask)state.mask=maskSource(mesh.geometry,mesh.material);
    state.mask.array.fill(1);state.mask.needsUpdate=true;
  }
  function hover(mesh,attributes,distance=0){
    if(!attached||!mesh?.parent)return;
    let state=hoverStates.get(mesh);
    if(!state){state={generation:0,line:null,mask:null,preset:null};hoverStates.set(mesh,state);
      state.removed=()=>{releaseHover(state);hoverStates.delete(mesh);mesh.removeEventListener("removed",state.removed);};
      mesh.addEventListener("removed",state.removed);}
    state.attributes=attributes;state.distance=distance;
    const preset=bindings[attributes.shape];
    if(!preset){releaseHover(state);api.redraw?.();return;}
    if(state.preset===preset){updateHover(mesh,state);return;}
    releaseHover(state);state.preset=preset;const generation=state.generation;
    presetInfo(preset).then(meta=>{
      if(state.generation!==generation||bindings[state.attributes.shape]!==preset||!mesh.parent)return;
      const outline=meta.outline || [];
      if(!hoverPositions(outline,1).length)throw new Error("This native brush returned no cursor outline.");
      const geometry=new api.Geometry();
      const material=new api.ShaderMaterial({glslVersion:"300 es",depthTest:false,depthWrite:false,transparent:true,
        uniforms:{fkHoverColor:{value:[0,0,0]},fkHoverOpacity:{value:1}},
        vertexShader:"void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader:"uniform vec3 fkHoverColor;uniform float fkHoverOpacity;layout(location=0)out vec4 gColor;layout(location=1)out vec4 gBloom;void main(){gColor=vec4(fkHoverColor,fkHoverOpacity);gBloom=vec4(0.0,0.0,0.0,fkHoverOpacity);}"});
      state.outline=outline;state.line=new api.LineSegments(geometry,material);state.line.name="Krita brush hover";state.line.renderOrder=100000;state.line.frustumCulled=false;
      mesh.add(state.line);updateHover(mesh,state);api.redraw?.();
    }).catch(error=>{if(state.generation===generation){releaseHover(state);fail(error);}});
  }
  function hoverEnd(mesh){const state=hoverStates.get(mesh);if(state){releaseHover(state);hoverStates.delete(mesh);mesh.removeEventListener("removed",state.removed);}if(mesh)mesh.visible=false;}
  function attachSelection(Manager){
    for(const name of ["applyMatrix","resetMatrix"]){const original=Manager.prototype[name];if(typeof original!=="function")continue;
      Manager.prototype[name]=function(...args){const result=original.apply(this,args);for(const record of states.get(this)?.records.values()||[])record.syncVisibility();return result;};
    }
  }
  function pressureInput(pressures,count,shape,enabled=true){
    if(!(gesture?.bindings||bindings)[shape])return undefined;
    if(!enabled||!pressures?.length)return [];
    return Array.from({length:count},(_,i)=>{
      const f=i*(pressures.length-1)/Math.max(1,count-1),j=Math.floor(f);
      return clamp(pressures[j]*(1-(f-j))+(pressures[Math.min(j+1,pressures.length-1)]||0)*(f-j),0,1);
    });
  }
  function endInputPreview(host){
    const input=inputPreviews.get(host);if(!input)return;
    input.generation++;input.latest=null;input.active=false;clearTimeout(input.timer);input.timer=null;
    for(const mesh of host.getState().meshes)preview(mesh,{});
    gesture=null;
  }
  function inputPreview(host,event){
    if(!attached||!api.projectPreview||!api.createPreview)return false;
    const brush=api.currentBrush?.();if(!brush||!(gesture?.bindings||bindings)[brush.shape])return false;
    if(!gesture)gesture={bindings:{...bindings}};
    let input=inputPreviews.get(host);
    if(!input){input={latest:null,running:false,active:false,generation:0,timer:null};inputPreviews.set(host,input);}
    input.active=true;input.latest=event;
    const run=async()=>{
      input.timer=null;if(input.running||!input.latest||!input.active)return;
      input.running=true;const generation=input.generation,active=()=>input.active&&generation===input.generation;
      const event=input.latest;input.latest=null;
      try{
        const source=host.getState(),b=api.currentBrush(),pointers=event.clientPointers;
        if(!api.previewReady(pointers))return;
        // Use exactly Feather's surface projection, cached intersections,
        // spline and mirror transforms, but never build the hidden host tube.
        const projected=api.projectPreview(pointers,source),mirrors=api.previewMirrors(),pending=[],paths=[];
        let index=0;
        for(let part=0;part<projected.splinePointsArray.length;part++){
          const path=projected.splinePointsArray[part],normals=projected.normalsArray[part];if(path.length<2)continue;
          const pressures=pressureInput(event.pressures,path.length,b.shape,b.pressureParameter!=="OFF");
          for(const matrix of mirrors){
            if(!active())return;
            if(source.meshes.length<=index)api.createPreview(host);
            const mesh=source.meshes[index++],geometry=mesh.geometry;
            const normalMatrix=matrix.clone().transpose().invert();
            const points=path.map(p=>p.clone().applyMatrix4(matrix)),surfaceNormals=normals.map(n=>n.clone().applyMatrix4(normalMatrix));
            paths.push(points);
            if(!geometry.drawRange.count)mesh.material=api.previewMaterial();
            // The replacement geometry supplies positions/normals/color itself;
            // only constant host material attributes need a four-vertex source.
            for(let i=0;i<4;i++){geometry.attributes.position.setXYZ(i,points[0].x,points[0].y,points[0].z);geometry.attributes.color.setXYZW(i,b.color[0],b.color[1],b.color[2],Math.round(b.opacity*255));}
            const style=b.materialStyle;
            const set=(name,values,Type=Float32Array)=>{
              let a=geometry.attributes[name];if(!a){a=new api.Attribute(new Type(4*values.length),values.length);geometry.setAttribute(name,a);}
              for(let i=0;i<4;i++)a.array.set(values,i*values.length);a.needsUpdate=true;
            };
            if((style.type==="SHADED"||style.type==="FLAT")&&style.pattern!=="NONE")set("properties",[style.density,style.rotation,style.contrast]);
            mesh.castShadow=mesh.receiveShadow=style.type==="SHADED"&&!!api.previewShading();
            if(mesh.castShadow){set("normalUp",[0,0,1]);set("normalSide",[0,0,1]);set("upDown",[0],Uint8Array);}
            if(style.type==="GLOW"&&api.previewShading())set("intensity",[(style.intensity||0)*255],Uint16Array);
            geometry.index.array.set([0,2,1,0,3,2]);geometry.index.needsUpdate=true;geometry.setDrawRange(0,6);
            geometry.attributes.position.needsUpdate=true;geometry.attributes.color.needsUpdate=true;
            pending.push(preview(mesh,{shape:b.shape,color:[...b.color,b.opacity],size:b.size,materialStyle:style,points,normals:surfaceNormals,pressures,sourceTemplate:true}));
          }
        }
        const ongoing=gesture;
        for(let i=index;i<source.meshes.length;i++){source.meshes[i].geometry.setDrawRange(0,0);preview(source.meshes[i],{});}
        gesture=ongoing;
        if(paths.length)api.notifyPreview(host,paths);
        await Promise.all(pending);
      }catch(error){if(active())fail(error);}finally{
        input.running=false;if(input.active&&input.latest)input.timer=setTimeout(run,0);
      }
    };
    // At most one latest input snapshot waits while native paint is busy.
    if(!input.running&&input.timer===null)input.timer=setTimeout(run,0);
    return true;
  }
  function preview(mesh,attributes) {
    if(!attached||!mesh?.parent)return;
    let holder=previews.get(mesh);
    const stop=!mesh.geometry.drawRange.count||!attributes.shape;
    if(stop){
      if(holder){holder.epoch++;clearTimeout(holder.timer);holder.timer=null;holder.latest=null;holder.signature=null;closePreview(holder.cache);holder.cache={};const s=holder.stream;holder.stream=null;if(s&&!s.claimed)s.tail.then(()=>s.started&&!s.ended?nativeSerial({command:'render',preset:s.preset,previewSession:s.id,previewEnd:true}):null).catch(fail);clearState(states.get(holder.manager));holder.manager.curveIdToGeomInfo.clear();}
      gesture=null;return;
    }
    if(!gesture)gesture={bindings:{...bindings}};
    const preset=gesture.bindings[attributes.shape];if(!preset)return;
    if(!holder){
      const manager={sceneGroup:mesh.parent,curveIdToGeomInfo:new Map(),getGeomFromInfo:()=>({geometry:mesh.geometry,mesh})};
      holder={manager,timer:null,latest:null,epoch:0,running:false,disposed:false,signature:null,cache:{}};previews.set(mesh,holder);register(manager);
      mesh.addEventListener("removed",()=>{holder.disposed=true;holder.epoch++;holder.latest=null;closePreview(holder.cache);holder.cache={};holder.signature=null;clearTimeout(holder.timer);clearState(states.get(manager));managers.delete(manager);});
    }
    const count=attributes.points?.length || 0;
    if(count<2)return;
    const state=states.get(holder.manager);
    // Display only full native stroke results. Keep the last completed image
    // visible while the next whole-path render is running; never replace it with
    // independently stamped tips or stretch it to a newer path's bounds.
    const mask=maskSource(mesh.geometry,mesh.material);mask.array.fill(1);mask.needsUpdate=true;
    state.hidden.set("preview",{source:mesh.geometry,mask,offset:0,count:mask.count});
    holder.latest={attributes,preset,indexCount:mesh.geometry.drawRange.count};
    const run=async()=>{
      holder.timer=null;if(holder.running||holder.disposed||!holder.latest)return;
      const latest=holder.latest;holder.latest=null;holder.running=true;
      const epoch=holder.epoch,active=()=>!holder.disposed&&epoch===holder.epoch&&!!mesh.parent;
      try{
        const meta=await presetInfo(latest.preset);if(!active())return;
        if(meta.strokeStreaming===1&&typeof root.fetch==='function'){await liveStroke(holder,latest.attributes,latest.preset,meta,active);return;}
        const signature=JSON.stringify([latest.preset,latest.attributes,cameraRight()]);
        if(signature===holder.signature)return;
        const a=clone(latest.attributes);
        // The host keeps raw normals separate from densified positions. Use the
        // same raw normals as its committed stroke when constructing the native
        // raster frame; the renderer handles their interpolation for geometry.
        if(a.renderNormals?.length)a.normals=a.renderNormals;
        delete a.renderNormals;
        const sourceTemplate=a.sourceTemplate;delete a.sourceTemplate;
        const record={version:2,preset:latest.preset,preview:true,attributes:a};
        const rendered=await renderRecord(null,record,active,holder.cache);
        if(!rendered||!active())return;
        const info={attributes:a,numOfPoints:sourceTemplate?1:a.points.length,geomAttributes:0,geomIndex:0,fkIndexCount:latest.indexCount};
        if(!record.surface?.depth){
          record.guideSurface=guideSurface(record.frame,a);
        }
        const entry=await loadAssets(record,active);if(!active()){releasePreviewAsset(entry);return;}
        holder.manager.curveIdToGeomInfo.set("preview",info);
        await replaceCurve(holder.manager,state,"preview",info,record,entry,a,active);
        if(active())holder.signature=signature;
      }catch(error){if(active())fail(error);}finally{
        holder.running=false;
        // Let the host render and process Pencil input before another prefix.
        if(holder.latest&&!holder.disposed)holder.timer=setTimeout(run,0);
      }
    };
    if(!holder.running){holder.work=run();return holder.work;}
    return holder.work;
  }
  function savePreset(id,shape){post({command:"savePreset",id,shape}).catch(fail);}
  async function selectPreset(id,shape){try{const result=await checked({command:"selectPreset",id,shape});if(result.bindings)setBindings(result.bindings);}catch(error){fail(error);}}
  root.FeatherKrita={attach,attachSelection,setBindings,inputPreview,endInputPreview,preview,pressureInput,normalAt,hover,hoverEnd,birth,inherit,savePreset,selectPreset};
  if(typeof module!=="undefined")module.exports={strokeRequest,coverageRectangles,mapPixel,surfaceHeight,hoverPositions,normalAt,SHAPES};
})(globalThis);
