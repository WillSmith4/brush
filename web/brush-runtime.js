// SPDX-License-Identifier: GPL-3.0-or-later
(function (root) {
  "use strict";
  if (root.FeatherKrita) return;
  const SHAPES = ["POINTY", "RECT", "CUBE", "MARKER", "WIDEBRUSH", "RIBBON"];
  let bindings = Object.create(null), api, attached = false, gesture;
  const managers = new Set(), states = new WeakMap(), latestAttributes = new WeakMap();
  const artworks = new Map(), metadata = new Map(), assets = new Map(), previews = new WeakMap();
  const restoringSurfaces = new Set();
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
    const scale=Math.min(128/size,4094/w,4094/h,Math.sqrt(2090000/(w*h)))*0.999;
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
  function coverageRectangles(rgba,width,height) {
    if(rgba.length!==width*height*4)throw new Error("Invalid brush coverage dimensions.");
    for(let step=1;step<=16;step*=2){
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
    const hidden=[];
    // Only artwork and lights participate. No cursor, grid, ground, or live preview.
    const art=api.artGroup();
    scene.traverse(object=>{if(!object.isMesh&&!object.isLine&&!object.isPoints&&!object.isSprite)return;let inArt=false;for(let p=object;p;p=p.parent)if(p===art){inArt=true;break;}if(!inArt&&object.visible){hidden.push(object);object.visible=false;}});
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
      const depthScene=new api.Scene();depthScene.add(new api.Mesh(depthGeometry,depthMaterial));
      let depth;
      try{
        renderer.setRenderTarget(depthTarget);renderer.clear();renderer.render(depthScene,camera);
        renderer.readRenderTargetPixels(depthTarget,0,0,frame.width,frame.height,bytes);
        for(let y=0;y<frame.height;y++)image.data.set(bytes.subarray((frame.height-1-y)*frame.width*4,(frame.height-y)*frame.width*4),y*frame.width*4);
        ctx.putImageData(image,0,0);depth=canvas.toDataURL("image/png").split(",")[1];
      }finally{depthTarget.dispose();depthGeometry.dispose();depthMaterial.dispose();}
      return {png,depth,near,far,distance};
    }finally{
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
      const meta={...await presetInfo(record.preset)};
      if(meta.engine==="mypaintbrush")meta.samplesBackdrop=true;
      if(!active())return null;
      const request=strokeRequest(record.attributes,record.preset,api.fallbackSize,meta,cameraRight());
      if(meta.samplesBackdrop){
        // Batch-buffer compaction temporarily removes replacement meshes. Wait
        // for saved paint to return before sampling another brush's substrate.
        await Promise.resolve();await Promise.all([...restoringSurfaces]);
        if(!active())return null;
        const captured=snapshot(request.frame);request.body.backdrop=captured.png;record.surface={depth:captured.depth,near:captured.near,far:captured.far,distance:captured.distance};
      }
      const result=await checked(request.body);
      if(!active())return null;
      record.frame=request.frame;record.result=result;
      if(id)await save(id,record);
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
      entry.rectangles=coverageRectangles(ctx.getImageData(0,0,result.width,result.height).data,result.width,result.height);
      if(record.surface){const depth=new Image();depth.src="data:image/png;base64,"+record.surface.depth;await depth.decode();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(depth,0,0);entry.depth=ctx.getImageData(0,0,result.width,result.height).data;}
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
  function clearState(state) {
    state.generation++;
    for(const {source,mask,offset,count} of state.hidden.values())if(source.attributes.fkHide===mask){mask.array.fill(0,offset,offset+count);mask.needsUpdate=true;}
    state.hidden.clear();
    for(const record of state.records.values()){record.mesh.removeFromParent();record.mesh.geometry.dispose();record.mesh.material.dispose();record.entry.refs--;}
    state.records.clear();evict();
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
  function surfaceGeometry(source,info,record,entry,attributes) {
    const {frame}=record,rectangles=[];
    const tile=entry.depth?8:32;
    for(const [x0,y0,x1,y1] of entry.rectangles)for(let y=y0;y<y1;y+=tile)for(let x=x0;x<x1;x+=tile){const r=[x,y,Math.min(x+tile,x1),Math.min(y+tile,y1)];rectangles.push({r,progress:locate(frame,(r[0]+r[2])/2,(r[1]+r[3])/2).progress});}
    rectangles.sort((a,b)=>a.progress-b.progress);
    const vertices=[],prepared={points:(attributes.points||[]).map(xyz),normals:(attributes.normals||[]).map(xyz)};
    for(const {r:[x0,y0,x1,y1]} of rectangles)for(const [x,y] of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]){
      const vertex={x,y,...mapPixel(frame,x,y,attributes,prepared)};
      if(entry.depth){
        const px=clamp(Math.floor(x),0,frame.width-1),py=clamp(Math.floor(y),0,frame.height-1),at=(py*frame.width+px)*4;
        if(entry.depth[at+3]){
          const z=(entry.depth[at]*65536+entry.depth[at+1]*256+entry.depth[at+2])/16777215;
          const height=record.surface.distance-(record.surface.near+z*(record.surface.far-record.surface.near));
          const original=mapPixel(frame,x,y,record.attributes).position,baseHeight=dot(sub(original,frame.origin),frame.normal);
          vertex.position=add(vertex.position,mul(vertex.normal,height-baseHeight));
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
    const indices=new Uint32Array(rectangles.length*6);
    rectangles.forEach((_,i)=>indices.set([i*4,i*4+2,i*4+1,i*4,i*4+3,i*4+2],i*6));
    geometry.setIndex(new api.Attribute(indices,1));geometry.computeBoundingSphere();return geometry;
  }
  function replaceCurve(manager,state,id,info,record,entry,attributes) {
    const geom=manager.getGeomFromInfo(info);if(!geom?.geometry?.index)return;
    const geometry=surfaceGeometry(geom.geometry,info,record,entry,attributes);
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
    syncVisibility();manager.sceneGroup.add(mesh);entry.refs++;
    hideCurve(manager,info,state,id);state.records.set(id,{mesh,entry,syncVisibility});evict();api.redraw?.();
  }
  function register(manager){if(!states.has(manager)){states.set(manager,{depth:0,generation:0,records:new Map(),hidden:new Map()});managers.add(manager);}return states.get(manager);}
  function synchronize(manager) {
    const state=states.get(manager);if(!state||state.depth)return;
    clearState(state);const generation=state.generation;
    for(const [id,info] of manager.curveIdToGeomInfo){
      const attributes=latestAttributes.get(info)||info.attributes;
      const active=()=>generation===state.generation&&manager.curveIdToGeomInfo.get(id)===info;
      const pending=info.fkRecord?Promise.resolve(info.fkRecord):artwork(id);
      pending.then(async record=>{
        if(!record||!active())return;
        // Prevent the new host tube from contaminating its own smudge backdrop.
        hideCurve(manager,info,state,id);
        const restore=async()=>{const entry=await loadAssets(record);if(active())replaceCurve(manager,state,id,info,record,entry,attributes);};
        if(record.result){const ready=restore();restoringSurfaces.add(ready);try{await ready;}finally{restoringSurfaces.delete(ready);}return;}
        const rendered=await renderRecord(info.fkRecord?null:id,record,info.fkRecord?active:()=>true);
        if(!rendered||!active())return;
        await restore();
      }).catch(error=>{
        if(active()){const h=state.hidden.get(id);if(h){h.mask.array.fill(0,h.offset,h.offset+h.count);h.mask.needsUpdate=true;state.hidden.delete(id);}}
        fail(error);
      });
    }
  }
  function attach(Manager,constructors) {
    if(attached)return;api=constructors;attached=true;
    for(const name of ["makeCurves","makeCurve","updateCurve","copyCurveGeom","removeCurve","removeCurves","clear"]){
      const original=Manager.prototype[name];if(typeof original!=="function")throw new Error("Missing Feather operation: "+name);
      Manager.prototype[name]=function(...args){
        const state=register(this);if(state.depth++===0)clearState(state);
        try{const result=original.apply(this,args);
          if(name==="makeCurve"&&this.curveIdToGeomInfo.has(args[0]))latestAttributes.set(this.curveIdToGeomInfo.get(args[0]),args[1]);
          if(name==="updateCurve"&&args[0]&&args[1])latestAttributes.set(args[0],args[1]);
          return result;
        }finally{state.depth--;if(!state.depth){if(name==="clear")managers.delete(this);else{managers.add(this);synchronize(this);}}}
      };
    }
    for(const name of ["turnOnOff","timelapse"]){const original=Manager.prototype[name];if(typeof original!=="function")continue;Manager.prototype[name]=function(...args){const result=original.apply(this,args);for(const r of states.get(this)?.records.values()||[])r.syncVisibility();return result;};}
    const ready=()=>post({command:"ready"}).catch(fail);
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>setTimeout(ready,250),{once:true});else setTimeout(ready,250);
  }
  function setBindings(next){bindings=Object.fromEntries(Object.entries(next).filter(([shape,id])=>SHAPES.includes(shape)&&typeof id==="string"));}
  function attachSelection(Manager){
    for(const name of ["applyMatrix","resetMatrix"]){const original=Manager.prototype[name];if(typeof original!=="function")continue;
      Manager.prototype[name]=function(...args){const result=original.apply(this,args);for(const record of states.get(this)?.records.values()||[])record.syncVisibility();return result;};
    }
  }
  function preview(mesh,attributes) {
    if(!attached||!mesh?.parent)return;
    let holder=previews.get(mesh);
    if(!holder){const manager={sceneGroup:mesh.parent,curveIdToGeomInfo:new Map(),getGeomFromInfo:()=>({geometry:mesh.geometry,mesh})};holder={manager,timer:null,latest:null,disposed:false};previews.set(mesh,holder);register(manager);
      mesh.addEventListener("removed",()=>{holder.disposed=true;clearTimeout(holder.timer);clearState(states.get(manager));managers.delete(manager);});}
    const state=states.get(holder.manager);holder.latest=attributes;
    if(!mesh.geometry.drawRange.count||!attributes.shape){clearState(state);holder.manager.curveIdToGeomInfo.clear();clearTimeout(holder.timer);holder.timer=null;gesture=null;return;}
    if(!gesture)gesture={bindings:{...bindings}};
    const preset=gesture.bindings[attributes.shape];if(!preset)return;
    if(holder.timer)return;
    holder.timer=setTimeout(()=>{
      holder.timer=null;if(holder.disposed||!mesh.parent||!mesh.geometry.drawRange.count)return;
      const index=mesh.geometry.index.array;let highest=0;for(let i=0;i<mesh.geometry.drawRange.count;i++)highest=Math.max(highest,index[i]);
      const count=Math.floor((highest+1)/4);if(count<2)return;
      const position=mesh.geometry.attributes.position,points=[];
      for(let i=0;i<count;i++){const p={x:0,y:0,z:0};for(let side=0;side<4;side++){p.x+=position.getX(i*4+side)/4;p.y+=position.getY(i*4+side)/4;p.z+=position.getZ(i*4+side)/4;}points.push(p);}
      const latest=holder.latest,pressure=latest.pressures?.length?points.map((_,i)=>latest.pressures[Math.round(i*(latest.pressures.length-1)/Math.max(1,count-1))]):[];
      const normals=latest.normals?.length>=count?latest.normals.slice(0,count):undefined;
      const a={...latest,points,normals,pressures:pressure};
      holder.manager.curveIdToGeomInfo.set("preview",{attributes:a,fkRecord:{version:2,preset,attributes:clone(a)},numOfPoints:count,geomAttributes:0,geomIndex:0,fkIndexCount:mesh.geometry.drawRange.count});
      synchronize(holder.manager);
    },90);
  }
  function savePreset(id,shape){post({command:"savePreset",id,shape}).catch(fail);}
  async function selectPreset(id,shape){try{const result=await checked({command:"selectPreset",id,shape});if(result.bindings)setBindings(result.bindings);}catch(error){fail(error);}}
  root.FeatherKrita={attach,attachSelection,setBindings,preview,birth,inherit,savePreset,selectPreset};
  if(typeof module!=="undefined")module.exports={strokeRequest,coverageRectangles,mapPixel,SHAPES};
})(globalThis);
