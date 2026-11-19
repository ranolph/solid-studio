# Third-party notices

Solid Studio's original source is distributed under the MIT licence in [LICENSE](LICENSE). Third-party runtime assets retain their own licences and copyright notices.

| Component | Pinned version | Licence | Included files |
| --- | --- | --- | --- |
| [Three.js](https://github.com/mrdoob/three.js) | `0.187.0` | MIT | `static/vendor/three.module.js`, `three.core.js`, `OrbitControls.js`, `TransformControls.js` |
| [Manifold](https://github.com/elalish/manifold) / [`manifold-3d`](https://www.npmjs.com/package/manifold-3d) | `3.5.5` | Apache License 2.0 | `static/vendor/manifold.js`, `manifold.wasm` |

Full upstream licence texts are included at:

- [licenses/THREE-LICENSE.txt](licenses/THREE-LICENSE.txt)
- [licenses/MANIFOLD-LICENSE.txt](licenses/MANIFOLD-LICENSE.txt)

Three.js copyright: **2010–2026 three.js authors**, as recorded in its supplied licence. The two controls modules have one packaging adjustment: the bare `three` module import is rewritten to the adjacent `./three.module.js`. No other upstream source changes are made by the vendoring script. Manifold's JavaScript and WebAssembly files are copied unchanged from the pinned npm package.

`tools/vendor.mjs` reproduces these copies after `npm ci` using the checked-in lockfile. The complete Node development dependency tree is not bundled into the runtime ZIP; only the above assets are required by the running app. `static/vendor/VERSIONS.json` records their versions.

The optional container image uses the official Python 3.12 slim base image, obtained separately when building. Python and operating-system components retain their upstream licences in that image; the base image is not embedded in the source ZIP or standalone TrueNAS installer.

The interface's icons, CSS shape illustrations and procedural starting designs are part of Solid Studio's source. The package contains no personal model collection, remote fonts or third-party imagery.
