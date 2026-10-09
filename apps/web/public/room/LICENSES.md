# The room's kit

`kit.glb` holds the CC0 meshes the room uses in place of primitives (`src/room/scene/kit.tsx`).

| Node | Source | Licence |
|---|---|---|
| `chair_A_wood` | KayKit Furniture Bits 1.0 by Kay Lousberg (www.kaylousberg.com), `addons/kaykit_furniture_bits/Assets/gltf/chair_A_wood.gltf` in https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0 | Creative Commons Zero (CC0 1.0), http://creativecommons.org/publicdomain/zero/1.0/ |

Built 2026-10-09: the glTF read with glTF Transform 4.5.1, its texture and UVs removed (the room colours each piece itself), written as GLB, then `gltfpack 1.3.0 -cc -kn -noq` (meshopt compression, node names kept, no quantization so the node is the mesh). Tried and left out: KayKit's `armchair` (in one flat colour it read as a beanbag; the primitive one stays). The Kenney Furniture Kit (CC0, kenney.nl) was looked at and not used.
