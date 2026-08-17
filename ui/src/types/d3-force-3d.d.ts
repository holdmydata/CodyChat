// d3-force-3d has no published type definitions of its own. Its README
// confirms it's "fully backwards compatible with d3-force... and should
// just work as a drop-in replacement d3 module" (same exports, plus a
// numDimensions argument on forceSimulation) — so @types/d3-force's types
// are an accurate stand-in for the parts of the API this app actually uses.
// 3D-specific runtime fields (z/vz on simulation nodes) aren't in
// @types/d3-force's SimulationNodeDatum; components using those extend the
// node type locally rather than patching this declaration further.
declare module 'd3-force-3d' {
  export * from 'd3-force';
}
