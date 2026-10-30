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
  let renderTail = Promise.resolve(), textureBytes = 0;
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

  // One isotropic projection, not arc-length UVs wrapped around a host tube.
  // A nonplanar path is lifted back onto its local drawing surface at mesh time.
  function strokeRequest(attributes, preset, fallbackSize=0.01, meta={}, cameraRight=[1,0,0]) {
    const points = attributes.points?.map(xyz);
    if (!points?.length || points.some(p=>p.length!==3 || p.some(v=>!Number.isFinite(v)))) throw new Error("Invalid 3D stroke coordinates.");
    const size = Number(attributes.size)>0 ? Number(attributes.size) : fallbackSize;
    const normals = (attributes.normals || []).map(xyz);
    let normal = unit(normals.reduce((a,p)=>add(a,p),[0,0,0]));
    if (normals.some(p=>p.some(v=>!Number.isFinite(v)))) throw new Error("Invalid stroke normals.");
    let u = sub(cameraRight,mul(normal,dot(cameraRight,normal)));
    if (Math.hypot(...u)<1e-6) u=cross([0,1,0],normal);
    u=unit(u,[1,0,0]); const v=unit(cross(normal,u));
    const origin=points[0], projected=points.map(p=>{const d=sub(p,origin);return [dot(d,u),dot(d,v)];});
    const margin=size*Math.max(0.75,(Number(meta.extent)||1)*0.6,meta.samplesBackdrop?3:0);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of projected){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}
    minX-=margin;minY-=margin;maxX+=margin;maxY+=margin;
    const w=maxX-minX,h=maxY-minY;
    const scale=Math.min((meta.preview?64:128)/size,4094/w,4094/h,Math.sqrt((meta.preview?260000:2090000)/(w*h)))*0.999;
    const width=Math.max(2,Math.ceil(w*scale)),height=Math.max(2,Math.ceil(h*scale));
    maxX=minX+width/scale;minY=maxY-height/scale;
    const pressures=attributes.pressures || [];
    const input=projected.map((p,i)=>[(p[0]-minX)*scale,(maxY-p[1])*scale,
      pressures.length?clamp(Number(pressures[Math.min(i,pressures.length-1)]),0,1):1,i*8]);
    if(input.some(p=>p.some(v=>!Number.isFinite(v))))throw new Error("Invalid brush pressure.");
    const sampled=input.length<=4096?input:Array.from({length:4096},(_,i)=>input[Math.round(i*(input.length-1)/4095)]);
    const color=attributes.color || [0,0,0,1];
    return {body:{command:"render",preset,width,height,size:size*scale,points:sampled,color:color.slice(0,3),opacity:color[3]??1,seed:1},
      frame:{origin,u,v,normal,minX,minY,maxX,maxY,scale,width,height,points,normals,projected,size}};
  }

  // Merge occupied pixel runs, retaining holes and irregular brush-tip edges.
  // Fragment coverage still clips exact pixels if a noisy mask needs coarser cells.
  function coverageRectangles(rgba,width,height,minimumStep=1) {
    if(rgba.length!==width*height*4)throw new Error("Invalid brush coverage dimensions.");
    for(let step=minimumStep;step<=16;step*=2){
      const rectangles=[],open=new Map();
      for(let y=0;y<height;y+=step){
        const runs=[];let start=-1;
        for(let x=0;x<=width;x+=step){
          let occupied=false;
          if(x<width)for(let yy=y;yy<Math.min(y+step,height)&&!occupied;yy++)for(let xx=x;xx<Math.min(x+step,width);xx++)if(rgba[(yy*width+xx)*4+3]){occupied=true;break;}
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
  const segmentTrees=new WeakMap();
  function segmentTree(frame) {
    if(segmentTrees.has(frame))return segmentTrees.get(frame);
    const parts=frame.projected.slice(0,-1).map((p,i)=>{const q=frame.projected[i+1];return {i,minX:Math.min(p[0],q[0]),maxX:Math.max(p[0],q[0]),minY:Math.min(p[1],q[1]),maxY:Math.max(p[1],q[1])};});
    function build(list){
      const node={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
      for(const p of list){node.minX=Math.min(node.minX,p.minX);node.minY=Math.min(node.minY,p.minY);node.maxX=Math.max(node.maxX,p.maxX);node.maxY=Math.max(node.maxY,p.maxY);}
      if(list.length<=8)node.items=list;else{const axis=node.maxX-node.minX>node.maxY-node.minY?"X":"Y";list.sort((a,b)=>(a['min'+axis]+a['max'+axis])-(b['min'+axis]+b['max'+axis]));const mid=list.length>>1;node.left=build(list.slice(0,mid));node.right=build(list.slice(mid));}return node;
    }
    const tree=build(parts);segmentTrees.set(frame,tree);return tree;
  }
  function locate(frame,x,y) {
    const p=[frame.minX+x/frame.scale,frame.maxY-y/frame.scale];
    let best=Infinity,index=0,t=0;
    const distance=node=>Math.max(node.minX-p[0],0,p[0]-node.maxX)**2+Math.max(node.minY-p[1],0,p[1]-node.maxY)**2;
    function visit(node){
      if(distance(node)>best)return;
      if(!node.items){if(distance(node.left)<distance(node.right)){visit(node.left);visit(node.right);}else{visit(node.right);visit(node.left);}return;}
      for(const {i} of node.items){
      const a=frame.projected[i],b=frame.projected[i+1],dx=b[0]-a[0],dy=b[1]-a[1];
      const f=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1),0,1);
      const d=(p[0]-a[0]-f*dx)**2+(p[1]-a[1]-f*dy)**2;
      if(d<best){best=d;index=i;t=f;}
      }
    }
    visit(segmentTree(frame));
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
    const record={version:2,preset,attributes:clone(attributes)};
    artworks.set(id,Promise.resolve(record));save(id,record).catch(fail);
  }
  function artwork(id) {
    if(!artworks.has(id))artworks.set(id,checked({command:"loadStroke",id}).then(r=>r.record));
    return artworks.get(id);
  }
  function inherit(id,source) {
    const pending=artwork(source).then(async original=>{if(!original)return null;const record=clone(original);await save(id,record);return record;});
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
        for(const [name,value] of [["near",near],["far",far]]){
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
  async function renderRecord(id,record,active=()=>true) {
    if(record.result)return record;
    if(rendering.has(record))return rendering.get(record);
    const job=renderTail.then(async()=>{
      if(!active())return null;
      const meta={...await presetInfo(record.preset),preview:!!record.preview};
      if(meta.engine==="mypaintbrush")meta.samplesBackdrop=true;
      if(!active())return null;
      const request=strokeRequest(record.attributes,record.preset,api.fallbackSize,meta,cameraRight());
      if(meta.samplesBackdrop){
        // Batch-buffer compaction temporarily removes replacement meshes. Wait
        // for saved paint to return before sampling another brush's substrate.
        await Promise.resolve();await Promise.all([...restoringSurfaces]);
        if(!active())return null;
        const captured=snapshot(request.frame);request.body.backdrop=captured.png;record.surface={encoding:"linear-camera-v3",depth:captured.depth,near:captured.near,far:captured.far,distance:captured.distance};
      }
      const result=await checked(request.body);
      if(!active())return null;
      record.frame=request.frame;record.result=result;
      if(id)save(id,record).catch(fail);
      return record;
    });
    rendering.set(record,job);renderTail=job.catch(()=>{});
    try{return await job;}finally{rendering.delete(record);}
  }
  function evict(){for(const [record,entry] of assets){if(textureBytes<=MAX_TEXTURE_BYTES)break;if(entry.refs||!entry.texture)continue;entry.texture.dispose();entry.mask.dispose();textureBytes-=entry.bytes;assets.delete(record);}}
  async function loadAssets(record) {
    if(assets.has(record))return assets.get(record).promise;
    const entry={refs:0};assets.set(record,entry);
    entry.promise=(async()=>{
      const result=record.result;
      const image=new Image(),maskImage=new Image();
      image.src="data:image/png;base64,"+result.png;maskImage.src="data:image/png;base64,"+result.coverage;
      await Promise.all([image.decode(),maskImage.decode()]);
      if(image.width!==result.width||image.height!==result.height||maskImage.width!==result.width||maskImage.height!==result.height)throw new Error("Invalid native brush image dimensions.");
      const canvas=document.createElement("canvas");canvas.width=result.width;canvas.height=result.height;
      const ctx=canvas.getContext("2d");ctx.drawImage(maskImage,0,0);
      entry.rectangles=coverageRectangles(ctx.getImageData(0,0,result.width,result.height).data,result.width,result.height,8);
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
    state.records.delete(id);evict();
  }
  function clearState(state){
    unhideState(state);state.generation++;state.pending.clear();
    for(const id of [...state.records.keys()])removeReplacement(state,id);
  }
  function materialFor(original,entry,baseColor) {
    const material=new api.ShaderMaterial();material.copy(original);
    for(const flag of ["isCurveMaterial","isCutoutMaterial","isSelectionMaterial"])if(flag in original)material[flag]=original[flag];
    material.vertexShader="attribute vec2 fkUV;\nvarying vec2 fkTexCoord;\n"+original.vertexShader.replace(/void\s+main\s*\(\s*\)\s*\{/,"$&\n fkTexCoord = fkUV;");
    const match="vec4 diffuseColor = vColor;";
    if(!original.fragmentShader.includes(match))throw new Error("Unsupported Feather stroke material.");
    material.fragmentShader="varying vec2 fkTexCoord;\nuniform sampler2D fkBrush;\nuniform sampler2D fkCoverage;\nuniform vec4 fkBaseColor;\n"+original.fragmentShader.replace(match,
      "if (texture2D(fkCoverage, fkTexCoord).a < 0.5) discard;\n"+
      "vec4 fkSample = texture2D(fkBrush, fkTexCoord);\n"+
      "fkSample.rgb = clamp(fkSample.rgb + vColor.rgb - fkBaseColor.rgb, 0.0, 1.0);\n"+
      "fkSample.a *= fkBaseColor.a > 0.0001 ? vColor.a / fkBaseColor.a : 0.0;\n"+
      "vec4 diffuseColor = fkSample;");
    material.uniforms.fkBrush={value:entry.texture};material.uniforms.fkCoverage={value:entry.mask};
    material.uniforms.fkBaseColor={value:[baseColor[0]/255,baseColor[1]/255,baseColor[2]/255,baseColor[3]??1]};
    material.side=2;material.transparent=true;material.depthWrite=true;material.polygonOffset=true;material.polygonOffsetFactor=-1;material.polygonOffsetUnits=-1;
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
  async function surfaceGeometry(source,info,record,entry,attributes) {
    const {frame}=record,rectangles=[];
    const tile=entry.depth?8:32;
    for(const [x0,y0,x1,y1] of entry.rectangles)for(let y=y0;y<y1;y+=tile)for(let x=x0;x<x1;x+=tile){const r=[x,y,Math.min(x+tile,x1),Math.min(y+tile,y1)];rectangles.push({r,progress:locate(frame,(r[0]+r[2])/2,(r[1]+r[3])/2).progress});}
    rectangles.sort((a,b)=>a.progress-b.progress);
    const vertices=[],prepared={points:(attributes.points||[]).map(xyz),normals:(attributes.normals||[]).map(xyz)},originalPrepared={points:(record.attributes.points||[]).map(xyz),normals:(record.attributes.normals||[]).map(xyz)};
    let work=0;
    for(const {r:[x0,y0,x1,y1]} of rectangles)for(const [x,y] of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]){
      if(++work%1024===0)await new Promise(resolve=>setTimeout(resolve,0));
      const vertex={x,y,...mapPixel(frame,x,y,attributes,prepared)};
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
      vertices.forEach((vertex,i)=>{
        const src=info.geomAttributes+Math.min(info.numOfPoints-1,Math.round(vertex.progress*(info.numOfPoints-1)))*4;
        for(let k=0;k<attribute.itemSize;k++)array[i*attribute.itemSize+k]=attribute.array[src*attribute.itemSize+k];
        if(name==="position")array.set(vertex.position,i*3);
        else if(name==="normalUp"||name==="normalSide")array.set(vertex.normal,i*3);
        else if(name==="upDown")array[i]=0;
        else if(name==="color")array.set([...(attributes.color || [0,0,0]).slice(0,3),Math.round((attributes.color?.[3]??1)*255)],i*4);
      });
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
  async function replaceCurve(manager,state,id,info,record,entry,attributes,active=()=>true) {
    const geom=manager.getGeomFromInfo(info);if(!geom?.geometry?.index)return;
    // Pin textures while yielding between geometry chunks. Another curve can
    // finish and evict unreferenced cache entries during those yields.
    entry.refs++;
    let geometry;
    try{geometry=await surfaceGeometry(geom.geometry,info,record,entry,attributes);}catch(error){entry.refs--;throw error;}
    if(!active()){geometry.dispose();entry.refs--;evict();return;}
    removeReplacement(state,id);
    const material=materialFor(geom.mesh.material,entry,record.attributes.color || [0,0,0,1]);
    if(record.result.composited){
      material.blending=5;material.blendSrc=201;material.blendDst=200;material.blendSrcAlpha=201;material.blendDstAlpha=200;
      // The backdrop already contains host shading/patterns. Do not shade it a
      // second time after Krita has blended its colors.
      if(material.fragmentShader.includes("out vec4 gColor"))material.fragmentShader=material.fragmentShader.replace(/}\s*$/,"gColor = fkSample; gBloom = vec4(0.0, 0.0, 0.0, fkSample.a);\n}");
    }
    const mesh=new api.Mesh(geometry,material);mesh.castShadow=geom.mesh.castShadow;mesh.receiveShadow=geom.mesh.receiveShadow;
    mesh.renderOrder=geom.mesh.renderOrder;mesh.matrixAutoUpdate=false;mesh.matrix.copy(geom.mesh.matrix);
    mesh.onBeforeRender=()=>syncUniforms(geom.mesh.material,material);
    const indexCount=info.fkIndexCount??((info.numOfPoints-1)*24+12);
    const syncVisibility=()=>{
      mesh.visible=geom.mesh.visible;mesh.matrix.copy(geom.mesh.matrix);mesh.matrixWorldNeedsUpdate=true;
      const start=geom.geometry.drawRange.start,end=start+geom.geometry.drawRange.count;
      const first=clamp((start-info.geomIndex)/indexCount,0,1),last=clamp((end-info.geomIndex)/indexCount,0,1);
      const begin=Math.floor(first*geometry.index.count/6)*6,finish=Math.floor(last*geometry.index.count/6)*6;
      geometry.setDrawRange(begin,Math.max(0,finish-begin));
    };
    syncVisibility();manager.sceneGroup.add(mesh);
    hideCurve(manager,info,state,id);state.records.set(id,{mesh,entry,syncVisibility,info,source:geom.geometry});evict();api.redraw?.();
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
      const attributes=latestAttributes.get(info)||info.attributes,token={info};state.pending.set(id,token);
      const generation=state.generation;
      const active=()=>generation===state.generation&&state.pending.get(id)===token&&manager.curveIdToGeomInfo.get(id)===info;
      const saved=info.fkRecord?Promise.resolve(info.fkRecord):artwork(id);
      saved.then(async record=>{
        if(!record||!active())return;
        hideCurve(manager,info,state,id);
        token.masked=true;
        const restore=async()=>{const entry=await loadAssets(record);if(active())await replaceCurve(manager,state,id,info,record,entry,attributes,active);};
        if(record.result){const ready=restore();restoringSurfaces.add(ready);try{await ready;}finally{restoringSurfaces.delete(ready);}return;}
        const rendered=await renderRecord(info.fkRecord?null:id,record,info.fkRecord?active:()=>true);
        if(!rendered||!active())return;
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
  function preview(mesh,attributes) {
    if(!attached||!mesh?.parent)return;
    let holder=previews.get(mesh);
    const stop=!mesh.geometry.drawRange.count||!attributes.shape;
    if(stop){
      if(holder){holder.epoch++;clearTimeout(holder.timer);holder.timer=null;holder.latest=null;clearState(states.get(holder.manager));holder.manager.curveIdToGeomInfo.clear();}
      gesture=null;return;
    }
    if(!gesture)gesture={bindings:{...bindings}};
    const preset=gesture.bindings[attributes.shape];if(!preset)return;
    if(!holder){
      const manager={sceneGroup:mesh.parent,curveIdToGeomInfo:new Map(),getGeomFromInfo:()=>({geometry:mesh.geometry,mesh})};
      holder={manager,timer:null,latest:null,epoch:0,running:false,disposed:false};previews.set(mesh,holder);register(manager);
      mesh.addEventListener("removed",()=>{holder.disposed=true;holder.epoch++;clearTimeout(holder.timer);clearState(states.get(manager));managers.delete(manager);});
    }
    const count=attributes.points?.length || 0;
    if(count<2)return;
    const state=states.get(holder.manager);
    // Hide the Feather tube immediately. Retain the last completed Krita
    // texture while a newer Pencil sample is being rendered.
    const mask=maskSource(mesh.geometry,mesh.material);mask.array.fill(1);mask.needsUpdate=true;
    state.hidden.set("preview",{source:mesh.geometry,mask,offset:0,count:mask.count});
    holder.latest={attributes,preset,indexCount:mesh.geometry.drawRange.count};
    const run=async()=>{
      holder.timer=null;if(holder.running||holder.disposed||!holder.latest)return;
      const latest=holder.latest;holder.latest=null;holder.running=true;
      const epoch=holder.epoch,active=()=>!holder.disposed&&epoch===holder.epoch&&!!mesh.parent;
      try{
        const a=clone(latest.attributes),record={version:2,preset:latest.preset,preview:true,attributes:a};
        const rendered=await renderRecord(null,record,active);
        if(!rendered||!active())return;
        const entry=await loadAssets(record);if(!active())return;
        const info={attributes:a,numOfPoints:a.points.length,geomAttributes:0,geomIndex:0,fkIndexCount:latest.indexCount};
        holder.manager.curveIdToGeomInfo.set("preview",info);
        await replaceCurve(holder.manager,state,"preview",info,record,entry,a,active);
      }catch(error){fail(error);}finally{
        holder.running=false;
        if(holder.latest&&!holder.disposed)holder.timer=setTimeout(run,0);
      }
    };
    if(!holder.running&&!holder.timer)holder.timer=setTimeout(run,0);
  }
  function savePreset(id,shape){post({command:"savePreset",id,shape}).catch(fail);}
  async function selectPreset(id,shape){try{const result=await checked({command:"selectPreset",id,shape});if(result.bindings)setBindings(result.bindings);}catch(error){fail(error);}}
  root.FeatherKrita={attach,attachSelection,setBindings,preview,pressureInput,hover,hoverEnd,birth,inherit,savePreset,selectPreset};
  if(typeof module!=="undefined")module.exports={strokeRequest,coverageRectangles,mapPixel,surfaceHeight,hoverPositions,SHAPES};
})(globalThis);
