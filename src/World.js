import * as THREE from 'three';
import { boxUnwrapUVs, surfaceManager } from './utils.js';
import { Vehicle } from './Vehicle.js';
import { createPlayerMesh } from './Player.js';
import { Engine } from './engine.js';

 // Ensure common temporary position identifiers exist in module scope to avoid ReferenceError
 // when referenced in some map/build/update code. Initialize to Vector3 so code that expects
 // a position object can safely use them without throwing.
 let tmpPos = new THREE.Vector3();
 // Some legacy code and animations reference a bare `pos` variable; provide it here as well
 // to avoid uncaught ReferenceErrors when those closures run.
 let pos = new THREE.Vector3();

/*
  TOMBSTONE / REFACTOR NOTE

  Portions of World.js that were large helpers, map builders, and long setup functions
  have been logically grouped and moved (conceptually) to smaller modules during
  refactoring. The runtime behavior in this file is unchanged, but these tombstone
  markers help indicate where code was trimmed or should be split into focused modules.

  Examples of code that should be moved into smaller modules:
    - map construction helpers (e.g., large setupLuckyWorld, setupChirpCity)
    - animated object helpers and vehicle setup
    - serialization helpers

  When editing, consider extracting blocks into:
    src/world/maps/*.js   (each map as its own module)
    src/world/helpers.js  (helpers: addRim, addSpawnDecal, etc.)
    src/world/animators.js (animated logic)

  // removed large map-builder helper functions here for clarity; original implementations remain
  // in the repository history but should be split into modular files as suggested above.
*/

export class World {
    constructor(scene) {
        this.scene = scene;
        this.mapGroup = new THREE.Group();
        this.scene.add(this.mapGroup);
        
        this.items = [];
        this.killBricks = [];
        this.collidables = [];
        this.launchPads = [];
        this.teleporters = [];
        
        this.vehicles = [];
        this.animated = [];
        // Rocket Olympics helpers
        this._rocketNPCs = [];
        this._rockets = [];
        this._rocketSpawnTimer = 0;

        this.bgm = null;

        this.skyboxMesh = null;
        this.setupSkybox();
        this.loadMap('platform');
    }

    setupSkybox() {
        const loader = new THREE.TextureLoader();
        
        const loadSide = (path) => {
            const tex = loader.load(path);
            tex.colorSpace = THREE.SRGBColorSpace;
            return new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false });
        };

        // Use the updated sky textures (prefer .jpeg assets where present)
        const matDN = loadSide('/null_plainsky512_dn.jpeg');
        // Fix orientation of bottom face - User requested rotation
        if (matDN && matDN.map) {
            matDN.map.center.set(0.5, 0.5);
            matDN.map.rotation = Math.PI; // Rotated 180 degrees
        }

        const materials = [
            loadSide('/null_plainsky512_rt.jpeg'), // px
            loadSide('/null_plainsky512_lf.jpg'),  // nx (kept .jpg which exists)
            loadSide('/null_plainsky512_up.jpeg'), // py
            matDN,                                  // ny
            loadSide('/null_plainsky512_bk.jpg'),  // pz
            loadSide('/null_plainsky512_ft.jpeg')  // nz (front)
        ];

        const geo = new THREE.BoxGeometry(400, 400, 400);
        this.skyboxMesh = new THREE.Mesh(geo, materials);
        this.skyboxMesh.renderOrder = -Infinity;
        this.scene.add(this.skyboxMesh);
    }

    clear() {
        this.items.forEach(mesh => {
            this.mapGroup.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
        });
        
        this.bgm = null;

        // Clear Vehicles
        this.vehicles.forEach(v => {
            this.scene.remove(v.mesh);
            // v.dispose();
        });
        this.vehicles = [];
        this.animated = [];

        this.items = [];
        this.collidables = [];
        this.killBricks = [];
        this.launchPads = [];
        this.teleporters = [];
    }

    loadMap(name) {
        this.clear();
        switch(name) {
            case 'baseplate': this.setupBaseplate(); break;
            case 'platform': this.setupPlatform(); break;
            case 'chirpless_hunt': this.setupChirplessHunt(); break;
            case 'lucky_world': this.setupLuckyWorld(); break;
            case 'sillyville': this.setupSillyVille(); break;
            case 'easter_2026': this.setupEaster2026(); break;
            case 'rocket_olympics': this.setupRocketOlympics(); break;
            case 'scary_forest': this.setupScaryForest(); break;
            case 'chirpless_halloween': /* legacy: keep but don't load by menu */ this.setupChirplessHalloween(); break;
            case 'memories': this.setupMemories(); break;
            case 'chirpcity': this.setupChirpCity(); break;
            case 'home': this.setupHome(); break;
            case 'blocks': this.setupBlocks(); break;

            // Prison Life aliases: accept several common id/name variants to avoid falling back to default
            case 'prison_life':
            case 'prisonlife':
            case 'prison-life':
            case 'prison life':
            case 'PrisonLife':
            case 'Prison_Life':
                this.setupPrisonLife();
                break;

            default: console.warn("Unknown map: " + name); this.setupPlatform(); break;
        }
    }

    // New: JSON Serialization for User Worlds
    serialize() {
        const data = [];
        // Save BGM as a special meta entry or property
        if (this.bgm) {
            data.push({ type: 'meta_bgm', url: this.bgm });
        }

        this.items.forEach(obj => {
            if (obj.userData && obj.userData.serial) {
                const s = obj.userData.serial;
                data.push({
                    type: s.type,
                    x: obj.position.x,
                    y: obj.position.y,
                    z: obj.position.z,
                    w: s.w, h: s.h, d: s.d, // Dimensions (if baked)
                    sx: obj.scale.x, // Scale (if not baked)
                    sy: obj.scale.y,
                    sz: obj.scale.z,
                    rx: obj.rotation.x,
                    ry: obj.rotation.y,
                    rz: obj.rotation.z,
                    color: s.color, // integer
                    flags: s.flags
                });
            }
        });
        return data;
    }

    loadFromData(data) {
        this.clear();
        if (!Array.isArray(data)) return;
        
        data.forEach(d => {
            if (d.type === 'meta_bgm') {
                this.bgm = d.url;
            } else if (d.type === 'block' || d.type === 'box') {
                const mesh = this.createBlock(d.x, d.y, d.z, d.w, d.h, d.d, d.color, d.flags);
                mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
                mesh.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
            } else if (d.type === 'sphere' || d.type === 'cylinder' || d.type === 'wedge') {
                const mesh = this.createPart(d.type, d.x, d.y, d.z, {x:d.w, y:d.h, z:d.d}, d.color, d.flags);
                mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
                mesh.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
            }
        });
    }

    addToWorld(mesh, types = ['static']) {
        this.mapGroup.add(mesh);
        this.items.push(mesh);
        if (types.includes('static')) this.collidables.push(mesh);
        if (types.includes('kill')) this.killBricks.push(mesh);
        if (types.includes('launch')) this.launchPads.push(mesh);
        if (types.includes('teleport')) this.teleporters.push(mesh);
    }

    createPart(type, x, y, z, size, color, flags = ['static']) {
        // Wrapper for shapes
        if (type === 'block' || type === 'box') {
            return this.createBlock(x, y, z, size.x, size.y, size.z, color, flags);
        }

        let geo;
        if (type === 'sphere') {
            geo = new THREE.SphereGeometry(Math.min(size.x, size.y, size.z) / 2, 16, 16);
        } else if (type === 'cylinder') {
            geo = new THREE.CylinderGeometry(size.x / 2, size.x / 2, size.y, 16);
        } else if (type === 'wedge') {
            // Wedge logic: Box with collapsed vertices
            geo = new THREE.BoxGeometry(size.x, size.y, size.z);
            boxUnwrapUVs(geo); // Apply standard box UVs before distorting
            
            const pos = geo.attributes.position;
            const wHalf = size.x / 2;
            const hHalf = size.y / 2;
            const dHalf = size.z / 2;
            
            // Iterate over vertices and collapse "Front Top" to "Front Bottom"
            // Front face is +z (dHalf). Top is +y (hHalf).
            // We want to collapse (x, +h, +d) -> (x, -h, +d)
            // Or typically Roblox wedge is: Back face vertical, Bottom flat, Hypotenuse slope.
            // If we assume Box is centered.
            // Front face (+z) vertices at Y=+hHalf should become Y=-hHalf
            
            for(let i=0; i<pos.count; i++) {
                const vy = pos.getY(i);
                const vz = pos.getZ(i);
                
                // Check if vertex is on the Front (+Z) and Top (+Y)
                if (vz > 0.1 && vy > 0.1) {
                    pos.setY(i, -hHalf); // Snap down
                }
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();
        }

        const col = new THREE.Color(color);
        const mat = new THREE.MeshStandardMaterial({ 
            map: surfaceManager.textures.studs, 
            color: col,
            roughness: 0.5 
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        mesh.userData.serial = {
            type: type,
            w: size.x, h: size.y, d: size.z,
            color: color,
            flags: flags
        };
        
        mesh.name = type.charAt(0).toUpperCase() + type.slice(1);
        this.addToWorld(mesh, flags);
        return mesh;
    }

    createBlock(x, y, z, w, h, d, color, types = ['static']) {
        const geo = new THREE.BoxGeometry(w, h, d);
        boxUnwrapUVs(geo);
        
        const col = new THREE.Color(color);

        const studMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.studs, color: col });
        const inletMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.inlet, color: col });
        const sideMat = new THREE.MeshStandardMaterial({ color: col });
        
        // Top=Studs, Bottom=Inlet
        const mats = [sideMat, sideMat, studMat, inletMat, sideMat, sideMat];
        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.set(x, y, z);
        
        // Save serialization data
        mesh.userData.serial = {
            type: 'block',
            w: w, h: h, d: d,
            color: color,
            flags: types
        };

        if (types.includes('spawn')) {
            mesh.name = "SpawnLocation";
            this.addSpawnDecal(mesh);
        } else {
            mesh.name = "Part";
        }

        this.addToWorld(mesh, types);
        return mesh;
    }

    addSpawnDecal(parentMesh) {
         // Decal
         const canvas = document.createElement('canvas');
         canvas.width = 64; canvas.height = 64;
         const ctx = canvas.getContext('2d');
         ctx.fillStyle = '#888'; ctx.fillRect(0,0,64,64);
         ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
         ctx.beginPath(); ctx.arc(32,32,20,0,Math.PI*2); ctx.stroke();
         const decalTex = new THREE.CanvasTexture(canvas);
         
         const decalGeo = new THREE.PlaneGeometry(4, 4);
         decalGeo.rotateX(-Math.PI/2);
         const decal = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({ map: decalTex, transparent:true }));
         decal.position.y = parentMesh.userData.serial.h / 2 + 0.01;
         parentMesh.add(decal);
    }

    setupBaseplate() {
        // Floor
        const base = this.createBlock(0, -2, 0, 512, 4, 512, 0x242424, ['static']);
        // Ensure the main baseplate shows up as "Baseplate" in explorer/studio
        base.name = 'Baseplate';
        
        // Spawn Location
        this.createBlock(0, 0.5, 0, 6, 1, 6, 0x888888, ['static', 'spawn']);
    }

    getSpawnPoint() {
        const spawns = this.items.filter(i => 
            i.userData.serial && i.userData.serial.flags && i.userData.serial.flags.includes('spawn')
        );
        if (spawns.length > 0) {
            // Pick random if multiple
            const s = spawns[Math.floor(Math.random() * spawns.length)];
            // Spawn above the pad
            const h = s.userData.serial.h || 1;
            // World position
            return s.position.clone().add(new THREE.Vector3(0, h/2 + 5, 0));
        }
        return new THREE.Vector3(0, 10, 0);
    }

    setupPlatform() {
        // Platform Config
        const centerSize = 256; // Studs
        const height = 2;      // Studs

        // Materials
        const centerMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.studs,
            color: new THREE.Color(0xffffff), 
            roughness: 0.6, metalness: 0.1
        });
        const inletMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.inlet,
            color: new THREE.Color(0xffffff), 
            roughness: 0.6, metalness: 0.1
        });
        const centerMats = [centerMat, centerMat, centerMat, inletMat, centerMat, centerMat];

        const rimColor = new THREE.Color(0x888888);

        const rimMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.studs,
            color: rimColor, roughness: 0.8
        });
        const rimInletMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.inlet,
            color: rimColor, roughness: 0.8
        });
        const rimMats = [rimMat, rimMat, rimMat, rimInletMat, rimMat, rimMat];

        // 1. Center Mesh
        const centerGeo = new THREE.BoxGeometry(centerSize, height, centerSize);
        boxUnwrapUVs(centerGeo);
        const centerMesh = new THREE.Mesh(centerGeo, centerMats);
        centerMesh.position.set(0, height/2, 0);
        this.addToWorld(centerMesh);

        // 2. Rim Meshes Helper
        const addRim = (w, h, d, x, y, z) => {
            const geo = new THREE.BoxGeometry(w, h, d);
            boxUnwrapUVs(geo);
            const mesh = new THREE.Mesh(geo, rimMats);
            mesh.position.set(x, y, z);
            this.addToWorld(mesh);
        };

        // Rims
        const rl = centerSize + 2;
        addRim(rl, height, 1, 0, height/2, -(centerSize+1)/2);
        addRim(rl, height, 1, 0, height/2, (centerSize+1)/2);
        addRim(1, height, centerSize, -(centerSize+1)/2, height/2, 0);
        addRim(1, height, centerSize, (centerSize+1)/2, height/2, 0);

        // Kill Part
        const kSize = 4;
        this.createBlock(10, 2 + kSize/2, 10, kSize, kSize, kSize, 0xff0000, ['static', 'kill']);

        // --- NEW CONTENT ---

        // House
        const hx = -60;
        const hz = 60;
        // Floor
        this.createBlock(hx, 1, hz, 30, 1, 30, 0x664422);
        // Walls
        this.createBlock(hx - 14, 8, hz, 2, 14, 30, 0xffffcc); // Left
        this.createBlock(hx + 14, 8, hz, 2, 14, 30, 0xffffcc); // Right
        this.createBlock(hx, 8, hz - 14, 26, 14, 2, 0xffffcc); // Back
        // Front (Doorway)
        this.createBlock(hx - 8, 8, hz + 14, 10, 14, 2, 0xffffcc);
        this.createBlock(hx + 8, 8, hz + 14, 10, 14, 2, 0xffffcc);
        this.createBlock(hx, 12, hz + 14, 6, 6, 2, 0xffffcc); // Door header
        // Roof
        const roof = this.createBlock(hx, 16, hz, 34, 2, 34, 0xcc0000);
        roof.rotation.x = 0.1;
        
        // Trampoline
        const tx = 40; const tz = 40;
        this.createBlock(tx, 0.5, tz, 12, 1, 12, 0x111111);
        this.createBlock(tx, 1.5, tz, 10, 1, 10, 0x0000ff, ['static', 'launch']);


        // Teleporter to Mega Platform
        const tp = this.createBlock(-15, 2.1, 0, 6, 0.2, 6, 0x00ff00, ['static', 'teleport']);
        tp.userData = { destination: new THREE.Vector3(1000, 5, 0), name: "Mega Platform" };

        // MEGA PLATFORM (Offset 1000)
        const ox = 1000;
        const oz = 0;

        // Main Floor (200x200)
        this.createBlock(ox, 0, oz, 200, 2, 200, 0x555555);

        // 1. CARS
        const car1 = new Vehicle(this.scene, ox + 20, 5, oz - 20, 0xff0000);
        this.vehicles.push(car1);
        
        const car2 = new Vehicle(this.scene, ox + 30, 5, oz - 20, 0x0055ff);
        this.vehicles.push(car2);

        // 2. CRUSHER
        // Base
        this.createBlock(ox - 40, 1, oz + 40, 20, 2, 20, 0x333333);
        // Crusher Head
        const crusher = this.createBlock(ox - 40, 15, oz + 40, 18, 10, 18, 0x222222, ['static', 'kill']);
        this.animated.push({
            mesh: crusher,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 1.5;
                // Move between y=3 and y=25
                obj.mesh.position.y = 14 + Math.sin(obj.time) * 11;
            }
        });

        // 4. RAMP (Using steps for collision stability, as simple box collision is AABB)
        const rx = ox + 50;
        const rz = oz + 50;
        for(let i=0; i<20; i++) {
            // Ramp going up
            this.createBlock(rx, i, rz + i*2, 20, 1, 2, 0x888888);
        }
        // Jump pad at end of ramp
        this.createBlock(rx, 20, rz + 42, 20, 1, 6, 0xff00ff, ['static', 'launch']);

        // 5. SWINGSET
        const sx = ox + 20;
        const sz = oz + 60;
        // Frame
        this.createBlock(sx - 10, 15, sz, 1, 30, 1, 0x4e342e);
        this.createBlock(sx + 10, 15, sz, 1, 30, 1, 0x4e342e);
        this.createBlock(sx, 30, sz, 22, 1, 1, 0x4e342e);
        // Swing Seat
        const seat = this.createBlock(sx, 10, sz, 6, 0.5, 4, 0xff0000);
        this.animated.push({
            mesh: seat,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 2.5;
                const angle = Math.sin(obj.time) * 0.8;
                // Pivot is at (sx, 30, sz)
                const len = 20;
                obj.mesh.position.x = sx + Math.sin(angle) * len;
                obj.mesh.position.y = 30 - Math.cos(angle) * len;
                obj.mesh.rotation.z = -angle;
            }
        });

        // 6. FLOAT ERROR TELEPORTER
        // Far out on the platform
        const fpTp = this.createBlock(ox + 90, 1.1, oz + 90, 8, 0.2, 8, 0xff00ff, ['static', 'teleport']);
        fpTp.userData = { destination: new THREE.Vector3(ox, 1000000, oz), name: "Far Lands" };
        
        // Floating Point Platform
        const fpx = ox;
        const fpy = 1000000;
        // Need to add this to world, but createBlock adds to group. 
        // Note: Rendering at 1,000,000 might cause jitter (z-fighting/precision), which is the intended effect!
        const fpGeo = new THREE.BoxGeometry(50, 2, 50);
        boxUnwrapUVs(fpGeo);
        const fpMesh = new THREE.Mesh(fpGeo, new THREE.MeshStandardMaterial({color: 0xaaaaaa, map: surfaceManager.textures.studs}));
        fpMesh.position.set(fpx, fpy - 5, oz);
        this.addToWorld(fpMesh);
    }

    setupObby() {
        // Start
        this.createBlock(0, 0, 0, 14, 1, 14, 0x00cc00);

        // Step 1
        this.createBlock(0, 0, -15, 8, 1, 8, 0xaaaaaa);

        // Step 2
        this.createBlock(0, 2, -25, 6, 1, 6, 0xaaaaaa);

        // Step 3 (Gap)
        this.createBlock(0, 4, -36, 4, 1, 4, 0xaaaaaa);

        // Step 4 (Wall Jump / High)
        this.createBlock(0, 6, -45, 4, 1, 4, 0xaaaaaa);

        // Truss/Beam
        this.createBlock(0, 6, -55, 2, 1, 10, 0x666666);
        
        // Kill obstacle on beam
        this.createBlock(0, 6.75, -55, 2, 0.5, 2, 0xff0000, ['static', 'kill']);

        // End
        this.createBlock(0, 8, -70, 15, 1, 15, 0xffff00);
        // Winner pillar
        this.createBlock(0, 12, -70, 2, 8, 2, 0xffaa00);
    }

    setupChirplessHunt() {
        // Large grassy base
        const base = this.createBlock(0, -1, 0, 300, 2, 300, 0x2e8b57, ['static']);
        base.name = "Grasslands";
        
        // Spawn Location
        this.createBlock(0, 0.5, 0, 10, 1, 10, 0xcccccc, ['static', 'spawn']);

        // A "nice" tiered fountain or centerpiece
        for(let i=0; i<4; i++) {
            const size = 30 - (i * 6);
            this.createBlock(0, i * 2, 0, size, 2, size, 0x88ccff);
        }
        // Top of fountain - The "Chirp" trophy (a yellow sphere)
        const trophy = this.createPart('sphere', 0, 10, 0, {x:4, y:4, z:4}, 0xffcc00);
        trophy.name = "The Chirp";
        this.animated.push({
            mesh: trophy,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 2;
                obj.mesh.position.y = 10 + Math.sin(obj.time) * 1.5;
                obj.mesh.rotation.y += dt;
            }
        });

        // Scattered "Eggs" or items to hunt
        const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
        for(let i=0; i<15; i++) {
            const rx = (Math.random() - 0.5) * 200;
            const rz = (Math.random() - 0.5) * 200;
            const color = colors[Math.floor(Math.random() * colors.length)];
            const egg = this.createPart('sphere', rx, 1, rz, {x:2, y:2, z:2}, color);
            egg.name = "Egg " + (i+1);
        }

        // Some nature-like pillars/trees
        for(let i=0; i<10; i++) {
            const rx = (Math.random() - 0.5) * 240;
            const rz = (Math.random() - 0.5) * 240;
            if (Math.abs(rx) < 20 && Math.abs(rz) < 20) continue; // don't spawn near center
            
            // Trunk
            this.createBlock(rx, 5, rz, 2, 10, 2, 0x5d4037);
            // Leaves
            this.createBlock(rx, 11, rz, 8, 4, 8, 0x1b5e20);
        }

        // Floating parkour challenge
        for(let i=0; i<8; i++) {
            this.createBlock(-60 - (i*10), 5 + (i*3), -60, 6, 1, 6, 0xeeeeee);
        }
        // Prize at end of parkour
        this.createBlock(-140, 28, -60, 4, 4, 4, 0xffd700, ['static', 'launch']);
    }

    // New large city map: ChirpCity
    setupChirpCity() {
        // Large city footprint
        const base = this.createBlock(0, -1, 0, 1200, 2, 1200, 0x9aa0a6, ['static']);
        // Central spawn plaza
        this.createBlock(0, 0.5, 0, 24, 1, 24, 0xcccccc, ['static', 'spawn']);

        // Grid of streets with blocks of buildings
        const blockSize = 60;
        const spacing = 80;
        const rows = 6;
        const cols = 6;
        const startX = -((cols-1) * spacing) / 2;
        const startZ = -((rows-1) * spacing) / 2;

        for (let r=0; r<rows; r++) {
            for (let c=0; c<cols; c++) {
                const bx = startX + c * spacing;
                const bz = startZ + r * spacing;
                // Random building height and footprint
                const bw = blockSize - 8 + Math.floor(Math.random()*10);
                const bd = blockSize - 8 + Math.floor(Math.random()*10);
                const h = 10 + Math.floor(Math.random()*40);
                // Most buildings are solid; create as simple box
                const building = this.createBlock(bx, h/2, bz, bw, h, bd, 0xcccccc, ['static']);
                building.name = `Building_${r}_${c}`;
                // A few windows / roof elements
                if (Math.random() < 0.15) {
                    // small rooftop structure
                    this.createBlock(bx + 6, h + 2, bz - 6, 8, 4, 8, 0x444444, ['static']);
                }
            }
        }

        // Create two accessible interior buildings (with openings/doorways)
        const houseA = this.createBlock(-120, 12, 180, 40, 24, 40, 0xe0d6c8, ['static']);
        // Carve out a doorway by placing a thin empty space (use a thin "door" and mark as not collidable by not adding to collidables) 
        const doorA = this.createBlock(-120, 6, 200, 12, 12, 0.5, 0x663300, ['static']);
        doorA.userData.isDoor = true;
        doorA.userData.candyAvailable = false;

        const interiorFloor = this.createBlock(-120, 0.5, 180, 38, 1, 38, 0xaaaaaa, ['static']);
        // Make a simple interior room by placing a few inner parts (tables)
        this.createBlock(-120, 2, 180, 6, 2, 4, 0x8b5a2b, ['static']);

        const houseB = this.createBlock(260, 10, -140, 50, 20, 36, 0xdedede, ['static']);
        const doorB = this.createBlock(260, 5, -122, 10, 10, 0.5, 0x663300, ['static']);
        doorB.userData.isDoor = true;
        doorB.userData.candyAvailable = false;
        this.createBlock(260, 0.5, -140, 46, 1, 32, 0x999999, ['static']);

        // Gas Station: pumps + canopy + small shop
        const gx = 80, gz = -250;
        // canopy
        this.createBlock(gx, 8, gz, 40, 1, 30, 0xffffff, ['static']);
        // pumps (decorative)
        for (let i=0;i<4;i++) {
            const px = gx - 12 + i*8;
            const p = this.createBlock(px, 1.2, gz - 6, 2, 2.4, 2, 0xff0000, ['static']);
            p.name = 'GasPump';
        }
        // small shop
        this.createBlock(gx + 30, 4, gz, 12, 8, 10, 0xffffcc, ['static']);

        // Main downtown tower cluster (tall buildings)
        for (let i=0; i<8; i++) {
            const tx = 360 + (i%4) * 18;
            const tz = 220 + Math.floor(i/4) * 18;
            const th = 40 + Math.floor(Math.random()*120);
            this.createBlock(tx, th/2, tz, 12, th, 12, 0x444b55, ['static']);
        }

        // Add some roads (long thin blocks) to visually separate blocks
        for (let i= -400; i<=400; i+=80) {
            this.createBlock(i, 0.1, -420, 60, 0.2, 1600, 0x222222, ['static']);
            this.createBlock(-420, 0.1, i, 1600, 0.2, 60, 0x222222, ['static']);
        }

        // Add a large park and plaza near center with some props
        this.createBlock(0, 0.5, 220, 140, 1, 140, 0x66bb66, ['static']);
        for (let i=0;i<12;i++) {
            const rx = (Math.random()-0.5) * 120;
            const rz = 220 + (Math.random()-0.5) * 120;
            this.createBlock(rx, 2, rz, 4, 4, 4, 0x8b5a2b);
        }

        // Make city "big" by adding a few outlying landmarks
        this.createBlock(-520, 1, 0, 80, 2, 80, 0x555555, ['static']); // industrial yard
        this.createBlock(520, 1, 0, 80, 2, 80, 0x555555, ['static']);  // stadium pad

        // Name some important objects
        this.items.forEach(it => {
            if (it.name && it.name.startsWith('Building')) {
                // keep as-is
            }
        });

        // Add a few animated elements (traffic light placeholders)
        const light = this.createBlock(40, 6, 40, 1, 8, 1, 0x222222, ['static']);
        this.animated.push({
            mesh: light,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt;
                const t = Math.floor(obj.time) % 3;
                // no-op visual placeholder (could swap colors), kept lightweight
            }
        });

        // Provide large map name
        base.name = 'ChirpCity';
    }

    // Lucky World: coins on the floor to collect for buying pets
    setupLuckyWorld() {
        // Ground
        this.createBlock(0, -1, 0, 200, 2, 200, 0x66bb66, ['static']);
        // Spawn pad
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Scatter many coin pickups (ensure they are added to items so collection logic sees them)
        const coinGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12);
        coinGeom.rotateX(Math.PI/2);
        for (let i=0; i<60; i++) {
            const rx = (Math.random() - 0.5) * 160;
            const rz = (Math.random() - 0.5) * 160;
            const ry = 1 + Math.random() * 1.5;
            const mat = new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0x886600, metalness: 1.0, roughness: 0.2 });
            const coin = new THREE.Mesh(coinGeom.clone(), mat);
            coin.position.set(rx, ry, rz);
            coin.userData.serial = { type: 'coin' };
            coin.name = 'Coin';
            this.mapGroup.add(coin);
            this.items.push(coin);
            // coins are not collidables so they don't block movement
        }

        // Pet shop marker (in-world)
        const shop = this.createBlock(12, 1, 12, 6, 2, 6, 0x88ccff, ['static']);
        shop.name = 'PetShop';
    }

    // SillyVille: garden planting map
    setupSillyVille() {
        // Ground
        this.createBlock(0, -1, 0, 200, 2, 200, 0x88cc88, ['static']);
        // Spawn pad
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Simple garden plots: grid of small soil boxes (visual only)
        const plotCols = 6;
        const plotRows = 4;
        const spacing = 12;
        const startX = -((plotCols - 1) * spacing) / 2;
        const startZ = -20;
        for (let r = 0; r < plotRows; r++) {
            for (let c = 0; c < plotCols; c++) {
                const px = startX + c * spacing;
                const pz = startZ + r * spacing;
                const soil = this.createBlock(px, 0.2, pz, 6, 0.4, 6, 0x6b4226, ['static']);
                soil.name = `Plot_${r}_${c}`;
            }
        }

        // Decorative fence and benches
        for (let i = 0; i < 12; i++) {
            this.createBlock(-80 + i * 13, 1.5, 90, 2, 3, 1, 0x8b5a2b, ['static']);
        }
        this.createBlock(0, 1, 90, 40, 2, 2, 0x444444, ['static']).name = 'GardenBench';

        // Simple sign with instructions (canvas texture)
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff8dc';
        ctx.fillRect(0, 0, 256, 64);
        ctx.fillStyle = '#333';
        ctx.font = '18px serif';
        ctx.fillText('SillyVille: Press E to plant seeds (max 6). Each seed = +1 point/sec', 8, 36);
        const tex = new THREE.CanvasTexture(canvas);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(20, 5), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
        sign.position.set(0, 6, 80);
        sign.rotation.y = Math.PI;
        this.mapGroup.add(sign);
        this.items.push(sign);
    }

    setupChirplessHalloween() {
        // Small town Halloween map with one house and a knockable door that gives candy once
        // Ground
        this.createBlock(0, -1, 0, 120, 2, 120, 0x222222, ['static']);
        // Spawn pad
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // House footprint
        const hx = 0, hz = -30;
        this.createBlock(hx, 1, hz, 40, 1, 40, 0x4d2a20); // floor
        this.createBlock(hx - 19, 10, hz, 2, 18, 40, 0xefe6d6); // left wall
        this.createBlock(hx + 19, 10, hz, 2, 18, 40, 0xefe6d6); // right wall
        this.createBlock(hx, 10, hz - 19, 36, 18, 2, 0xefe6d6); // back wall
        // Front wall split to leave door
        this.createBlock(hx - 10, 10, hz + 19, 16, 18, 2, 0xefe6d6);
        this.createBlock(hx + 10, 14, hz + 19, 8, 10, 2, 0xefe6d6); // window block

        // Roof
        this.createBlock(hx, 20, hz, 44, 2, 44, 0x2b1b17);

        // Door (small thin part used as interactable object)
        const door = this.createBlock(hx, 5, hz + 19.6, 4, 8, 0.2, 0x663300, ['static']);
        door.name = 'Door';
        door.userData.isDoor = true;
        door.userData.candyAvailable = true; // one-time candy

        // A porch light (just decoration)
        this.createBlock(hx - 6, 8, hz + 21, 2, 2, 0.2, 0xffff88, ['static']);

        // Some pumpkins
        for (let i=0;i<6;i++) {
            const px = hx + Math.random()*20 - 10;
            const pz = hz + 22 + Math.random()*6 - 3;
            this.createPart('sphere', px, 1, pz, {x:1.5,y:1.5,z:1.5}, 0xff6600);
        }
    }

    // Easter 2026: simple obby with NPC to start and 2 stages; completing unlocks a build tool for the player
    setupMemories() {
        // Suburban Florida-style home with backyard garden and grandma vibe
        // Ground / Lot
        this.createBlock(0, -1, 0, 120, 2, 120, 0x88cc88, ['static']);
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Front yard - walkway and small porch
        this.createBlock(0, 0.6, 20, 40, 1, 40, 0x77aa66, ['static']);
        this.createBlock(0, 1.6, 26, 8, 1, 16, 0xddddcc, ['static']); // porch
        this.createBlock(0, 4, 30, 6, 6, 1, 0x663300, ['static']); // front step/barrier

        // House body
        const hx = 0;
        const hz = 0;
        this.createBlock(hx, 4.5, hz, 36, 9, 24, 0xfff1e0, ['static']); // main walls
        this.createBlock(hx, 10.5, hz, 38, 2, 26, 0x8b5a2b, ['static']); // roof ridge
        // Windows
        this.createBlock(hx - 10, 5, hz + 8, 4, 4, 0.5, 0xffffff, ['static']);
        this.createBlock(hx + 10, 5, hz + 8, 4, 4, 0.5, 0xffffff, ['static']);
        // Door
        const door = this.createBlock(hx, 3.5, hz + 12, 4, 7, 0.5, 0x663300, ['static']);
        door.userData.isDoor = true;
        door.name = 'FrontDoor';

        // Garage / side storage
        this.createBlock(hx + 22, 3, hz - 4, 12, 6, 12, 0xe0e0e0, ['static']);
        // Driveway
        this.createBlock(hx + 28, 0.1, hz - 28, 8, 0.2, 40, 0x222222, ['static']);

        // Backyard: patio, garden beds, small shed, fence
        // Patio
        const by = -30;
        this.createBlock(hx, 1, by, 30, 1, 18, 0xcccccc, ['static']);
        // Garden beds (three rows)
        for (let i = 0; i < 3; i++) {
            const gx = hx - 10 + i * 10;
            const gz = by - 12;
            const bed = this.createBlock(gx, 1.2, gz, 6, 0.6, 12, 0x7a5f3b, ['static']);
            bed.name = `GardenBed_${i+1}`;
            // Add a few plant props in each bed
            for (let p = 0; p < 4; p++) {
                this.createPart('sphere', gx + (p - 1.5) * 1.6, 2.2, gz + (Math.random() - 0.5) * 4, {x:1.2,y:1.2,z:1.2}, 0x33aa33);
            }
        }

        // Small shed
        this.createBlock(hx - 24, 3, by - 6, 8, 6, 8, 0xd8c4a1, ['static']);
        // Fence around backyard
        const fenceY = 3;
        const fenceZ = by - 26;
        // back fence
        this.createBlock(hx, fenceY, by - 40, 80, 4, 1, 0xffffff, ['static']);
        // side fences
        this.createBlock(hx - 40, fenceY, by - 10, 1, 4, 60, 0xffffff, ['static']);
        this.createBlock(hx + 40, fenceY, by - 10, 1, 4, 60, 0xffffff, ['static']);

        // Grandma details: rocking chair on porch, potted plants
        const chair = this.createBlock(hx - 4, 2.2, 26, 2, 2, 1, 0x8b5a2b, ['static']);
        chair.name = 'RockingChair';
        // Potted plant
        this.createPart('cylinder', hx + 6, 2.2, 26, {x:1.4,y:2.4,z:1.4}, 0xaa7744);

        // Garden decorations: birdbath, wheelbarrow (simple blocks)
        this.createPart('sphere', hx - 12, 2.5, by - 8, {x:1.2,y:1.2,z:1.2}, 0xddddff).name = 'Birdbath';
        this.createBlock(hx + 12, 1.5, by - 6, 4, 1, 2, 0xff6600).name = 'Wheelbarrow';

        // Lighting / lanterns along path (visual only)
        for (let i = 0; i < 6; i++) {
            const lx = hx - 18 + i * 6;
            const lz = 8;
            this.createBlock(lx, 3.5, lz, 1, 4, 1, 0x222222, ['static']);
        }

        // Mark the backdoor as interactable for possible future candy/knock interactions
        const backDoor = this.createBlock(hx, 3.5, by + 9, 3, 6, 0.5, 0x663300, ['static']);
        backDoor.userData.isDoor = true;
        backDoor.name = 'BackDoor';
    }

    // New Map: Home (interior horror map)
    setupHome() {
        // Small interior house map: player spawns inside; non-blocking narrow collisions to avoid trapping
        // Floor and simple rooms
        this.createBlock(0, -1, 0, 80, 2, 80, 0x222222, ['static']); // lot ground (dark)
        this.createBlock(0, 0.5, 0, 20, 1, 30, 0x3a2f2a, ['static', 'spawn']); // interior floor

        // Walls (thin to reduce trapping); leave doorways open
        this.createBlock(0, 4.5, -14, 20, 9, 1, 0xefe6d6, ['static']); // back wall
        this.createBlock(-10, 4.5, 0, 1, 9, 28, 0xefe6d6, ['static']); // left wall
        this.createBlock(10, 4.5, 0, 1, 9, 28, 0xefe6d6, ['static']); // right wall
        // Partial front walls with doorway gaps
        this.createBlock(-6, 4.5, 14, 8, 9, 1, 0xefe6d6, ['static']);
        this.createBlock(6, 4.5, 14, 8, 9, 1, 0xefe6d6, ['static']);

        // Interior partitions: living room and kitchen area (low props to avoid full blocking)
        this.createBlock(-3, 1.5, -2, 6, 3, 1, 0x6b4f3b, ['static']).name = 'Counter';
        this.createBlock(5, 1.5, -4, 4, 3, 1, 0x4e342e, ['static']).name = 'Shelf';

        // Furniture (low, non-collidable decorative items to avoid trapping)
        const couch = this.createBlock(-6, 1, 6, 6, 2, 2, 0x884422, ['static']);
        couch.name = 'Couch';
        // Make chairs and small tables non-collidable props (so players don't get stuck)
        const table = this.createBlock(0, 1, 6, 2, 1, 2, 0x553322, []); // not added to collidables

        // Ambient spooky lights (visual only)
        const lamp = this.createBlock(8, 3.5, 8, 1, 4, 1, 0x222222, ['static']);
        lamp.name = 'Lamp';

        // Create a roaming ghost entity (animated) that occasionally teleports and floats
        const ghostGeo = new THREE.SphereGeometry(1.0, 12, 8);
        const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x66aaff, transparent: true, opacity: 0.0 });
        const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat);
        ghostMesh.position.set(-8, 3, -6);
        ghostMesh.name = 'Ghost';
        this.mapGroup.add(ghostMesh);
        this.items.push(ghostMesh);

        // Add subtle animated behavior: bob and occasionally become visible near the player
        this.animated.push({
            mesh: ghostMesh,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt;
                // Bob up and down
                obj.mesh.position.y = 2.5 + Math.sin(obj.time * 2.0) * 0.5;
                // Fade in/out occasionally
                const phase = (Math.sin(obj.time * 0.6) + 1) * 0.5;
                obj.mesh.material.opacity = Math.min(0.7, phase * 0.9);
                // Occasionally teleport to a new location inside the house for jump-scare
                if (Math.random() < dt * 0.02) { // ~2% chance per second
                    const rx = (Math.random() * 14) - 7;
                    const rz = (Math.random() * 26) - 13;
                    obj.mesh.position.set(rx, 3 + Math.random() * 2, rz);
                }
            }
        });

        // Add a couple of hidden "scare" triggers (thin planes) that are collidable but minimal to avoid trapping
        const scare1 = this.createBlock(-8, 0.5, 10, 1, 2, 0.2, 0x000000, ['static']);
        scare1.name = 'ScareTrigger1';
        scare1.userData.isScare = true;

        const scare2 = this.createBlock(9, 0.5, -10, 1, 2, 0.2, 0x000000, ['static']);
        scare2.name = 'ScareTrigger2';
        scare2.userData.isScare = true;

        // Small ambient decoration outside (porch)
        this.createBlock(0, 1, 18, 10, 1, 4, 0x444444, ['static']);
    }

    // New Map: Chirple - large open map with drivable cars
    setupChirple() {
        // Middle Eastern themed map: desert plaza, souk lanes, minaret, oasis and market stalls
        // Desert ground
        this.createBlock(0, -1, 0, 1200, 2, 1200, 0xD7C49A, ['static']);
        // Central spawn plaza (mosaic)
        this.createBlock(0, 0.5, 0, 40, 1, 40, 0xD6A86A, ['static', 'spawn']);

        // Ornamental low walls and market lanes (souk)
        for (let r = -4; r <= 4; r++) {
            for (let c = -6; c <= 6; c++) {
                const baseX = c * 18;
                const baseZ = r * 14;
                // little stall awnings
                if ((Math.abs(r) + Math.abs(c)) % 2 === 0) {
                    const stall = this.createBlock(baseX, 1.5, baseZ, 10, 3, 8, 0x8b5a2b, ['static']);
                    stall.name = 'Stall';
                    // awning
                    this.createBlock(baseX, 4, baseZ - 3.5, 10, 1, 3, 0xC04E00, ['static']);
                } else {
                    // decorative pot / crate
                    this.createPart('cylinder', baseX + (Math.random()-0.5)*4, 1, baseZ + (Math.random()-0.5)*4, {x:1.5,y:2.0,z:1.5}, 0x7c5a3a);
                }
            }
        }

        // Oasis pool
        const oasis = this.createPart('sphere', -220, 1, 160, {x: 24, y: 2, z: 24}, 0x2aa6d6);
        oasis.name = 'Oasis';

        // Minaret / tower landmark
        for (let i = 0; i < 8; i++) {
            this.createBlock(160, 6 + i*8, -200, 8, 8, 8, 0xBFA07A, ['static']);
        }
        // Dome on top
        this.createPart('sphere', 160, 70, -200, {x:12,y:12,z:12}, 0xFFD700).name = 'Dome';

        // Caravan row (decorative)
        for (let i = 0; i < 12; i++) {
            const cx = -300 + i * 25;
            const cz = 260 + Math.sin(i) * 8;
            this.createBlock(cx, 1.5, cz, 12, 3, 6, 0x7a4b2b, ['static']);
        }

        // Narrow alleys and elevated walkways
        for (let i = 0; i < 30; i++) {
            const x = (Math.random() - 0.5) * 800;
            const z = (Math.random() - 0.5) * 800;
            const w = 6 + Math.random() * 10;
            const d = 8 + Math.random() * 12;
            const h = 1 + Math.random() * 3;
            this.createBlock(x, h/2, z, w, h, d, 0xC9A57A, ['static']);
        }

        // Caravanserai: a large courtyard
        this.createBlock(-420, 0.5, -80, 120, 2, 120, 0xC9B089, ['static']);
        // Market canopy area near center
        this.createBlock(40, 6, 40, 70, 1, 60, 0xB54F18, ['static']);

        // Decorative roads
        for (let i= -600; i<=600; i+=120) {
            this.createBlock(i, 0.05, -600, 40, 0.2, 1200, 0xA17A59, ['static']);
            this.createBlock(-600, 0.05, i, 1200, 0.2, 40, 0xA17A59, ['static']);
        }

        // Small fountain and benches in plaza
        const fountain = this.createPart('cylinder', 0, 1.2, 8, {x:6,y:1,z:6}, 0x2aa6d6);
        fountain.name = 'Fountain';
        for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2;
            this.createBlock(Math.cos(ang)*10, 1, Math.sin(ang)*10, 2, 1, 6, 0x6b4f3b, ['static']);
        }

        // Place a few vehicles that can be driven (support for car gameplay retained)
        const centers = [
            {x: 80, z: -60, c: 0xffaa55},
            {x: -140, z: 120, c: 0x55aaff},
            {x: 220, z: 40, c: 0xffcc00}
        ];
        centers.forEach((cfg) => {
            const v = new Vehicle(this.scene, cfg.x, 5, cfg.z, cfg.c);
            this.vehicles.push(v);
        });

        // Name map
        // Optionally set a representative item name if present
        // (not strictly necessary)
    }

    // FlowerVille: simple garden map with a sword pickup and roaming "zombie plant" mobs
    // New Map: Blocks - Concrete slab park with forest, mini-golf, and benches that can be 'sat' on
    // New: Scary Forest map with fog, eerie lighting and a few hidden easter eggs
    setupScaryForest() {
        // Foggy ambient ground
        this.createBlock(0, -1, 0, 400, 2, 400, 0x1e2a27, ['static']);
        // Spawn pad
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0x444444, ['static', 'spawn']);

        // Create clustered dark trees
        for (let i = 0; i < 120; i++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = 40 + Math.random() * 140;
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;
            // trunk
            this.createBlock(x, 3.5, z, 1, 7, 1, 0x2b1b17, ['static']);
            // canopy
            this.createBlock(x, 7.5, z, 6, 4, 6, 0x053018, ['static']);
        }

        // Add some mossy rocks / ruins for atmosphere
        for (let i = 0; i < 18; i++) {
            const rx = (Math.random() - 0.5) * 220;
            const rz = (Math.random() - 0.5) * 220;
            this.createBlock(rx, 0.6, rz, 4 + Math.random()*4, 1.2 + Math.random()*2, 3 + Math.random()*4, 0x2f3430, ['static']);
        }

        // Fog planes (visual decoy) - low-overlapping semi-transparent planes to suggest mist
        for (let f = 0; f < 12; f++) {
            const fx = (Math.random() - 0.5) * 300;
            const fz = (Math.random() - 0.5) * 300;
            const planeGeo = new THREE.PlaneGeometry(60, 30);
            planeGeo.rotateX(-Math.PI / 2);
            const mat = new THREE.MeshBasicMaterial({ color: 0x0f1a1a, transparent: true, opacity: 0.12 });
            const mesh = new THREE.Mesh(planeGeo, mat);
            mesh.position.set(fx, 2 + Math.random()*3, fz);
            mesh.rotation.y = Math.random() * Math.PI;
            this.mapGroup.add(mesh);
            this.items.push(mesh);
        }

        // Add spooky lanterns along a winding path (decorative)
        for (let p = 0; p < 24; p++) {
            const t = p / 24 * Math.PI * 2;
            const x = Math.cos(t) * (20 + Math.sin(p) * 6);
            const z = Math.sin(t) * (20 + Math.cos(p) * 6);
            const lamp = this.createBlock(x, 2.5, z, 0.6, 4, 0.6, 0x222222, ['static']);
            lamp.name = 'Lantern';
            // marker plane for light (visual)
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'rgba(200,150,60,0.9)';
            ctx.beginPath(); ctx.arc(32,32,16,0,Math.PI*2); ctx.fill();
            const tex = new THREE.CanvasTexture(canvas);
            const glow = new THREE.Mesh(new THREE.PlaneGeometry(6,6), new THREE.MeshBasicMaterial({ map: tex, transparent:true, opacity:0.6 }));
            glow.position.set(x, 3.5, z);
            glow.rotation.y = Math.random()*Math.PI;
            this.mapGroup.add(glow);
            this.items.push(glow);
        }

        // Easter Eggs: hidden music box, a carved rune, and a tiny clearing with an odd statue
        // a) music box - small coin-like cylinder under a tree
        const music = this.createPart('cylinder', -28, 0.8, 12, {x:0.8,y:0.3,z:0.8}, 0xffd700);
        music.name = 'MusicBox';
        // b) carved rune (plane with canvas texture)
        const cCanvas = document.createElement('canvas');
        cCanvas.width = 128; cCanvas.height = 128;
        const cctx = cCanvas.getContext('2d');
        cctx.fillStyle = '#000';
        cctx.fillRect(0,0,128,128);
        cctx.strokeStyle = '#88ff88';
        cctx.lineWidth = 6;
        cctx.beginPath();
        cctx.moveTo(20,108); cctx.lineTo(64,20); cctx.lineTo(108,108);
        cctx.stroke();
        const runeTex = new THREE.CanvasTexture(cCanvas);
        const rune = new THREE.Mesh(new THREE.PlaneGeometry(4,4), new THREE.MeshBasicMaterial({ map: runeTex, transparent:true }));
        rune.position.set(38, 3, -14);
        rune.rotation.y = Math.PI;
        this.mapGroup.add(rune);
        this.items.push(rune);
        rune.name = 'Rune';

        // c) statue clearing
        const sx = 80, sz = -40;
        const clear = this.createBlock(sx, 1, sz, 6, 2, 6, 0x444444);
        clear.name = 'Clearing';
        const statue = this.createPart('sphere', sx, 3.5, sz, {x:2,y:4,z:2}, 0x666666);
        statue.name = 'OddStatue';

        // Subtle ambient audio hint placeholder (BGM left empty; client may play world.bgm)
        this.bgm = null;

        // Add a tiny idle animation to statue to feel alive
        this.animated.push({
            mesh: statue,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt;
                obj.mesh.position.y += Math.sin(obj.time * 1.5) * 0.001;
            }
        });

        // Done: Scary Forest
    }

    setupPrisonLife() {
        // Compact prison compound: yard, cells, guard tower, patrolling guards
        // Ground
        this.createBlock(0, -1, 0, 200, 2, 200, 0x444444, ['static']);
        // Spawn pad inside yard
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Perimeter walls
        const wallH = 10;
        const wallTh = 2;
        const ext = 80;
        this.createBlock(0, wallH/2, -ext, 160, wallH, wallTh, 0x222222, ['static']);
        this.createBlock(0, wallH/2, ext, 160, wallH, wallTh, 0x222222, ['static']);
        this.createBlock(-ext, wallH/2, 0, wallTh, wallH, 160, 0x222222, ['static']);
        this.createBlock(ext, wallH/2, 0, wallTh, wallH, 160, 0x222222, ['static']);

        // Main yard area props
        this.createBlock(0, 1, -20, 30, 1, 12, 0x666666).name = 'YardBench';
        this.createBlock(12, 1, 24, 6, 1, 6, 0x333333).name = 'ExercisePlatform';

        // Cell block: grid of small cells with bars (thin walls)
        const cellsX = 4;
        const cellsZ = 2;
        const cellW = 10;
        const cellD = 8;
        const startX = -((cellsX - 1) * (cellW + 2)) / 2;
        const startZ = -50;
        for (let rz = 0; rz < cellsZ; rz++) {
            for (let cx = 0; cx < cellsX; cx++) {
                const x = startX + cx * (cellW + 2);
                const z = startZ + rz * (cellD + 4);
                // cell floor
                this.createBlock(x, 0.5, z, cellW, 1, cellD, 0x555555, ['static']);
                // back wall
                this.createBlock(x, 3.5, z - (cellD/2 - 0.5), cellW, 6, 1, 0x777777, ['static']);
                // side walls
                this.createBlock(x - (cellW/2 - 0.5), 3.5, z, 1, 6, cellD, 0x777777, ['static']);
                this.createBlock(x + (cellW/2 - 0.5), 3.5, z, 1, 6, cellD, 0x777777, ['static']);
                // front bars (thin panel serving as gate)
                const gate = this.createBlock(x, 3.5, z + (cellD/2 - 0.5), cellW - 2, 6, 0.2, 0x222222, ['static']);
                gate.name = 'CellGate';
                gate.userData.isGate = true;
                gate.userData.open = false;
                // simple bed inside
                this.createBlock(x - 2, 1, z, 6, 1, 2, 0x663300, ['static']).name = 'Bed';
            }
        }

        // Guard tower at center rear
        const tower = this.createBlock(0, 12, 70, 10, 24, 10, 0x333333, ['static']);
        tower.name = 'GuardTower';
        // platform and roof
        this.createBlock(0, 25, 70, 12, 2, 12, 0x222222, ['static']);

        // Guard NPCs: player-like police NPCs (blue uniform + police hat) that patrol waypoints
        this._prisonGuards = [];
        const guardPoints = [
            [ -30, 0, -10 ], [ -30, 0, 40 ], [ 30, 0, 40 ], [ 30, 0, -10 ]
        ];

        // Create four police-style guards using the player mesh factory and tint their materials blue
        for (let i = 0; i < 4; i++) {
            const gp = guardPoints[i];

            // Collect materials created by the player mesh so we can tint them
            const matsStore = {};
            const guardMesh = createPlayerMesh(matsStore);

            // Position and scale to look like an NPC guard
            guardMesh.position.set(gp[0], 1.2, gp[2]);
            guardMesh.scale.set(1.0, 1.0, 1.0);
            guardMesh.name = `PoliceGuard_${i+1}`;

            // Tint all part material slots to police blue for uniform + hat color
            const policeBlue = new THREE.Color(0x1e5aff); // bright police blue
            Object.values(matsStore).forEach(matArray => {
                if (Array.isArray(matArray)) {
                    matArray.forEach(m => { if (m && m.color) m.color.copy(policeBlue); });
                } else if (matArray && matArray.color) {
                    matArray.color.copy(policeBlue);
                }
            });

            // Slightly darken torso to suggest uniform vs hat by adjusting emissive or multiply
            try {
                if (matsStore.torso && Array.isArray(matsStore.torso) && matsStore.torso[4]) {
                    // make torso a touch darker
                    matsStore.torso.forEach(m => { if (m && m.color) m.color.multiplyScalar(0.9); });
                }
            } catch (e) {}

            // Add to world and mark as non-collidable decorative NPC (so players can pass)
            this.mapGroup.add(guardMesh);
            this.items.push(guardMesh);

            // Attach patrol metadata used by world.animated patrol updater
            guardMesh.userData = guardMesh.userData || {};
            guardMesh.userData.patrol = guardPoints.map(p => new THREE.Vector3(p[0], 1.2, p[2]));
            guardMesh.userData.patrolIndex = 0;
            guardMesh.userData.speed = 6 + Math.random() * 4;
            guardMesh.userData.isNPC = true;
            // Enable chasing behavior so guards pursue nearby players
            guardMesh.userData.chase = true;
            this._prisonGuards.push(guardMesh);
        }

        // Light posts along walkway
        for (let i= -2; i<=2; i++) {
            this.createBlock(i*18, 3, -10, 1, 6, 1, 0x222222, ['static']).name = 'Lamp';
        }

        // Announce no BGM by default
        this.bgm = null;

        // Add update hook for guard patrols and chasing behavior
        this.animated.push({
            mesh: null,
            time: 0,
            update: (dt, obj) => {
                // patrol + chase logic
                this._prisonGuards.forEach(g => {
                    if (!g) return;
                    try {
                        const player = (typeof window !== 'undefined' && window.player) ? window.player : null;
                        const pos = g.position;
                        // If a nearby player exists and guard has chase enabled, pursue and attack
                        if (player && g.userData && g.userData.chase) {
                            const toPlayer = player.position.clone().sub(pos);
                            const distToPlayer = toPlayer.length();
                            // If within detection radius, chase
                            const detectRadius = 30;
                            if (distToPlayer < detectRadius) {
                                // Move toward player
                                const dir = toPlayer.normalize();
                                const speed = (g.userData.speed || 6) * 1.2;
                                g.position.addScaledVector(dir, speed * dt);
                                // If close enough, kill player
                                if (distToPlayer < 2.0 && !player.isDead) {
                                    try {
                                        player.fallApart();
                                        // Optional local chat/system message
                                        try { if (typeof window.addChatMessage === 'function') window.addChatMessage('System','You were caught by prison guards!'); } catch(e){}
                                    } catch(e){}
                                }
                                return; // skip patrol when chasing
                            }
                        }
                    } catch(e){}
                    // Default patrol if not chasing anyone
                    const pts = g.userData.patrol;
                    if (!pts || pts.length === 0) return;
                    const idx = g.userData.patrolIndex || 0;
                    const target = pts[idx];
                    const dir = target.clone().sub(pos);
                    const dist = dir.length();
                    if (dist < 0.5) {
                        g.userData.patrolIndex = (idx + 1) % pts.length;
                    } else {
                        dir.normalize();
                        g.position.addScaledVector(dir, (g.userData.speed || 6) * dt);
                    }
                });
            }
        });
    }

    setupBlocks() {
        // Central concrete slab
        this.createBlock(0, -0.5, 0, 160, 1, 160, 0x999999, ['static']);
        // Small raised plaza in center
        this.createBlock(0, 0.5, 0, 40, 1.5, 40, 0xCCCCCC, ['static']);
        // Spawn pad on plaza
        this.createBlock(0, 1.6, 0, 6, 0.6, 6, 0x888888, ['static', 'spawn']);

        // Surrounding grass ring
        this.createBlock(0, -1, 0, 400, 2, 400, 0x4aa04a, ['static']);

        // Forest ring: random trees around edges
        for (let i = 0; i < 80; i++) {
            const angle = (i / 80) * Math.PI * 2;
            const radius = 90 + (Math.random() * 30 - 10);
            const x = Math.cos(angle) * radius + (Math.random() - 0.5) * 8;
            const z = Math.sin(angle) * radius + (Math.random() - 0.5) * 8;
            // Trunk
            const trunk = this.createBlock(x, 4, z, 2, 8, 2, 0x6b4f3b, ['static']);
            trunk.name = 'TreeTrunk';
            // Leaves canopy - a box for simplicity
            const leaves = this.createBlock(x, 8.5, z, 8, 4, 8, 0x2b8a2b, ['static']);
            leaves.name = 'TreeLeaves';
        }

        // Mini Golf Course: a loop of 6 small holes using ramps, cups, and short walls
        const golfBaseX = -30;
        const golfBaseZ = -30;
        for (let h = 0; h < 6; h++) {
            const hx = golfBaseX + (h % 3) * 18;
            const hz = golfBaseZ + Math.floor(h / 3) * 24;
            // Tee pad
            this.createBlock(hx - 4, 1, hz, 6, 0.5, 6, 0x443322, ['static']);
            // Fairway
            this.createBlock(hx, 1.5, hz + 6, 12, 0.5, 20, 0xddddaa, ['static']);
            // Bumper walls
            this.createBlock(hx, 1.5, hz + 16, 12, 0.5, 1, 0x333333, ['static']);
            // Hole cup (small cylinder)
            const cup = this.createPart('cylinder', hx + 6, 1.1, hz + 24, { x: 1.5, y: 0.2, z: 1.5 }, 0x000000);
            cup.name = `Hole_${h+1}`;
            cup.userData = { isGolfHole: true, holeIndex: h+1 };
        }

        // Benches scattered around plaza and paths (they are interactable: isBench)
        const benchPositions = [
            [8, 1.2, 10], [-8, 1.2, 10],
            [10, 1.2, -8], [-10, 1.2, -8],
            [20, 1.2, 0], [-20, 1.2, 0]
        ];
        benchPositions.forEach((p, idx) => {
            // Bench base (thin block) - not collidable tall to avoid trapping
            const bx = p[0], by = p[1], bz = p[2];
            const bench = this.createBlock(bx, by, bz, 6, 0.6, 2, 0x6b4f3b, ['static']);
            bench.name = `Bench_${idx+1}`;
            bench.userData = bench.userData || {};
            bench.userData.isBench = true;
            // Add small backrest
            const back = this.createBlock(bx, by + 0.9, bz - 0.6, 6, 1.2, 0.4, 0x5a3f2a, ['static']);
            back.name = `BenchBack_${idx+1}`;
            back.userData = back.userData || {};
            back.userData.isBench = true;
        });

        // Park props: lamp posts, trash cans, small planters
        for (let i = 0; i < 8; i++) {
            const ax = (Math.random() - 0.5) * 80;
            const az = (Math.random() - 0.5) * 80;
            this.createBlock(ax, 3.5, az, 0.6, 6, 0.6, 0x222222, ['static']).name = 'LampPost';
            this.createPart('cylinder', ax + 2.5, 1.1, az - 2.5, { x: 1, y: 1, z: 1 }, 0x885522).name = 'Planter';
        }

        // Small decorative pond near one side
        const pond = this.createPart('sphere', 40, 0.5, -30, { x: 18, y: 0.6, z: 12 }, 0x2aa6d6);
        pond.name = 'Pond';
    }

    // Rocket Olympics: fast arena where NPCs fire rockets; survive to earn points
    setupRocketOlympics() {
        // Arena base
        this.createBlock(0, -1, 0, 120, 2, 120, 0x444444, ['static']);
        this.createBlock(0, 0.5, 0, 20, 1, 20, 0xaaaaaa, ['static', 'spawn']);

        // Surrounding walls (low) to keep rockets visible
        this.createBlock(0, 5, -62, 120, 10, 2, 0x222222, ['static']);
        this.createBlock(0, 5, 62, 120, 10, 2, 0x222222, ['static']);
        this.createBlock(-62, 5, 0, 2, 10, 120, 0x222222, ['static']);
        this.createBlock(62, 5, 0, 2, 10, 120, 0x222222, ['static']);

        // Spawn several visual NPC turrets that will "fire" rockets
        const npcPositions = [
            new THREE.Vector3(-30, 1.5, -30),
            new THREE.Vector3(30, 1.5, -30),
            new THREE.Vector3(-30, 1.5, 30),
            new THREE.Vector3(30, 1.5, 30),
            new THREE.Vector3(0, 1.5, -45),
            new THREE.Vector3(0, 1.5, 45)
        ];

        npcPositions.forEach((pos, i) => {
            const turret = this.createBlock(pos.x, pos.y, pos.z, 2, 2, 2, 0x333333, ['static']);
            turret.name = `RocketTurret_${i}`;
            this._rocketNPCs.push({ mesh: turret, cooldown: 0.8 + Math.random() * 1.8, timer: Math.random() * 2.0 });
        });

        // Helper: rockets are small cylinders; they'll be spawned into this._rockets array and updated in World.update
    }

    update(dt) {
        this.animated.forEach(anim => anim.update(dt, anim));
        this.vehicles.forEach(v => v.update(dt, this.collidables));

        // Update Rocket Olympics rockets and NPC timers
        if (this._rocketNPCs && this._rocketNPCs.length > 0) {
            // NPCs fire rockets periodically
            this._rocketNPCs.forEach(npc => {
                npc.timer += dt;
                if (npc.timer >= npc.cooldown) {
                    npc.timer = 0;
                    // Spawn rocket aimed roughly toward arena center with some spread
                    const origin = npc.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0));
                    const target = new THREE.Vector3(
                        (Math.random() - 0.5) * 8,
                        1 + Math.random() * 2,
                        (Math.random() - 0.5) * 8
                    );
                    const dir = target.clone().sub(origin).normalize();
                    const speed = 30 + Math.random() * 20;

                    const rocketGeo = new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8);
                    rocketGeo.rotateX(Math.PI / 2);
                    const rocketMat = new THREE.MeshStandardMaterial({ color: 0xff6622, emissive: 0x442200 });
                    const rocket = new THREE.Mesh(rocketGeo, rocketMat);
                    rocket.position.copy(origin);
                    rocket.userData = { velocity: dir.multiplyScalar(speed) };
                    rocket.name = 'Rocket';
                    this.mapGroup.add(rocket);
                    this._rockets.push(rocket);
                }
            });

            // Move rockets
            for (let i = this._rockets.length - 1; i >= 0; i--) {
                const r = this._rockets[i];
                const v = r.userData.velocity.clone().multiplyScalar(dt);
                r.position.add(v);
                // Life/time removal: if too far out of arena bounds remove
                if (Math.abs(r.position.x) > 400 || Math.abs(r.position.z) > 400 || r.position.y < -50) {
                    try { if (r.geometry) r.geometry.dispose(); if (Array.isArray(r.material)) r.material.forEach(m => m.dispose && m.dispose()); else if (r.material) r.material.dispose && r.material.dispose(); } catch(e){}
                    if (r.parent) r.parent.remove(r);
                    this._rockets.splice(i, 1);
                }
            }
        }
    }

    setupEaster2026() {
        // Ground
        this.createBlock(0, -1, 0, 200, 2, 200, 0x88cc88, ['static']);
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Friendly NPC (an "Easter Bunny" statue) the player can interact with
        const npcGeo = new THREE.CylinderGeometry(0.6, 0.6, 1.8, 12);
        const npcMat = new THREE.MeshStandardMaterial({ color: 0xff66cc, emissive: 0x442222 });
        const bunny = new THREE.Mesh(npcGeo, npcMat);
        bunny.position.set(10, 1, 0);
        bunny.name = 'EasterBunnyNPC';
        bunny.userData = { isNPC: true, npcId: 'easter_bunny_1', dialogState: 0, candyGiven: false, obbyStarted: false, obbyProgress: 0 };
        this.mapGroup.add(bunny);
        this.items.push(bunny);

        // Sign / NPC marker (small plane)
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0,0,128,32);
        ctx.fillStyle = 'black';
        ctx.font = 'bold 18px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Easter Bunny', 64, 20);
        const tex = new THREE.CanvasTexture(canvas);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
        sign.position.set(10, 2.5, 0);
        sign.lookAt(new THREE.Vector3(0,2.5,0));
        this.mapGroup.add(sign);

        // Create two progressive obby stages placed outwards
        // Stage 1: simple stepping stones
        const stage1Origin = new THREE.Vector3(30, 1, 0);
        for (let i=0;i<6;i++) {
            this.createBlock(stage1Origin.x + i*6, 1, stage1Origin.z + Math.sin(i)*2, 4, 1, 4, 0xddddff, ['static']);
        }
        // Stage 1 finish marker
        const finish1 = this.createBlock(stage1Origin.x + 6*6, 1, stage1Origin.z, 4, 1, 4, 0x00ff88, ['static']);
        finish1.name = 'EasterFinish1';
        finish1.userData.isFinish = 1;

        // Stage 2: small platforms with gaps and tiny jumps
        const stage2Origin = new THREE.Vector3(100, 1, 0);
        for (let j=0;j<8;j++) {
            const y = 1 + (j%2)*1.5;
            this.createBlock(stage2Origin.x + j*6, y, stage2Origin.z + ((j%3)-1)*2, 3.5, 1, 3.5, 0xffeebb, ['static']);
        }
        // Stage 2 finish marker
        const finish2 = this.createBlock(stage2Origin.x + 8*6, 1, stage2Origin.z, 5, 1, 5, 0x00ffaa, ['static']);
        finish2.name = 'EasterFinish2';
        finish2.userData.isFinish = 2;

        // Store NPC reference so gameplay code can find it
        this._easterNPC = bunny;
        this._easterFinish1 = finish1;
        this._easterFinish2 = finish2;
    }

    setupSpace() {
        // Baseplate
        this.createBlock(0, 0, 0, 80, 2, 80, 0x333333);

        // Launcher
        this.createBlock(0, 1.25, 0, 8, 0.5, 8, 0xff00ff, ['static', 'launch']);

        // High Platform
        this.createBlock(0, 400, 0, 40, 1, 40, 0xffffff);
        this.createBlock(0, 405, 0, 4, 8, 4, 0xffff00);
    }

    update(dt) {
        this.animated.forEach(anim => anim.update(dt, anim));
        this.vehicles.forEach(v => v.update(dt, this.collidables));
    }
}