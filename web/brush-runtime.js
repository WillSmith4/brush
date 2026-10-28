// SPDX-License-Identifier: GPL-3.0-or-later
(function (root) {
  "use strict";
  const SHAPES = ["POINTY", "RECT", "CUBE", "MARKER", "WIDEBRUSH", "RIBBON"];
  let bindings = Object.create(null), api, attached = false;
  const managers = new Set(), states = new WeakMap();
  const cache = new Map(), queue = [];
  let running = false, memory = 0;
  const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;
  const post = (body) => root.webkit.messageHandlers.FeatherKrita.postMessage(body);
  const fail = (error) => {
    console.error("FeatherKrita:", error);
    root.dispatchEvent(new CustomEvent("feather-krita-error", {detail: String(error.message || error)}));
    post({command: "error", message: String(error.message || error).slice(0, 400)}).catch(() => {});
  };

  function strokeRequest(attributes, preset, fallbackSize = 0.01) {
    const points = attributes.points;
    if (!Array.isArray(points) || points.length < 2) throw new Error("A stroke needs at least two points.");
    const size = Number(attributes.size) > 0 ? Number(attributes.size) : fallbackSize;
    const distances = [0];
    for (let i = 1; i < points.length; i++) {
      const p = points[i], q = points[i - 1];
      const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      if (!Number.isFinite(d)) throw new Error("Invalid 3D stroke coordinates.");
      distances.push(distances[i - 1] + d);
    }
    const length = Math.max(distances.at(-1), size * 0.01);
    const scale = Math.min(128 / size, (4096 - 128) / length);
    const diameter = Math.max(1, size * scale), padding = diameter / 2;
    const width = Math.min(4096, Math.max(16, Math.ceil(length * scale + diameter)));
    const height = Math.max(16, Math.ceil(diameter * 2));
    const pressures = attributes.pressures || [];
    const input = distances.map((d, i) => [padding + d * scale, height / 2,
      pressures.length ? Math.max(0, Math.min(1, pressures[Math.min(i, pressures.length - 1)])) : 1, i * 8]);
    // Bound work while preserving the endpoints and the original pressure curve.
    const sampled = input.length <= 4096 ? input : Array.from({length: 4096}, (_, i) => input[Math.round(i * (input.length - 1) / 4095)]);
    const color = attributes.color || [0, 0, 0, 1];
    return {
      body: {command: "render", preset, width, height, size: diameter,
        points: sampled, color: color.slice(0, 3), opacity: color[3] ?? 1, seed: 1},
      u: distances.map((d) => (padding + d * scale) / width),
      v: [(height / 2 - diameter / 2) / height, (height / 2 + diameter / 2) / height],
    };
  }

  function evict() {
    for (const [key, entry] of cache) {
      if (memory <= MAX_TEXTURE_BYTES) break;
      if (entry.refs || !entry.texture) continue;
      entry.texture.dispose(); memory -= entry.bytes; cache.delete(key);
    }
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          const result = await post(job.body);
          if (!result?.ok) throw new Error(result?.error || "Native stroke rendering failed.");
          const image = new Image();
          image.src = "data:image/png;base64," + result.png;
          await image.decode();
          const texture = new api.Texture(image);
          texture.needsUpdate = true;
          texture.generateMipmaps = false;
          texture.minFilter = api.LinearFilter;
          texture.magFilter = api.LinearFilter;
          const entry = cache.get(job.key);
          entry.texture = texture; entry.bytes = result.width * result.height * 4;
          memory += entry.bytes;
          job.resolve(entry);
          queueMicrotask(evict);
        } catch (error) {
          cache.delete(job.key); job.reject(error);
        }
      }
    } finally { running = false; }
  }
  function textureFor(body) {
    const key = JSON.stringify(body);
    let entry = cache.get(key);
    if (entry) return entry.promise;
    entry = {refs: 0, texture: null, bytes: 0};
    entry.promise = new Promise((resolve, reject) => queue.push({key, body, resolve, reject}));
    cache.set(key, entry); pump();
    return entry.promise;
  }

  function unhide(state) {
    for (const record of state.records.values()) {
      if (record.hidden && record.source.attributes.fkHide?.array === record.hideArray) {
        record.hideArray.fill(0, record.vertexOffset, record.vertexOffset + record.vertexCount);
        record.source.attributes.fkHide.needsUpdate = true;
        record.hidden = false;
      }
    }
  }
  function dispose(record) {
    record.mesh.removeFromParent(); record.mesh.geometry.dispose(); record.mesh.material.dispose();
    record.entry.refs--; evict();
  }
  function clearState(state) {
    unhide(state);
    for (const record of state.records.values()) dispose(record);
    state.records.clear(); state.generation++;
  }
  function materialFor(original, texture) {
    const material = new api.ShaderMaterial();
    material.copy(original);
    const declaration = "varying vec2 fkTexCoord;\n";
    material.vertexShader = "attribute vec2 fkUV;\n" + declaration + original.vertexShader.replace(
      /void\s+main\s*\(\s*\)\s*\{/, "$&\n fkTexCoord = fkUV;");
    const match = "vec4 diffuseColor = vColor;";
    if (!original.fragmentShader.includes(match)) throw new Error("Unsupported Feather stroke material.");
    material.fragmentShader = declaration + "uniform sampler2D fkBrush;\n" + original.fragmentShader.replace(match,
      "vec4 fkSample = texture2D(fkBrush, fkTexCoord);\n" +
      "if (fkSample.a < 0.004) discard;\nvec4 diffuseColor = fkSample;");
    material.uniforms.fkBrush = {value: texture};
    material.transparent = true;
    material.needsUpdate = true;
    return material;
  }
  function syncUniforms(original, material, texture) {
    for (const [name, uniform] of Object.entries(original.uniforms)) material.uniforms[name] = uniform;
    material.uniforms.fkBrush = {value: texture};
    material.uniformsNeedUpdate = true;
    const defines = JSON.stringify(original.defines);
    if (defines !== material.userData.fkDefines) {
      material.defines = {...original.defines}; material.userData.fkDefines = defines; material.needsUpdate = true;
    }
  }
  function replaceCurve(manager, state, id, info, request, entry) {
    const geom = manager.getGeomFromInfo(info);
    if (!geom?.geometry?.index || !entry.texture) return;
    const source = geom.geometry;
    const originalMaterial = geom.mesh.material;
    if (!originalMaterial.userData.fkMask) {
      originalMaterial.vertexShader = "attribute float fkHide;\nvarying float fkHidden;\n" + originalMaterial.vertexShader.replace(
        /void\s+main\s*\(\s*\)\s*\{/, "$&\n fkHidden = fkHide;");
      originalMaterial.fragmentShader = "varying float fkHidden;\n" + originalMaterial.fragmentShader.replace(
        /void\s+main\s*\(\s*\)\s*\{/, "$&\n if (fkHidden > 0.5) discard;");
      originalMaterial.defaultAttributeValues.fkHide = [0];
      originalMaterial.userData.fkMask = true;
      originalMaterial.needsUpdate = true;
    }
    if (!source.attributes.fkHide) source.setAttribute("fkHide", new api.Attribute(new Float32Array(source.attributes.position.count), 1));
    const count = info.numOfPoints * 4, indexCount = info.fkIndexCount ?? ((info.numOfPoints - 1) * 24 + 12);
    const indices = source.index.array.slice(info.geomIndex, info.geomIndex + indexCount);
    const geometry = new api.Geometry();
    for (const [name, attribute] of Object.entries(source.attributes)) {
      if (attribute.isInterleavedBufferAttribute) throw new Error("Unsupported interleaved stroke attributes.");
      const array = attribute.array.slice(info.geomAttributes * attribute.itemSize, (info.geomAttributes + count) * attribute.itemSize);
      geometry.setAttribute(name, new api.Attribute(array, attribute.itemSize, attribute.normalized));
    }
    geometry.setIndex(new api.Attribute(new Uint32Array(Array.from(indices, (i) => i - info.geomAttributes)), 1));
    const uv = new Float32Array(count * 2);
    for (let i = 0; i < info.numOfPoints; i++) for (let side = 0; side < 4; side++) {
      uv[(i * 4 + side) * 2] = request.u[i];
      uv[(i * 4 + side) * 2 + 1] = request.v[(side === 0 || side === 3) ? 0 : 1];
    }
    geometry.setAttribute("fkUV", new api.Attribute(uv, 2)); geometry.computeBoundingSphere();
    const material = materialFor(geom.mesh.material, entry.texture);
    const mesh = new api.Mesh(geometry, material);
    mesh.castShadow = geom.mesh.castShadow; mesh.receiveShadow = geom.mesh.receiveShadow;
    mesh.renderOrder = geom.mesh.renderOrder; mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(geom.mesh.matrix);
    mesh.onBeforeRender = () => {
      syncUniforms(geom.mesh.material, material, entry.texture);
      mesh.visible = geom.mesh.visible;
      mesh.matrix.copy(geom.mesh.matrix); mesh.matrixWorldNeedsUpdate = true;
    };
    manager.sceneGroup.add(mesh);
    const hideArray = source.attributes.fkHide.array;
    hideArray.fill(1, info.geomAttributes, info.geomAttributes + count);
    source.attributes.fkHide.needsUpdate = true; entry.refs++;
    state.records.set(id, {mesh, entry, source, hideArray, vertexOffset: info.geomAttributes, vertexCount: count, hidden: true});
  }
  function synchronize(manager) {
    const state = states.get(manager);
    if (!state || state.depth) return;
    clearState(state);
    const generation = state.generation;
    for (const [id, info] of manager.curveIdToGeomInfo) {
      const preset = bindings[info.attributes.shape];
      if (!preset) continue;
      let request;
      try { request = strokeRequest(info.attributes, preset, api.fallbackSize); }
      catch (error) { fail(error); continue; }
      textureFor(request.body).then((entry) => {
        if (generation !== state.generation || bindings[info.attributes.shape] !== preset || manager.curveIdToGeomInfo.get(id) !== info) return;
        try { replaceCurve(manager, state, id, info, request, entry); }
        catch (error) { fail(error); }
      }, fail);
    }
  }
  function register(manager) {
    if (!states.has(manager)) {
      states.set(manager, {depth: 0, generation: 0, records: new Map()}); managers.add(manager);
    }
    return states.get(manager);
  }
  function attach(Manager, constructors) {
    if (attached) return;
    api = constructors; attached = true;
    // Restore visibility before Feather compacts, edits or copies its batch buffers.
    for (const name of ["makeCurves", "makeCurve", "updateCurve", "copyCurveGeom", "removeCurve", "removeCurves", "clear"]) {
      const original = Manager.prototype[name];
      if (typeof original !== "function") throw new Error("Missing Feather operation: " + name);
      Manager.prototype[name] = function (...args) {
        const state = register(this);
        if (state.depth++ === 0) { clearState(state); }
        try { return original.apply(this, args); }
        finally {
          state.depth--;
          if (!state.depth) {
            if (name === "clear") managers.delete(this);
            else { managers.add(this); synchronize(this); }
          }
        }
      };
    }
    const ready = () => post({command: "ready"}).catch(fail);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(ready, 250), {once: true});
    else setTimeout(ready, 250);
  }
  function setBindings(next) {
    bindings = Object.fromEntries(Object.entries(next).filter(([shape, id]) => SHAPES.includes(shape) && typeof id === "string"));
    for (const manager of managers) synchronize(manager);
  }
  const previews = new WeakMap();
  function preview(mesh, attributes) {
    if (!attached || !mesh?.parent) return;
    let holder = previews.get(mesh);
    if (!holder) {
      const manager = {sceneGroup: mesh.parent, curveIdToGeomInfo: new Map(),
        getGeomFromInfo: () => ({geometry: mesh.geometry, mesh})};
      holder = {manager, timer: null, last: 0, latest: null, disposed: false};
      previews.set(mesh, holder); register(manager);
      mesh.addEventListener("removed", () => {
        holder.disposed = true; clearTimeout(holder.timer);
        clearState(states.get(manager)); managers.delete(manager);
      });
    }
    const state = states.get(holder.manager);
    holder.latest = attributes;
    if (!mesh.geometry.drawRange.count || !bindings[attributes.shape]) {
      clearState(state);
      holder.manager.curveIdToGeomInfo.clear(); clearTimeout(holder.timer); holder.timer = null; return;
    }
    if (holder.timer) return;
    // Keep native rendering work bounded while the Pencil produces rapid updates.
    holder.timer = setTimeout(() => {
      holder.timer = null;
      if (holder.disposed || !mesh.parent || !mesh.geometry.drawRange.count) return;
      const index = mesh.geometry.index.array;
      let highest = 0;
      for (let i = 0; i < mesh.geometry.drawRange.count; i++) highest = Math.max(highest, index[i]);
      const count = Math.floor((highest + 1) / 4);
      if (count < 2) return;
      const position = mesh.geometry.attributes.position, points = [];
      for (let i = 0; i < count; i++) {
        const p = {x:0,y:0,z:0};
        for (let side = 0; side < 4; side++) {
          p.x += position.getX(i * 4 + side) / 4;
          p.y += position.getY(i * 4 + side) / 4;
          p.z += position.getZ(i * 4 + side) / 4;
        }
        points.push(p);
      }
      const latest = holder.latest;
      const pressure = latest.pressures?.length ? points.map((_,i) => latest.pressures[Math.round(i * (latest.pressures.length - 1) / Math.max(1,count - 1))]) : [];
      holder.manager.curveIdToGeomInfo.set("preview", {attributes: {...latest, points, pressures: pressure},
        numOfPoints: count, geomAttributes: 0, geomIndex: 0, fkIndexCount: mesh.geometry.drawRange.count});
      synchronize(holder.manager);
    }, 90);
  }
  root.FeatherKrita = {attach, setBindings, preview};
  if (typeof module !== "undefined") module.exports = {strokeRequest, SHAPES};
})(globalThis);
