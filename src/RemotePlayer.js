import * as THREE from 'three';
import { createPlayerMesh } from './Player.js';

/*
  TOMBSTONE / REFACTOR NOTE

  RemotePlayer contains a lot of animation, debris physics, chat bubble rendering, and audio code.
  For clarity, consider splitting responsibilities into:
    - src/remote/appearance.js (applyAppearance, setPartColor)
    - src/remote/anim.js (walk/fall/dance animations)
    - src/remote/debris.js (debris physics and collision)
    - src/remote/chat.js (bubble creation/cleanup)

  The file still functions as before; these comments mark where code can be migrated.
  // removed large inline helper blocks for modularization
*/

export class RemotePlayer {
    constructor(scene, initialData = {}) {
        this.scene = scene;
        this.materials = {};
        this.mesh = createPlayerMesh(this.materials);
        this.scene.add(this.mesh);

        this.name = initialData.username || "Player";
        this.clientId = initialData.clientId;

        // Parts
        this.torso = this.mesh.children[0]; // Add torso reference
        this.head = this.mesh.children[1];
        this.leftArm = this.mesh.children[2];
        this.rightArm = this.mesh.children[3];
        this.leftLeg = this.mesh.children[4];
        this.rightLeg = this.mesh.children[5];

        this.addNameTag();

        // State for interpolation
        this.targetPos = new THREE.Vector3();
        this.targetRot = 0;
        this.animState = 'idle';
        this.animTime = 0;
        
        // Walk jitter seed so remote players animate with minor unique jitter
        this._walkSeed = Math.random() * 10;
        
        // Dead/Debris State
        this.isDead = false;
        this.debris = [];
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.breakBuffer = null;
        this.loadSound('/roblox-death-sound_1.mp3').then(buf => this.breakBuffer = buf);
        
        // Initialize position
        if (initialData.presence && initialData.presence.position) {
            this.mesh.position.copy(initialData.presence.position);
            this.targetPos.copy(initialData.presence.position);
        }

        // Apply initial appearance if available
        if (initialData.presence && initialData.presence.appearance) {
            this.applyAppearance(initialData.presence.appearance);
        }
        
        // Check initial death state
        if (initialData.presence && initialData.presence.isDead) {
            this.isDead = true;
            this.mesh.visible = false;
            this.setBodyVisible(false);
            if (this.nameTag) this.nameTag.visible = false;
        }

        this.currentBubble = null;
        this.bubbleTimer = null;

        // Dance GIF
        this.danceGif = null;
    }

    async loadSound(url) {
        try {
            const res = await fetch(url);
            const arr = await res.arrayBuffer();
            return await this.audioCtx.decodeAudioData(arr);
        } catch(e) { console.error(e); }
    }

    playSound(buffer) {
        if (!buffer || this.audioCtx.state === 'suspended') return;
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioCtx.destination);
        source.start(0);
    }

    updateData(presence) {
        if (!presence) return;
        
        if (presence.position) {
            this.targetPos.copy(presence.position);
        }
        if (presence.rotation !== undefined) {
            this.targetRot = presence.rotation;
        }
        // Always update animState, default to idle if missing
        this.animState = presence.animState || 'idle';
        
        // Handle Death State Transition
        if (presence.isDead !== undefined) {
            if (presence.isDead && !this.isDead) {
                this.fallApart();
            } else if (!presence.isDead && this.isDead) {
                this.respawn();
            }
            this.isDead = presence.isDead;
        }

        if (presence.appearance) {
            this.applyAppearance(presence.appearance);
        }
    }

    fallApart() {
        if (this.isDead) return;
        this.isDead = true;
        this.mesh.visible = false;
        this.setBodyVisible(false);
        if (this.nameTag) this.nameTag.visible = false;
        
        this.removeDanceElement();
        this.playSound(this.breakBuffer);

        // Spawn debris parts (Mirroring Player.js logic)
        const parts = [this.head, this.torso, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg];
        
        parts.forEach(part => {
            if (!part) return;
            // Handle Groups for limbs
            let sourceMesh = part;
            if (part.type === 'Group' && part.children.length > 0) sourceMesh = part.children[0];

            // SAFETY: ensure we have geometry to clone; skip if not present
            if (!sourceMesh || !sourceMesh.geometry) return;

            const worldPos = new THREE.Vector3();
            sourceMesh.getWorldPosition(worldPos);
            const worldQuat = new THREE.Quaternion();
            sourceMesh.getWorldQuaternion(worldQuat);

            // Clone geometry and material safely
            const geomClone = sourceMesh.geometry.clone();
            let matClone;
            if (Array.isArray(sourceMesh.material)) {
                matClone = sourceMesh.material.map(m => m.clone());
            } else if (sourceMesh.material && typeof sourceMesh.material.clone === 'function') {
                matClone = sourceMesh.material.clone();
            } else {
                // Fallback simple material
                matClone = new THREE.MeshStandardMaterial({ color: 0xffffff });
            }

            const debrisMesh = new THREE.Mesh(geomClone, matClone);
            debrisMesh.position.copy(worldPos);
            debrisMesh.quaternion.copy(worldQuat);
            
            this.scene.add(debrisMesh);

            // Explode outwards
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 20,
                Math.random() * 15, 
                (Math.random() - 0.5) * 20
            );

            const angVel = new THREE.Vector3(
                Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
            ).multiplyScalar(10);

            this.debris.push({ mesh: debrisMesh, velocity: vel, angularVelocity: angVel });
        });
    }

    respawn() {
        this.isDead = false;
        this.mesh.visible = true;
        this.setBodyVisible(true);
        if (this.nameTag) this.nameTag.visible = true;
        
        // Cleanup debris
        this.debris.forEach(d => {
            this.scene.remove(d.mesh);
            d.mesh.geometry.dispose();
        });
        this.debris = [];
        this.removeDanceElement();
        
        // Snap to target to prevent lerping from death spot
        this.mesh.position.copy(this.targetPos);
    }

    applyAppearance(app) {
        if (app.colors) {
            for (const [part, col] of Object.entries(app.colors)) {
                this.setPartColor(part, col);
            }
        }
        // Handle textures if implemented (data URLs might be heavy)
    }

    setBodyVisible(visible) {
        Object.values(this.materials).forEach(mats => {
            if (Array.isArray(mats)) {
                mats.forEach(m => m.visible = visible);
            } else {
                mats.visible = visible;
            }
        });
    }

    // Helper: attach to visible head (works if GLB replaced the cube head)
    getHeadAttachment() {
        let attach = this.head || null;
        if (!attach || attach.visible === false) {
            for (const c of (this.mesh ? this.mesh.children : [])) {
                if (c === this.head) continue;
                if (c && c.isObject3D) {
                    attach = c;
                    break;
                }
            }
        }
        return attach || this.head || this.mesh;
    }

    setPartColor(part, colorHex) {
        if (!this.materials[part]) return;
        const col = new THREE.Color(colorHex);

        // Apply tint uniformly across all material slots for this part (including textured fronts)
        this.materials[part].forEach((mat) => {
            try {
                if (mat && mat.color) {
                    mat.color.copy(col);
                    mat.needsUpdate = true;
                }
            } catch (e) {
                // ignore non-colorable materials
            }
        });
    }

    addNameTag() {
        if (this.nameTag) this.head.remove(this.nameTag);

        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        
        // Helper for rounded rectangle drawing (avoid depending on canvas prototype polyfill timing)
        const _roundRect = (ctx, x, y, w, h, r) => {
            if (typeof r === 'number') r = { tl: r, tr: r, br: r, bl: r };
            ctx.beginPath();
            ctx.moveTo(x + r.tl, y);
            ctx.lineTo(x + w - r.tr, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
            ctx.lineTo(x + w, y + h - r.br);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
            ctx.lineTo(x + r.bl, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
            ctx.lineTo(x, y + r.tl);
            ctx.quadraticCurveTo(x, y, x + r.tl, y);
            ctx.closePath();
        };

        // Shadow/Background for readability
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        _roundRect(ctx, 28, 10, 200, 44, 10);
        ctx.fill();

        ctx.font = 'bold 32px "Comic Sans MS", cursive, sans-serif';
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = "black";
        ctx.shadowBlur = 4;
        ctx.fillText(this.name, 128, 32);

        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
        sprite.renderOrder = 999;
        sprite.scale.set(4, 1, 1);
        sprite.position.y = 1.8;
        this.nameTag = sprite;
        this.head.add(sprite);
    }

    update(dt, camera, world) {
        if (this.isDead) {
            // Debris Physics
            const gravity = -100;
            const collidables = world && world.collidables ? world.collidables : [];

            for (const d of this.debris) {
                d.velocity.y += gravity * dt;
                d.mesh.position.addScaledVector(d.velocity, dt);
                
                // Rotation
                const rotMag = d.angularVelocity.length();
                if (rotMag > 0.0001) {
                    const axis = d.angularVelocity.clone().normalize();
                    const angle = rotMag * dt;
                    const deltaRot = new THREE.Quaternion().setFromAxisAngle(axis, angle);
                    d.mesh.quaternion.premultiply(deltaRot);
                }
                d.angularVelocity.multiplyScalar(0.98);
                d.velocity.multiplyScalar(0.995);

                // Stop if slow/low
                if (d.velocity.lengthSq() < 0.5 && d.angularVelocity.lengthSq() < 0.5 && d.mesh.position.y < 5) {
                    d.velocity.set(0,0,0);
                    d.angularVelocity.set(0,0,0);
                }

                // Simple collision check against world
                const dBox = new THREE.Box3().setFromObject(d.mesh);
                for (const col of collidables) {
                    // Optimization: Distance check
                    if (Math.abs(col.position.x - d.mesh.position.x) > 20 || Math.abs(col.position.z - d.mesh.position.z) > 20) continue;

                    const cBox = new THREE.Box3().setFromObject(col);
                    if (dBox.intersectsBox(cBox)) {
                        const inter = dBox.clone().intersect(cBox);
                        const w = inter.max.x - inter.min.x;
                        const h = inter.max.y - inter.min.y;
                        const dep = inter.max.z - inter.min.z;
                        
                        // Bounce
                        if (w < h && w < dep) {
                            const sign = d.mesh.position.x > col.position.x ? 1 : -1;
                            d.mesh.position.x += sign * w;
                            d.velocity.x *= -0.5;
                        } else if (h < w && h < dep) {
                            const sign = d.mesh.position.y > col.position.y ? 1 : -1;
                            if (d.mesh.position.x >= cBox.min.x && d.mesh.position.x <= cBox.max.x &&
                                d.mesh.position.z >= cBox.min.z && d.mesh.position.z <= cBox.max.z) {
                                d.mesh.position.y += sign * h;
                                d.velocity.y *= -0.5;
                                d.velocity.x *= 0.8;
                                d.velocity.z *= 0.8;
                            }
                        } else {
                            const sign = d.mesh.position.z > col.position.z ? 1 : -1;
                            d.mesh.position.z += sign * dep;
                            d.velocity.z *= -0.5;
                        }
                    }
                }
                if (d.mesh.position.y < -50) d.mesh.position.y = -50; // Cap fall
            }
            return;
        }

        // Interpolate Position
        const lerpFactor = 10 * dt;
        this.mesh.position.lerp(this.targetPos, lerpFactor);
        
        // Interpolate Rotation (Y only)
        let diff = this.targetRot - this.mesh.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.mesh.rotation.y += diff * lerpFactor;

        // Handle Dance State visibility
        if (this.animState === 'dance') {
            // Keep container visible for name/chat, hide body parts
            this.mesh.visible = true;
            this.setBodyVisible(false);
            if (camera) this.updateDanceElement(camera);
            
            // Bob head for name tag sync
            const t = Date.now() / 1000;
            this.head.position.y = 4.5 + Math.abs(Math.sin(t * 12)) * 0.3;
            this.head.position.x = Math.sin(t * 6) * 0.5;
            this.head.rotation.z = Math.sin(t * 4) * 0.1;
        } else {
            this.mesh.visible = true;
            this.setBodyVisible(true);
            this.removeDanceElement();
            
            // Reset head
            this.head.position.set(0, 4.5, 0);
            this.head.rotation.z = 0;
        }

        // Animation Sync (smooth interpolation)
        if (this.animState === 'walk') {
            // Make remote walk slightly janky to match local player's new style
            const walkSpeed = 10.0;
            const amp = 1.4;
            // tiny seeded wobble
            this.animTime += dt + (Math.sin(this._walkSeed + Date.now() * 0.001) * 0.005);
            const base = Math.sin(this.animTime * walkSpeed);
            const smoothFactor = Math.min(1, dt * 6.0);

            let tLeftArm = base * amp;
            let tRightArm = -base * amp;
            let tLeftLeg = -base * amp;
            let tRightLeg = base * amp;

            // Add subtle jitter
            const jitter = (1 - smoothFactor) * 0.45;
            tLeftArm += (Math.random() - 0.5) * jitter;
            tRightArm += (Math.random() - 0.5) * jitter;
            tLeftLeg += (Math.random() - 0.5) * jitter;
            tRightLeg += (Math.random() - 0.5) * jitter;

            this.leftArm.rotation.x += (tLeftArm - this.leftArm.rotation.x) * smoothFactor;
            this.rightArm.rotation.x += (tRightArm - this.rightArm.rotation.x) * smoothFactor;
            this.leftLeg.rotation.x += (tLeftLeg - this.leftLeg.rotation.x) * smoothFactor;
            this.rightLeg.rotation.x += (tRightLeg - this.rightLeg.rotation.x) * smoothFactor;
        } else if (this.animState === 'fall') {
            // Instant pose for fall, but keep smooth transitions when entering/exiting
            const smoothFactor = Math.min(1, dt * 10);
            this.leftArm.rotation.x += (Math.PI - this.leftArm.rotation.x) * smoothFactor;
            this.rightArm.rotation.x += (Math.PI - this.rightArm.rotation.x) * smoothFactor;
            this.leftLeg.rotation.x += (0 - this.leftLeg.rotation.x) * smoothFactor;
            this.rightLeg.rotation.x += (0 - this.rightLeg.rotation.x) * smoothFactor;
        } else if (this.animState === 'dance') {
            // Dance handled elsewhere; leave body hidden/managed
        } else {
            // Idle: smoothly return to neutral
            const smoothFactor = Math.min(1, dt * 8);
            this.leftArm.rotation.x += (0 - this.leftArm.rotation.x) * smoothFactor;
            this.rightArm.rotation.x += (0 - this.rightArm.rotation.x) * smoothFactor;
            this.leftLeg.rotation.x += (0 - this.leftLeg.rotation.x) * smoothFactor;
            this.rightLeg.rotation.x += (0 - this.rightLeg.rotation.x) * smoothFactor;
            this.animTime = 0;
        }
    }

    chat(message) {
        if (!message) return;
        if (this.currentBubble) {
            this.head.remove(this.currentBubble);
            this.currentBubble.material.map.dispose();
            this.currentBubble.material.dispose();
            this.currentBubble = null;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 24;
        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", cursive`;
        const textMetrics = ctx.measureText(message);
        
        const p = 15; 
        const w = Math.max(64, textMetrics.width + p * 2);
        const h = fontSize + p * 2 + 15;
        
        canvas.width = w;
        canvas.height = h;

        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", cursive`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        const r = 10;
        const bh = h - 15;
        
        ctx.fillStyle = 'white';
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 4;

        // Draw rounded bubble background (avoid reliance on CanvasPrototype.roundRect)
        const _roundRect = (ctx, x, y, w, h, r) => {
            if (typeof r === 'number') r = { tl: r, tr: r, br: r, bl: r };
            ctx.beginPath();
            ctx.moveTo(x + r.tl, y);
            ctx.lineTo(x + w - r.tr, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
            ctx.lineTo(x + w, y + h - r.br);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
            ctx.lineTo(x + r.bl, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
            ctx.lineTo(x, y + r.tl);
            ctx.quadraticCurveTo(x, y, x + r.tl, y);
            ctx.closePath();
        };

        _roundRect(ctx, 2, 2, w - 4, bh - 4, r);
        ctx.fill();
        ctx.stroke();

        // Tail (triangle)
        ctx.beginPath();
        ctx.moveTo(w/2 - 8, bh - 2);
        ctx.lineTo(w/2, h - 2);
        ctx.lineTo(w/2 + 8, bh - 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.fillText(message, w/2, bh/2 + 2);

        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
        sprite.renderOrder = 1000;
        sprite.scale.set(w * 0.025, h * 0.025, 1);
        sprite.position.set(0, 3.5, 0);
        // Attach bubble to the currently visible head (GLB clone if present) so it shows above visible head.
        try {
            const attach = (typeof this.getHeadAttachment === 'function') ? this.getHeadAttachment() : this.head;
            (attach || this.head).add(sprite);
        } catch (e) {
            try { this.head.add(sprite); } catch (ee) {}
        }
        this.currentBubble = sprite;

        if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
        this.bubbleTimer = setTimeout(() => {
            if (this.currentBubble === sprite) {
                this.head.remove(sprite);
                this.currentBubble.material.map.dispose();
                this.currentBubble.material.dispose();
                this.currentBubble = null;
            }
        }, 6000);
    }
    
    updateDanceElement(camera) {
        if (!this.danceGif) {
            this.danceGif = document.createElement('img');
            this.danceGif.src = '/spongedance-4.gif';
            this.danceGif.style.position = 'absolute';
            this.danceGif.style.transform = 'translate(-50%, -50%)'; 
            this.danceGif.style.pointerEvents = 'none';
            this.danceGif.style.zIndex = '15';
            document.body.appendChild(this.danceGif);
        }

        const pos = this.mesh.position.clone().add(new THREE.Vector3(0, 2.5, 0));
        pos.project(camera);

        const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-(pos.y * 0.5) + 0.5) * window.innerHeight;

        this.danceGif.style.left = x + 'px';
        this.danceGif.style.top = y + 'px';

        const dist = camera.position.distanceTo(this.mesh.position);
        const scale = 3000 / Math.max(1, dist);
        this.danceGif.style.height = Math.max(10, scale) + 'px';
        this.danceGif.style.width = 'auto';

        if (pos.z > 1 || Math.abs(pos.x) > 1.5 || Math.abs(pos.y) > 1.5) {
            this.danceGif.style.display = 'none';
        } else {
            this.danceGif.style.display = 'block';
        }
    }

    removeDanceElement() {
        if (this.danceGif) {
            this.danceGif.remove();
            this.danceGif = null;
        }
    }

    dispose() {
        this.removeDanceElement();
        this.scene.remove(this.mesh);
    }
}