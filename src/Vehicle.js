import * as THREE from 'three';
import { boxUnwrapUVs, surfaceManager } from './utils.js';

export class Vehicle {
    constructor(scene, x, y, z, color = 0xff0000) {
        this.scene = scene;
        this.mesh = new THREE.Group();
        this.mesh.position.set(x, y, z);
        this.mesh.userData = { type: 'vehicle', parent: this };

        // Car Body
        const bodyGeo = new THREE.BoxGeometry(4.5, 2, 8);
        boxUnwrapUVs(bodyGeo);
        const bodyMat = new THREE.MeshStandardMaterial({ 
            map: surfaceManager.textures.studs, 
            color: color,
            roughness: 0.2
        });
        this.body = new THREE.Mesh(bodyGeo, bodyMat);
        this.body.position.y = 1.25;
        this.body.castShadow = true;
        this.mesh.add(this.body);

        // Windshield
        const glassGeo = new THREE.BoxGeometry(4, 1.5, 3);
        const glassMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.6 });
        this.glass = new THREE.Mesh(glassGeo, glassMat);
        this.glass.position.set(0, 2.5, 0.5);
        this.mesh.add(this.glass);

        // Wheels
        const wGeo = new THREE.CylinderGeometry(1, 1, 1, 16);
        wGeo.rotateZ(Math.PI / 2);
        const wMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

        const wheels = [
            [-2.25, 1, -2.5], [2.25, 1, -2.5],
            [-2.25, 1, 2.5], [2.25, 1, 2.5]
        ];
        
        this.wheels = [];
        wheels.forEach(pos => {
            const w = new THREE.Mesh(wGeo, wMat);
            w.position.set(...pos);
            this.mesh.add(w);
            this.wheels.push(w);
        });

        // Physics State
        this.velocity = 0;
        this.steering = 0;
        this.verticalVel = 0;
        this.driver = null;
        
        // Raycaster for ground
        this.raycaster = new THREE.Raycaster();
        this.down = new THREE.Vector3(0, -1, 0);

        this.scene.add(this.mesh);
    }

    update(dt, collidables) {
        // Apply Drag
        this.velocity *= 0.98;
        this.steering *= 0.9;

        // Gravity
        this.verticalVel -= 50 * dt;

        // Movement
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);
        this.mesh.position.addScaledVector(fwd, this.velocity * dt);
        this.mesh.position.y += this.verticalVel * dt;

        // Rotation (Only when moving)
        if (Math.abs(this.velocity) > 1) {
            const turnAmt = this.steering * dt * (this.velocity > 0 ? 1 : -1);
            this.mesh.rotateY(turnAmt);
        }

        // Wheel Animation
        this.wheels.forEach(w => {
            w.rotateX(-this.velocity * dt * 0.5);
        });

        // Ground Collision
        this.raycaster.set(new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 2, this.mesh.position.z), this.down);
        const hits = this.raycaster.intersectObjects(collidables);
        
        if (hits.length > 0) {
            const dist = hits[0].distance;
            // 2 unit offset for ray origin
            const groundH = this.mesh.position.y + 2 - dist;
            
            if (groundH >= this.mesh.position.y - 0.2) {
                this.mesh.position.y = groundH;
                this.verticalVel = 0;
                // Add slope handling for ramp?
                // Simple tilt based on normal
                // const normal = hits[0].face.normal;
                // const targetQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), normal);
                // this.mesh.quaternion.slerp(targetQ, dt * 5); 
            }
        }

        if (this.mesh.position.y < -100) {
            this.mesh.position.set(1000, 5, 0);
            this.velocity = 0;
            this.verticalVel = 0;
        }
    }

    drive(input, dt) {
        const accel = 40;
        const maxSpeed = 60;
        
        if (input.w) this.velocity += accel * dt;
        if (input.s) this.velocity -= accel * dt;
        
        this.velocity = Math.max(-maxSpeed/2, Math.min(maxSpeed, this.velocity));

        if (input.a) this.steering = 2;
        else if (input.d) this.steering = -2;
        else this.steering = 0;
    }
}