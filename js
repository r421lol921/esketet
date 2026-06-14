<<<<<<< SEARCH
export function createPlayerMesh(materialsStore) {
    const group = new THREE.Group();
=======
export function createPlayerMesh(materialsStore) {
    const group = new THREE.Group();
>>>>>>> REPLACE

<<<<<<< SEARCH
    const head = new THREE.Mesh(headGeo, createPartMats('head', 0xffffff, headFrontMat));
    head.position.set(0, 4.5, 0); 
    group.add(head);
=======
    const head = new THREE.Mesh(headGeo, createPartMats('head', 0xffffff, headFrontMat));
    head.position.set(0, 4.5, 0); 
    group.add(head);

    // Register this group/head so the GLB can replace the cube head when ready
    _glbHeadInstances.push({ group, head });
    if (_glbHeadLoaded) {
        attachGlbHeadToGroup(group, head);
    } else {
        // Ensure load has been kicked off
        ensureGlbHeadLoaded();
    }
>>>>>>> REPLACE

