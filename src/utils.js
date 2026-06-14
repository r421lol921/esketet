import * as THREE from 'three';

// Adjust UVs of a BoxGeometry to match world dimensions relative to a texture map
// Default scales assume a 2x4 unit texture block (e.g. from SurfaceManager)
export function boxUnwrapUVs(geometry, scaleU = 0.5, scaleV = 0.25) {
    if (geometry.attributes.position.count !== 24) return;

    const w = geometry.parameters.width;
    const h = geometry.parameters.height;
    const d = geometry.parameters.depth;
    const uv = geometry.attributes.uv;
    
    const updateFace = (faceIndex, dimU, dimV) => {
        const start = faceIndex * 4;
        for (let i = 0; i < 4; i++) {
            const u = uv.getX(start + i);
            const v = uv.getY(start + i);
            uv.setXY(start + i, u * dimU * scaleU, v * dimV * scaleV);
        }
    };

    // BoxGeometry face order: px, nx, py, ny, pz, nz
    updateFace(0, d, h); // px (Right) - Depth x Height
    updateFace(1, d, h); // nx (Left)
    updateFace(2, w, d); // py (Top) - Width x Depth
    updateFace(3, w, d); // ny (Bottom)
    updateFace(4, w, h); // pz (Front) - Width x Height
    updateFace(5, w, h); // nz (Back)

    uv.needsUpdate = true;
}

export function createFaceTexture() {
    // Create transparent canvas (no opaque background)
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Ensure transparent background by clearing (canvas default is transparent,
    // but explicit clear helps with some renderers)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Eyes (draw on transparent background)
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.ellipse(80, 85, 12, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.beginPath();
    ctx.ellipse(176, 85, 12, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mouth (Smile)
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'black';
    ctx.beginPath();
    ctx.arc(128, 130, 55, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    // Ensure RGBA to preserve transparency
    tex.format = THREE.RGBAFormat;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

export function createTorsoTexture(colorHex = '#800080') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Background (use provided torso color)
    ctx.fillStyle = colorHex || '#800080';
    ctx.fillRect(0, 0, 256, 256);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Fix for new UV scale (V goes 0..0.5 for 2 units height, we need 0..1 to show full image)
    tex.repeat.set(1, 2);
    return tex;
}

export class SurfaceManager {
    constructor() {
        this.textures = {
            studs: new THREE.Texture(),
            inlet: new THREE.Texture()
        };
        
        const loader = new THREE.ImageLoader();
        loader.load('/Surfaces.png', (image) => {
            // Image is 2 units wide, 16 units high.
            const unitH = image.height / 16;
            const w = image.width;
            
            // Studs: Units 1-4 (Top 4)
            this._extract(this.textures.studs, image, 0, 0, w, unitH * 4);
            
            // Inlets: Units 5-8 (Next 4)
            this._extract(this.textures.inlet, image, 0, unitH * 4, w, unitH * 4);
        });
    }

    _extract(target, image, x, y, w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
        
        target.image = canvas;
        target.wrapS = THREE.RepeatWrapping;
        target.wrapT = THREE.RepeatWrapping;
        target.minFilter = THREE.LinearFilter;
        target.magFilter = THREE.NearestFilter;
        target.colorSpace = THREE.SRGBColorSpace;
        target.needsUpdate = true;
    }
}

export const surfaceManager = new SurfaceManager();

