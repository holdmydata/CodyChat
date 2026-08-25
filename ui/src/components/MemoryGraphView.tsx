import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import * as THREE from 'three';
import { Search, SlidersHorizontal, Sparkles, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  deleteMemoryItem,
  getMemoryGraph,
  getMemoryItem,
  type MemoryGraph,
  type MemoryGraphNode,
  type MemoryItemDetail,
} from '../lib/memoryGraph';
import { readCssColor, useThemeVersion } from '../lib/threeTheme';

// d3-force-3d adds z/vz at runtime when forceSimulation is given
// numDimensions=3 — not part of @types/d3-force's SimulationNodeDatum (see
// types/d3-force-3d.d.ts), so extended locally rather than patching that
// ambient declaration further.
interface SimNode extends SimulationNodeDatum {
  id: number;
  z?: number;
  vz?: number;
  data: MemoryGraphNode;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  distance: number;
  kind: 'similarity' | 'causal';
}

// Purely structural, computed client-side from data every node already
// carries (conversationId/createdAt) — no backend change needed, unlike
// the similarity edges which need the vector KNN query. Groups nodes by
// conversation, sorts by time, chains consecutive messages — "the actual
// path a conversation took," distinct from "these are semantically close."
// Skips nodes with no conversationId (documents/PDFs aren't part of a chat
// sequence) and singleton conversations (nothing to chain).
function buildCausalEdges(nodes: SimNode[]): SimLink[] {
  const byConversation = new Map<string, SimNode[]>();
  for (const n of nodes) {
    if (!n.data.conversationId) continue;
    const list = byConversation.get(n.data.conversationId) ?? [];
    list.push(n);
    byConversation.set(n.data.conversationId, list);
  }
  const edges: SimLink[] = [];
  for (const list of byConversation.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.data.createdAt - b.data.createdAt);
    for (let i = 0; i < list.length - 1; i++) {
      edges.push({ source: list[i].id, target: list[i + 1].id, distance: 0, kind: 'causal' });
    }
  }
  return edges;
}

const DEFAULT_NEIGHBORS = 3;

// source_type -> which theme CSS var colors it, read live so the graph
// re-skins with the active pack same as every other themed surface in this
// app. Falls back to --accent for any type not explicitly listed, so a
// future source_type doesn't render invisible/black.
// Four real source_types exist now (chat_message, pdf, build_output,
// learned_reference — see memory.rs/skills.ts) — a real, distinct theme
// token per type rather than the earlier pdf-vs-everything-else split,
// using tokens that already existed in index.css unused until now
// (--success/--warning) rather than inventing new ones. Falls back to
// --accent for any future source_type not listed here, so a new one added
// later doesn't render invisible/black.
function colorForSourceType(sourceType: string): THREE.Color {
  switch (sourceType) {
    case 'pdf':
      return readCssColor('--danger', '#d1435b');
    case 'build_output':
      return readCssColor('--success', '#3fb27f');
    case 'learned_reference':
      return readCssColor('--warning', '#d9a441');
    default:
      return readCssColor('--accent', '#4a90d9');
  }
}

function GraphNode({
  node,
  selected,
  onSelect,
  themeVersion,
}: {
  node: SimNode;
  selected: boolean;
  onSelect: (node: SimNode) => void;
  themeVersion: number;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const color = useMemo(() => colorForSourceType(node.data.sourceType), [node.data.sourceType, themeVersion]);
  return (
    <mesh
      position={[node.x ?? 0, node.y ?? 0, node.z ?? 0]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node);
      }}
    >
      <sphereGeometry args={[selected ? 2.6 : 1.6, 16, 16]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 1.4 : 0.6} />
    </mesh>
  );
}

function edgeEndpoint(nodes: SimNode[], ref: SimNode | number): SimNode | undefined {
  // d3-force replaces link.source/target from a raw id into the actual
  // node object once the simulation initializes — both shapes are real,
  // depending on whether this render happens before or after that.
  return typeof ref === 'object' ? ref : nodes.find((n) => n.id === ref);
}

function GraphScene({
  nodes,
  edges,
  selectedId,
  onSelect,
  themeVersion,
}: {
  nodes: SimNode[];
  edges: SimLink[];
  selectedId: number | null;
  onSelect: (node: SimNode) => void;
  themeVersion: number;
}) {
  const [, bumpTick] = useState(0);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);

  useEffect(() => {
    const sim = forceSimulation<SimNode, SimLink>(nodes, 3)
      .force('charge', forceManyBody().strength(-30))
      .force(
        'link',
        forceLink<SimNode, SimLink>(edges)
          .id((d) => d.id)
          // Causal edges pull a conversation's messages into a tight
          // visible chain regardless of how semantically close they are;
          // similarity edges keep spacing proportional to distance.
          .distance((d) => (d.kind === 'causal' ? 8 : 6 + d.distance * 40))
          .strength((d) => (d.kind === 'causal' ? 0.8 : 0.5))
      )
      .force('center', forceCenter(0, 0, 0))
      .alphaDecay(0.03)
      .on('tick', () => bumpTick((t) => t + 1));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rootBg = useMemo(() => readCssColor('--root-bg', '#0b1220'), [themeVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const similarityColor = useMemo(() => readCssColor('--border', '#8fa9c9'), [themeVersion]);
  // A distinct, more saturated color from the similarity edges — these are
  // a fundamentally different relationship (chronological, not semantic)
  // and need to read as visually different at a glance, not just a subtler
  // shade of the same line.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const causalColor = useMemo(() => readCssColor('--accent', '#4a90d9'), [themeVersion]);

  return (
    <>
      <color attach="background" args={[rootBg]} />
      <ambientLight intensity={0.7} />
      <pointLight position={[40, 40, 40]} intensity={300} />
      <pointLight position={[-40, -20, -30]} intensity={120} />
      {edges.map((e, i) => {
        const source = edgeEndpoint(nodes, e.source as SimNode | number);
        const target = edgeEndpoint(nodes, e.target as SimNode | number);
        if (!source || !target) return null;
        const isCausal = e.kind === 'causal';
        const opacity = isCausal ? 0.85 : Math.max(0.1, 1 - e.distance / 2);
        return (
          <Line
            key={`${e.kind}-${source.id}-${target.id}-${i}`}
            points={[
              [source.x ?? 0, source.y ?? 0, source.z ?? 0],
              [target.x ?? 0, target.y ?? 0, target.z ?? 0],
            ]}
            color={isCausal ? causalColor : similarityColor}
            lineWidth={isCausal ? 2 : 1}
            transparent
            opacity={opacity}
          />
        );
      })}
      {nodes.map((n) => (
        <GraphNode key={n.id} node={n} selected={n.id === selectedId} onSelect={onSelect} themeVersion={themeVersion} />
      ))}
      <OrbitControls enableDamping dampingFactor={0.1} />
    </>
  );
}

function formatSourceType(sourceType: string): string {
  return sourceType.replace(/_/g, ' ');
}

interface MemoryGraphViewProps {
  /** conversation id -> title, so a selected node's detail panel can show which conversation it came from — see App.tsx's conversationTitles memo for why this is a plain lookup rather than full Conversation objects. */
  conversationTitles?: Record<string, string>;
  /** Bulk-generates a subject for every unlabeled conversation — see App.tsx's handleClassifyAll, which this component is otherwise unaware of the mechanics of. */
  onClassifyAll?: () => Promise<void>;
  classifyProgress?: { done: number; total: number } | null;
  onStopClassify?: () => void;
}

export function MemoryGraphView({ conversationTitles, onClassifyAll, classifyProgress, onStopClassify }: MemoryGraphViewProps) {
  const themeVersion = useThemeVersion();
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [neighborsPerNode, setNeighborsPerNode] = useState(DEFAULT_NEIGHBORS);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MemoryItemDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  // null until the first graph load sets it from the real fetched
  // distances — see the max-distance slider's bounds effect below. Real
  // data (2026-08-17) showed a clean gap between a genuinely-related
  // cluster (edges up to ~0.93) and an unrelated item's nearest match
  // (~1.09) — no single number generalizes to every dataset, so this
  // stays adjustable rather than a hardcoded cutoff.
  const [maxDistance, setMaxDistance] = useState<number | null>(null);
  const [showSimilarityEdges, setShowSimilarityEdges] = useState(true);
  const [showCausalEdges, setShowCausalEdges] = useState(true);

  // Collapses the whole controls bar down to one slim toggle row — floated
  // 2026-08-20 after a live screenshot of the docked/narrow window showed
  // the (now correctly wrapping, see the min-width:0 fix) controls taking
  // 3-4 rows before the graph itself is even visible. Manual, not tied to
  // window size automatically — simpler than guessing at a width
  // threshold, and the toggle itself is one click either way.
  const [controlsCollapsed, setControlsCollapsed] = useState(false);

  // Type-filter popover — same outside-click/Escape pattern as ThemePicker,
  // reused rather than invented fresh so every popover in this app behaves
  // identically.
  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const typeFilterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!typeFilterOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (typeFilterRef.current && !typeFilterRef.current.contains(e.target as Node)) setTypeFilterOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTypeFilterOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [typeFilterOpen]);

  const loadGraph = () => {
    setError(null);
    getMemoryGraph(neighborsPerNode)
      .then(setGraph)
      .catch((err) => setError(String(err)));
  };

  useEffect(loadGraph, [neighborsPerNode]);

  const allTypes = useMemo(() => [...new Set((graph?.nodes ?? []).map((n) => n.sourceType))].sort(), [graph]);

  const distanceBounds = useMemo(() => {
    const distances = graph?.edges.map((e) => e.distance) ?? [];
    if (distances.length === 0) return { min: 0, max: 1 };
    return { min: Math.min(...distances), max: Math.max(...distances) };
  }, [graph]);

  // Defaults to "show everything" (the widest real distance seen) the
  // first time a graph loads, then leaves the user's own adjustment alone
  // across neighbor-count refetches rather than snapping back.
  useEffect(() => {
    if (maxDistance === null && graph) {
      setMaxDistance(distanceBounds.max);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const { simNodes, simLinks } = useMemo(() => {
    if (!graph) return { simNodes: [] as SimNode[], simLinks: [] as SimLink[] };
    const query = search.trim().toLowerCase();
    const visibleNodeData = graph.nodes.filter(
      (n) => !hiddenTypes.has(n.sourceType) && (!query || n.content.toLowerCase().includes(query))
    );
    const visibleIds = new Set(visibleNodeData.map((n) => n.itemId));
    const nodes: SimNode[] = visibleNodeData.map((n) => ({ id: n.itemId, data: n }));

    const links: SimLink[] = [];
    if (showSimilarityEdges) {
      for (const e of graph.edges) {
        if (visibleIds.has(e.from) && visibleIds.has(e.to) && (maxDistance === null || e.distance <= maxDistance)) {
          links.push({ source: e.from, target: e.to, distance: e.distance, kind: 'similarity' });
        }
      }
    }
    if (showCausalEdges) {
      links.push(...buildCausalEdges(nodes));
    }
    return { simNodes: nodes, simLinks: links };
  }, [graph, hiddenTypes, search, maxDistance, showSimilarityEdges, showCausalEdges]);

  const selectNodeById = (itemId: number) => {
    setSelectedId(itemId);
    setDetail(null);
    setDetailError(null);
    setConfirmingDelete(false);
    getMemoryItem(itemId)
      .then(setDetail)
      .catch((err) => setDetailError(String(err)));
  };

  const selectNode = (n: SimNode) => selectNodeById(n.id);

  // Lets the detail panel step through a conversation's real chat order
  // (chronological, same relationship buildCausalEdges already draws in
  // the 3D view) via </> buttons instead of having to click each node in
  // the graph by hand. Walks the full unfiltered graph.nodes, not the
  // currently-visible simNodes — a type filter or search term hiding a
  // sibling shouldn't break the chain, it should just jump past it.
  const causalSiblings = useMemo(() => {
    if (!detail || !detail.conversationId || !graph) return null;
    const siblings = graph.nodes
      .filter((n) => n.conversationId === detail.conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const idx = siblings.findIndex((n) => n.itemId === detail.itemId);
    if (idx === -1) return null;
    return {
      prev: idx > 0 ? siblings[idx - 1] : null,
      next: idx < siblings.length - 1 ? siblings[idx + 1] : null,
    };
  }, [detail, graph]);

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setConfirmingDelete(false);
  };

  const handleDelete = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
      await deleteMemoryItem(detail.itemId);
      closeDetail();
      loadGraph();
    } catch (err) {
      setDetailError(String(err));
      setDeleting(false);
    }
  };

  const toggleType = (t: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <div className="memory-graph-view">
      <div className="memory-graph-view__controls-header">
        <button
          type="button"
          className="memory-graph-view__controls-toggle"
          onClick={() => setControlsCollapsed((v) => !v)}
          aria-expanded={!controlsCollapsed}
        >
          <ChevronDown
            size={14}
            className="memory-graph-view__controls-toggle-chevron"
            style={{ transform: controlsCollapsed ? 'rotate(-90deg)' : undefined }}
            aria-hidden="true"
          />
          <span>Controls</span>
        </button>
        {controlsCollapsed && search && <span className="memory-graph-view__controls-summary">"{search}"</span>}
        {controlsCollapsed && hiddenTypes.size > 0 && (
          <span className="memory-graph-view__controls-summary">{hiddenTypes.size} type(s) hidden</span>
        )}
      </div>

      {!controlsCollapsed && (
      <div className="memory-graph-view__controls">
        <div className="memory-graph-view__controls-group memory-graph-view__controls-group--search">
          <div className="memory-graph-view__search-wrap">
            <Search size={14} className="memory-graph-view__controls-icon" aria-hidden="true" />
            <input
              type="text"
              className="memory-graph-view__search"
              placeholder="Search memories…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="memory-graph-view__controls-group">
          <span className="memory-graph-view__controls-label">Filters</span>

          {allTypes.length > 1 && (
            <div className="memory-graph-view__type-filter-popover" ref={typeFilterRef}>
              <button
                type="button"
                className="memory-graph-view__filter-trigger"
                onClick={() => setTypeFilterOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={typeFilterOpen}
              >
                <SlidersHorizontal size={13} aria-hidden="true" />
                <span>
                  Type
                  {hiddenTypes.size > 0 ? ` (${allTypes.length - hiddenTypes.size}/${allTypes.length})` : ''}
                </span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {typeFilterOpen && (
                <div className="memory-graph-view__filter-menu" role="menu">
                  {allTypes.map((t) => (
                    <label key={t} className="memory-graph-view__type-filter">
                      <input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => toggleType(t)} />
                      <span>{formatSourceType(t)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="memory-graph-view__edge-toggle">
            <span>Similarity edges</span>
            <span className="settings-menu__toggle">
              <input type="checkbox" checked={showSimilarityEdges} onChange={() => setShowSimilarityEdges((v) => !v)} />
              <span className="settings-menu__toggle-track" aria-hidden="true" />
            </span>
          </label>
          <label className="memory-graph-view__edge-toggle">
            <span>Causal edges</span>
            <span className="settings-menu__toggle">
              <input type="checkbox" checked={showCausalEdges} onChange={() => setShowCausalEdges((v) => !v)} />
              <span className="settings-menu__toggle-track" aria-hidden="true" />
            </span>
          </label>
        </div>

        <div className="memory-graph-view__controls-group">
          <span className="memory-graph-view__controls-label">Graph shape</span>
          <label className="memory-graph-view__neighbors-field">
            <span>Neighbors/node</span>
            <input
              type="number"
              min={1}
              max={10}
              value={neighborsPerNode}
              onChange={(e) => setNeighborsPerNode(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>

          {maxDistance !== null && distanceBounds.max > distanceBounds.min && (
            <label className="memory-graph-view__distance-field">
              <span>Max distance ({maxDistance.toFixed(2)})</span>
              <input
                type="range"
                min={distanceBounds.min}
                max={distanceBounds.max}
                step={(distanceBounds.max - distanceBounds.min) / 100 || 0.01}
                value={maxDistance}
                onChange={(e) => setMaxDistance(Number(e.target.value))}
              />
            </label>
          )}
        </div>

        <div className="memory-graph-view__controls-spacer" />

        {onClassifyAll && (
          <button
            type="button"
            className="memory-graph-view__classify-button"
            onClick={() => void onClassifyAll()}
            disabled={!!classifyProgress}
            title="Generate a subject for every conversation that doesn't have one yet"
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>Classify</span>
          </button>
        )}
      </div>
      )}

      {classifyProgress && (
        <div className="memory-graph-view__classify-band">
          <span>
            Labeling {classifyProgress.done} of {classifyProgress.total}…
          </span>
          {onStopClassify && (
            <button type="button" onClick={onStopClassify}>
              Stop
            </button>
          )}
        </div>
      )}

      {error ? (
        <p className="memory-graph-view__hint">Couldn't load memory graph: {error}</p>
      ) : !graph ? (
        <p className="memory-graph-view__hint">Loading…</p>
      ) : graph.nodes.length === 0 ? (
        <p className="memory-graph-view__hint">
          Nothing indexed in memory yet — nothing to graph. Ask the model to remember something in chat, or drag in
          a document and let it remember that too.
        </p>
      ) : (
        <div className="memory-graph-view__canvas-wrap">
          <Canvas camera={{ position: [0, 0, 90], fov: 50 }}>
            <GraphScene
              nodes={simNodes}
              edges={simLinks}
              selectedId={selectedId}
              onSelect={selectNode}
              themeVersion={themeVersion}
            />
          </Canvas>
          {selectedId !== null && (
            <div className="memory-graph-view__detail">
              <div className="memory-graph-view__detail-header">
                {causalSiblings && (causalSiblings.prev || causalSiblings.next) && (
                  <div className="memory-graph-view__detail-nav">
                    <button
                      type="button"
                      onClick={() => causalSiblings.prev && selectNodeById(causalSiblings.prev.itemId)}
                      disabled={!causalSiblings.prev}
                      aria-label="Previous message in this conversation"
                      title="Previous message in this conversation"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => causalSiblings.next && selectNodeById(causalSiblings.next.itemId)}
                      disabled={!causalSiblings.next}
                      aria-label="Next message in this conversation"
                      title="Next message in this conversation"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="memory-graph-view__detail-close"
                  onClick={closeDetail}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              {detailError ? (
                <p className="memory-graph-view__hint">Couldn't load: {detailError}</p>
              ) : !detail ? (
                <p className="memory-graph-view__hint">Loading…</p>
              ) : (
                <>
                  <span className="memory-graph-view__detail-type">{formatSourceType(detail.sourceType)}</span>
                  {detail.conversationId && conversationTitles?.[detail.conversationId] && (
                    <span className="memory-graph-view__detail-meta">
                      From: {conversationTitles[detail.conversationId]}
                    </span>
                  )}
                  <p className="memory-graph-view__detail-content">{detail.content}</p>
                  {detail.sourcePath && <span className="memory-graph-view__detail-meta">{detail.sourcePath}</span>}
                  <span className="memory-graph-view__detail-meta">{new Date(detail.createdAt).toLocaleString()}</span>

                  <div className="memory-graph-view__detail-actions">
                    {confirmingDelete ? (
                      <>
                        <span className="memory-graph-view__confirm-label">Delete this memory permanently?</span>
                        <button type="button" onClick={handleDelete} disabled={deleting} className="memory-graph-view__delete-confirm">
                          {deleting ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="memory-graph-view__delete-start" onClick={() => setConfirmingDelete(true)}>
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
