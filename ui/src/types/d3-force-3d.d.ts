// d3-force-3d has no published type definitions of its own. Its README
// confirms it's "fully backwards compatible with d3-force... and should
// just work as a drop-in replacement d3 module" (same exports) — so
// @types/d3-force's types are an accurate stand-in for the parts of the API
// this app actually uses. Two functions have a real signature difference in
// the 3D build (an extra numDimensions arg on forceSimulation, an extra z
// on forceCenter) and are overridden below instead of re-exported as-is.
// 3D-specific runtime fields (z/vz on simulation nodes) aren't in
// @types/d3-force's SimulationNodeDatum; components using those extend the
// node type locally rather than patching this declaration further.
declare module 'd3-force-3d' {
  export * from 'd3-force';

  import type { Simulation, SimulationNodeDatum, SimulationLinkDatum, ForceCenter } from 'd3-force';

  export function forceSimulation<NodeDatum extends SimulationNodeDatum, LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>>(
    nodes?: NodeDatum[],
    numDimensions?: number
  ): Simulation<NodeDatum, LinkDatum>;

  export function forceCenter<NodeDatum extends SimulationNodeDatum>(x?: number, y?: number, z?: number): ForceCenter<NodeDatum>;
}
