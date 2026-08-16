import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  BadgeCheck,
  BookOpenCheck,
  Boxes,
  Braces,
  Cable,
  CircleCheckBig,
  Component,
  Database,
  KeyRound,
  LockKeyhole,
  MonitorCog,
  RefreshCcw,
  RotateCcw,
  Route,
  Scale,
  ScanLine,
  Server,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  TableProperties,
  TimerReset,
  TriangleAlert,
  Truck,
  Undo2,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  overviewDiagram,
  type ArchitectureDiagram,
  type ArchitectureIcon,
  type ArchitectureNode as ArchitectureNodeType,
} from "./architecture-data";
import { detailedDiagrams } from "./detailed-diagrams";
import "./styles.css";

const iconMap: Record<ArchitectureIcon, LucideIcon> = {
  operator: UserRound,
  desktop: MonitorCog,
  adb: Cable,
  device: Smartphone,
  api: Server,
  domain: Boxes,
  worker: Workflow,
  database: Database,
  gateway: ShieldCheck,
  observability: Activity,
  coupang: ShoppingBag,
  carrier: Truck,
  component: Component,
  route: Route,
  auth: BadgeCheck,
  function: Braces,
  transaction: RefreshCcw,
  ledger: BookOpenCheck,
  policy: Scale,
  table: TableProperties,
  snapshot: ScanLine,
  lock: LockKeyhole,
  timer: TimerReset,
  retry: RotateCcw,
  success: CircleCheckBig,
  warning: TriangleAlert,
  return: Undo2,
};

function ArchitectureNode({ data }: NodeProps<ArchitectureNodeType>) {
  const Icon = iconMap[data.icon];

  return (
    <article className={`architecture-node architecture-node--${data.tone}`}>
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className="architecture-port"
      />
      <Handle
        id="right-target"
        type="target"
        position={Position.Right}
        className="architecture-port"
      />
      <Handle
        id="top-target"
        type="target"
        position={Position.Top}
        className="architecture-port"
      />
      <Handle
        id="bottom-target"
        type="target"
        position={Position.Bottom}
        className="architecture-port"
      />
      <Handle
        id="left-source"
        type="source"
        position={Position.Left}
        className="architecture-port"
      />
      <Handle
        id="right-source"
        type="source"
        position={Position.Right}
        className="architecture-port"
      />
      <Handle
        id="top-source"
        type="source"
        position={Position.Top}
        className="architecture-port"
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        className="architecture-port"
      />

      <div className="architecture-node__topline">
        <span className="architecture-node__icon" aria-hidden="true">
          <Icon size={20} strokeWidth={1.8} />
        </span>
        <span className="architecture-node__eyebrow">{data.eyebrow}</span>
      </div>
      <h2>{data.title}</h2>
      <p>{data.description}</p>
      <div className="architecture-node__detail">{data.detail}</div>
    </article>
  );
}

const nodeTypes = {
  architecture: ArchitectureNode,
} satisfies NodeTypes;

const diagrams = [overviewDiagram, ...detailedDiagrams];

function selectedDiagram(): ArchitectureDiagram {
  const requestedId = new URLSearchParams(window.location.search).get("diagram");
  return (
    diagrams.find((candidate) => candidate.id === requestedId) ?? overviewDiagram
  );
}

function selectedTheme() {
  return new URLSearchParams(window.location.search).get("theme") === "blueprint"
    ? "blueprint"
    : "default";
}

function ArchitectureApp() {
  const diagram = selectedDiagram();
  const theme = selectedTheme();
  const isBlueprint = theme === "blueprint";

  React.useEffect(() => {
    document.documentElement.dataset.renderReady = "true";
  }, []);

  return (
    <main
      className={`portfolio-page portfolio-page--${theme}`}
      data-render-ready="true"
      data-diagram-id={diagram.id}
      data-render-theme={theme}
      data-output-name={diagram.outputName}
      data-expected-nodes={diagram.nodes.length}
      data-expected-edges={diagram.edges.length}
    >
      <header className="portfolio-header">
        <section>
          <div className="portfolio-kicker">
            <span>QUICKHACK</span>
            <span className="portfolio-kicker__line" />
            <span>{diagram.kicker}</span>
          </div>
          <h1>
            {diagram.titleLead}
            <br />
            <strong>{diagram.titleStrong}</strong>
          </h1>
        </section>

        <aside className="portfolio-header__summary">
          <p>
            {diagram.summary[0]}
            <br />
            {diagram.summary[1]}
          </p>
          <div className="portfolio-tech-list" aria-label="핵심 기술과 코드 경계">
            {diagram.tech.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </aside>
      </header>

      <section className="architecture-canvas" aria-label={diagram.ariaLabel}>
        {isBlueprint ? (
          <div className="blueprint-sheet-meta" aria-hidden="true">
            <span>DWG · QH/{diagram.id.toUpperCase()}</span>
            <span>SCALE · NTS</span>
            <span>REV · 01</span>
          </div>
        ) : null}
        <div className="architecture-lanes" aria-hidden="true">
          {diagram.lanes.map((lane) => (
            <div
              className="architecture-lane"
              key={lane.index}
              style={{ left: lane.left, width: lane.width }}
            >
              <span>{lane.index}</span>
              <strong>{lane.title}</strong>
              <small>{lane.subtitle}</small>
            </div>
          ))}
        </div>

        <ReactFlow
          nodes={diagram.nodes}
          edges={diagram.edges}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background
            variant={
              isBlueprint
                ? BackgroundVariant.Lines
                : BackgroundVariant.Dots
            }
            gap={isBlueprint ? 20 : 24}
            size={isBlueprint ? 0.7 : 1.1}
            color={
              isBlueprint
                ? "rgba(141, 222, 255, 0.11)"
                : "rgba(148, 163, 184, 0.16)"
            }
          />
        </ReactFlow>
      </section>

      <footer className="portfolio-footer">
        <div className="portfolio-legend">
          {diagram.legend.map((item) => (
            <span key={item.label}>
              <i className={`legend-line legend-line--${item.tone}`} />
              {item.label}
            </span>
          ))}
        </div>
        <div className="portfolio-footer__mark">
          <KeyRound size={15} aria-hidden="true" />
          {isBlueprint
            ? `QUICKHACK ENGINEERING DRAWING · ${diagram.id.toUpperCase()} · 2026`
            : "Repository-grounded architecture · 2026"}
        </div>
      </footer>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ArchitectureApp />
  </React.StrictMode>
);
