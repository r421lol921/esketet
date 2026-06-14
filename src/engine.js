/*
  Minimal Engine: physics, batching, frustum culling, simple event hooks, and a sandbox worker launcher.
  This file implements the core subsystems requested with a pragmatic, lightweight API
  so World.js and other modules can integrate without major refactors.
*/
import * as THREE from 'three';

// Material Registry: map color -> materialId and texture lookup
const materialTable = {};
const materialList = {};
let nextMaterialId = 1;

export const Engine = {
    // Objects tracked for collision / destruction / batching
    objects: new Map(), // id -> mesh
    batches: new Map(), // materialId -> { mesh : InstancedMesh, count }
    hooks: {
        onTick: [],
        onDisasterStart: [],
        onBlockDestroyed: []
    },

    // Simple incremental id supply
    _nextId: 1,
    _scene: null,
    _camera: null,

    init(scene, camera) {
        this._scene = scene;
        this._camera = camera;
        // start main tick for engine hooks (non-blocking)
        const tick = (t) => {
            const dt = 1/60;
            this.hooks.onTick.forEach(h => { try { h(dt); } catch(e){} });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    },

    // Material helpers
    registerMaterialFromColor(colorHex) {
        // Accept numeric or string colors
        const key = String(colorHex);
        if (materialTable[key]) return materialTable[key];
        const id = nextMaterialId++;
        materialTable[key] = id;
        materialList[id] = { id, key, color: key, texture: null };
        return id;
    },

    setMaterialTexture(materialId, textureUrl) {
        if (!materialList[materialId]) return;
        materialList[materialId].texture = textureUrl;
    },

    getMaterial(materialId) {
        return materialList[materialId] || null;
    },

    // Object registration for physics and batching
    addObject(mesh) {
        if (!mesh || !this._scene) {
            // allow adding before engine init; still store minimal info
            const id = this._nextId++;
            this.objects.set(id, mesh);
            mesh.userData._engineId = id;
            return id;
        }
        const id = this._nextId++;
        mesh.userData._engineId = id;

        // ensure AABB exists for quick collisions
        mesh.userData._aabb = new THREE.Box3().setFromObject(mesh);

        this.objects.set(id, mesh);

        // Add to batch for instanced rendering if it has materialId
        const mid = mesh.userData.serial && mesh.userData.serial.materialId;
        if (mid) {
            this._addToBatch(mid, mesh);
        }
        return id;
    },

    removeObject(mesh) {
        if (!mesh || mesh.userData._engineId == null) return;
        const id = mesh.userData._engineId;
        this.objects.delete(id);

        // remove from batch if present (we keep batching simple: full rebuild on removal)
        const mid = mesh.userData.serial && mesh.userData.serial.materialId;
        if (mid) {
            this._rebuildBatch(mid);
        }
    },

    // Basic AABB collision: returns true if any solid object intersects provided AABB
    aabbIntersects(box, ignoreMesh = null) {
        for (const m of this.objects.values()) {
            if (m === ignoreMesh) continue;
            const flags = m.userData.serial && m.userData.serial.flags ? m.userData.serial.flags : [];
            if (!flags.includes('solid') && !flags.includes('static')) continue;
            if (!m.userData._aabb) m.userData._aabb = new THREE.Box3().setFromObject(m);
            if (box.intersectsBox(m.userData._aabb)) return m;
        }
        return null;
    },

    // Damage an object by engine id or mesh; if hp <= 0, destroy and call hooks
    damageObject(target, amount = 1) {
        const mesh = (typeof target === 'number') ? this.objects.get(target) : target;
        if (!mesh) return;
        if (!mesh.userData.serial) mesh.userData.serial = {};
        mesh.userData.serial.hp = (Number(mesh.userData.serial.hp) || 0) - amount;
        if (mesh.userData.serial.hp <= 0) {
            this._destroy(mesh);
        }
    },

    _destroy(mesh) {
        try {
            // Replace with "ruined" model if available via material system; otherwise remove
            const mid = mesh.userData.serial && mesh.userData.serial.materialId;
            const mat = mid ? materialList[mid] : null;

            // Spawn debris hook
            this.hooks.onBlockDestroyed.forEach(h => {
                try { h(mesh); } catch(e){}
            });

            // Remove from scene and registry
            if (mesh.parent) mesh.parent.remove(mesh);
            this.removeObject(mesh);
        } catch (e) {
            console.warn('Engine destroy failed', e);
        }
    },

    // Raycast helper: returns list of points from origin along direction until ground or maxDist
    raycastPath(origin, dir, maxDist = 10000, step = 1.0) {
        const results = [];
        const r = new THREE.Raycaster(origin, dir.normalize(), 0, maxDist);
        const hitObjects = Array.from(this.objects.values()).filter(m => m.userData && (m.userData.serial && (m.userData.serial.flags && m.userData.serial.flags.includes('static'))));
        const intersections = r.intersectObjects(hitObjects, true);
        intersections.forEach(i => results.push(i));
        return results;
    },

    // Simple disaster manager: triggers animation hooks and damages objects in a path
    triggerDisaster(type, params = {}) {
        this.hooks.onDisasterStart.forEach(h => { try { h(type, params); } catch(e){} });
        if (type === 'meteor' && params.origin && params.dir) {
            const hits = this.raycastPath(params.origin, params.dir, params.maxDist || 2000);
            // apply damage to first N hits
            for (let i = 0; i < Math.min(hits.length, params.pierce || 3); i++) {
                const hit = hits[i];
                const mesh = hit.object;
                this.damageObject(mesh, params.damage || 50);
            }
        }
    },

    // Instancing: simple batch builder (rebuilds on demand)
    _addToBatch(materialId, mesh) {
        // Lazy rebuild approach for simplicity: rebuild batch on next frame
        this._needBatchRebuild = this._needBatchRebuild || new Set();
        this._needBatchRebuild.add(materialId);
        setTimeout(() => this._rebuildBatch(materialId), 0);
    },

    _rebuildBatch(materialId) {
        // Remove existing batch mesh
        const prev = this.batches.get(materialId);
        if (prev && prev.mesh && prev.mesh.parent) {
            prev.mesh.parent.remove(prev.mesh);
            try { prev.mesh.geometry.dispose(); prev.mesh.material.dispose(); } catch(e){}
        }
        // Collect all objects using this materialId
        const objs = Array.from(this.objects.values()).filter(m => m.userData.serial && m.userData.serial.materialId === materialId);
        if (objs.length === 0) { this.batches.delete(materialId); return; }

        // Use a simple box geometry as instance prototype (we assume blocks are boxes)
        const proto = new THREE.BoxGeometry(1,1,1);
        const matInfo = materialList[materialId];
        let mat;
        if (matInfo && matInfo.texture) {
            const tex = new THREE.TextureLoader().load(matInfo.texture);
            tex.colorSpace = THREE.SRGBColorSpace;
            mat = new THREE.MeshStandardMaterial({ map: tex });
        } else {
            // fallback to colored material using the registered key string
            const color = new THREE.Color(matInfo ? matInfo.color : '#888888');
            mat = new THREE.MeshStandardMaterial({ color });
        }

        const inst = new THREE.InstancedMesh(proto, mat, objs.length);
        const tempMat = new THREE.Matrix4();
        for (let i = 0; i < objs.length; i++) {
            const o = objs[i];
            const m = new THREE.Matrix4().compose(o.position, o.quaternion || new THREE.Quaternion(), o.scale || new THREE.Vector3(1,1,1));
            inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;

        // Add to scene root (or a dedicated batchGroup)
        if (this._scene) this._scene.add(inst);
        this.batches.set(materialId, { mesh: inst, count: objs.length });
    },

    // Frustum culling helper: test object's AABB against camera frustum; returns false if outside
    isInFrustum(obj) {
        if (!this._camera) return true;
        const frustum = new THREE.Frustum();
        const projScreenMatrix = new THREE.Matrix4();
        projScreenMatrix.multiplyMatrices(this._camera.projectionMatrix, this._camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreenMatrix);
        const box = obj.userData._aabb || new THREE.Box3().setFromObject(obj);
        return frustum.intersectsBox(box);
    },

    // Event hooks registration
    on(eventName, cb) {
        if (!this.hooks[eventName]) this.hooks[eventName] = [];
        this.hooks[eventName].push(cb);
        return () => {
            const idx = this.hooks[eventName].indexOf(cb);
            if (idx !== -1) this.hooks[eventName].splice(idx, 1);
        };
    },

    // Sandbox starter: spin a web worker and provide a safe postMessage API
    createSandboxedWorker(scriptText) {
        try {
            const blob = new Blob([scriptText], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);
            // Provide a safe messaging API that proxies events from engine hooks
            // Send engine events to worker
            const tickHandler = (dt) => {
                try { worker.postMessage({ type: 'tick', dt }); } catch(e){}
            };
            this.on('onTick', tickHandler);
            // Return worker and teardown
            return {
                worker,
                destroy: () => {
                    try { worker.terminate(); } catch(e){}
                }
            };
        } catch (e) {
            console.warn('Failed to create sandbox worker', e);
            return null;
        }
    }
};