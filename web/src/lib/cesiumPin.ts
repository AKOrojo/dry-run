// The Cesium version whose internals the viewer-leak workarounds in Globe.tsx were checked against (the request heap's
// slots, the scene's frameState and context). cesium-pin.test.ts fails on any other installed version, so an upgrade
// re-checks them.
export const CESIUM_CHECKED = "1.146.0";
