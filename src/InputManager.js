

export class InputManager {
    constructor() {
        this.keys = {
            w: false, a: false, s: false, d: false, space: false, 
            e: false, q: false, shift: false,
            arrowup: false, arrowdown: false, arrowleft: false, arrowright: false
        };
        
        this.lookDelta = { x: 0, y: 0 };
        this.joystickVector = { x: 0, y: 0 };
        
        this.isLocked = false;
        this.isShiftLocked = false;
        this.isRightMouseDown = false;
        
        this.initKeyboard();
        this.initMouse();
        this.initTouch();
    }

    initMouse() {
        document.addEventListener('contextmenu', e => e.preventDefault());

        document.addEventListener('mousedown', (e) => {
            if (e.button === 2) this.isRightMouseDown = true;
        });

        document.addEventListener('mousemove', (e) => {
            if (this.isLocked || this.isRightMouseDown) {
                this.lookDelta.x += e.movementX;
                this.lookDelta.y += e.movementY;
            }
        });

        document.addEventListener('mouseup', (e) => {
            if (e.button === 2) this.isRightMouseDown = false;
        });
        document.addEventListener('pointerlockchange', () => {
            this.isLocked = !!document.pointerLockElement;
        });
    }

    initTouch() {
        let lastTouchX = null;
        let lastTouchY = null;

        document.addEventListener('touchstart', (e) => {
            for(let i=0; i<e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                // Only track touches on the right half of the screen for looking
                if (t.clientX > window.innerWidth / 2) {
                    lastTouchX = t.clientX;
                    lastTouchY = t.clientY;
                }
            }
        }, {passive: false});

        document.addEventListener('touchmove', (e) => {
            for(let i=0; i<e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                if (lastTouchX !== null) {
                    // Check if this touch is the tracking one is hard without ID, 
                    // but simple heuristic: right side
                    if (t.clientX > window.innerWidth / 3) { // wider area for dragging
                        const dx = t.clientX - lastTouchX;
                        const dy = t.clientY - lastTouchY;
                        
                        // Apply sensitivity factor
                        this.lookDelta.x += dx * 2.0; 
                        this.lookDelta.y += dy * 2.0;

                        lastTouchX = t.clientX;
                        lastTouchY = t.clientY;
                    }
                }
            }
        }, {passive: false});

        document.addEventListener('touchend', (e) => {
             lastTouchX = null;
             lastTouchY = null;
        });
    }

    getLookDelta() {
        const d = { x: this.lookDelta.x, y: this.lookDelta.y };
        this.lookDelta.x = 0;
        this.lookDelta.y = 0;
        return d;
    }

    initKeyboard() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (!e.key) return;

            const k = e.key.toLowerCase();
            if (k === 'shift' && !e.repeat) {
                this.keys.shift = true;
                this.isShiftLocked = !this.isShiftLocked;
                if (this.isShiftLocked) {
                    document.body.requestPointerLock();
                } else {
                    document.exitPointerLock();
                }
            }

            // Map some common keys to internal state
            if (k === ' ') {
                this.keys.space = true;
            } else if (this.keys.hasOwnProperty(k)) {
                this.keys[k] = true;
            }
        });
        window.addEventListener('keyup', (e) => {
            if (!e.key) return;
            const k = e.key.toLowerCase();
            if (k === 'shift') this.keys.shift = false;
            
            if (k === ' ') {
                this.keys.space = false;
            } else if (this.keys.hasOwnProperty(k)) {
                this.keys[k] = false;
            }
        });
    }

    getMovement() {
        // Combine Keyboard and Joystick
        let dx = 0;
        let dz = 0;

        if (this.keys.w || this.keys.arrowup) dz -= 1;
        if (this.keys.s || this.keys.arrowdown) dz += 1;
        if (this.keys.a || this.keys.arrowleft) dx -= 1;
        if (this.keys.d || this.keys.arrowright) dx += 1;

        // Add joystick input
        dx += this.joystickVector.x;
        dz += this.joystickVector.y;

        // Clamp length to 1
        const len = Math.sqrt(dx*dx + dz*dz);
        if (len > 1) {
            dx /= len;
            dz /= len;
        }

        return { x: dx, z: dz, jump: this.keys.space };
    }
}