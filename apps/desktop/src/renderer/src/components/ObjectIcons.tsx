/**
 * Professionele object-iconen voor de Object Explorer (SAL-32).
 * Kleine inline SVG-iconen (16×16, currentColor) per objecttype —
 * vervanging van de losse emoji's (🗄️📁📂📋👁️).
 */

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Server: toren/rack. */
export function ServerIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2" width="11" height="3" rx="0.8" />
      <rect x="2.5" y="6.5" width="11" height="3" rx="0.8" />
      <rect x="2.5" y="11" width="11" height="3" rx="0.8" />
      <circle cx="4.5" cy="3.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12.5" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Map/folder. */
export function FolderIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.2 1.6h6.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </Svg>
  )
}

/** Database: cilinder. */
export function DatabaseIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <ellipse cx="8" cy="3.4" rx="5.4" ry="2" />
      <path d="M2.6 3.4v9.2c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V3.4" />
      <path d="M2.6 8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2" />
    </Svg>
  )
}

/** Schema: cilinder met laagjes (schema = organisatielaag). */
export function SchemaIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <ellipse cx="8" cy="4.5" rx="5" ry="1.8" />
      <path d="M3 4.5v3c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-3" />
      <path d="M3 7.5v3c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-3" />
    </Svg>
  )
}

/** Tabel: raster. */
export function TableIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2 6h12M2 9h12M6.5 2.5v11M11 2.5v11" />
    </Svg>
  )
}

/** View: oog. */
export function ViewIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="2.2" />
    </Svg>
  )
}

/** Stored procedure: tandwiel. */
export function ProcedureIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
    </Svg>
  )
}

/** Function: fx. */
export function FunctionIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 2.5h6.5M4.5 5.5h6.5" />
      <path d="M6.2 2.5v2.2c0 2 .6 3.4 2.4 3.4 1.4 0 2-.8 2.2-1.9" />
      <path d="M7.4 8.1v1.6c0 2 .6 3.4 2.4 3.4 1.4 0 2-.8 2.2-1.9" />
    </Svg>
  )
}

/** Trigger: bliksem. */
export function TriggerIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 1.5 3.5 9h3.2L6 14.5l5.5-7.5H8.3z" />
    </Svg>
  )
}

/** Sequence: genummerde lijst. */
export function SequenceIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.8 4.2h10.4M2.8 8h10.4M2.8 11.8h10.4" />
      <circle cx="1.6" cy="4.2" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="1.6" cy="8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="1.6" cy="11.8" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Synonym: schakel/ketting. */
export function SynonymIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6.8 9.2 4.6 11.4a2 2 0 0 1-2.8-2.8L4 6.4" />
      <path d="M9.2 6.8l2.2-2.2a2 2 0 0 1 2.8 2.8L12 9.6" />
      <path d="M5.6 10.4 10.4 5.6" />
    </Svg>
  )
}

/** User: persoon. */
export function UserIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.8 14c.6-2.8 2.8-4.2 5.2-4.2s4.6 1.4 5.2 4.2" />
    </Svg>
  )
}

/** Role: persoon met badge. */
export function RoleIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.8 14c.6-2.8 2.8-4.2 5.2-4.2s4.6 1.4 5.2 4.2" />
      <circle cx="13.2" cy="2.8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Column: kolommenbalk. */
export function ColumnIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="3.4" height="12" rx="0.7" />
      <rect x="6.3" y="2" width="3.4" height="12" rx="0.7" />
      <rect x="10.6" y="2" width="3.4" height="12" rx="0.7" />
    </Svg>
  )
}

/** Key/sleutel. */
export function KeyIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="5" cy="8" r="3" />
      <path d="M7.4 5.6 13.5 2.5M9.5 6.8l2-1.2M12.2 4.6l1.6 1" />
    </Svg>
  )
}

/** Constraint: slot. */
export function ConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
      <circle cx="8" cy="10" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Index: filter/trechter met strepen. */
export function IndexIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2 2.5h12L9.5 7.5v5l-3 1.5v-6.5z" />
    </Svg>
  )
}

/** Chevron (expander): wijst naar rechts, roteert bij open. */
export function ChevronIcon({ open, ...props }: IconProps & { open?: boolean }): React.JSX.Element {
  return (
    <svg
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`tree-chevron-svg${open ? ' open' : ''}${props.className ? ` ${props.className}` : ''}`}
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

/** Refresh: ronde pijl. */
export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" />
      <path d="M13.4 1.8v2.8h-2.8" />
    </Svg>
  )
}

/** Nieuwe query: document met plus. */
export function NewQueryIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 1.8h5.5L13 5.3v9H4z" />
      <path d="M9.5 1.8v3.5H13M7 8.5v4M5 10.5h4" />
    </Svg>
  )
}

/** Eigenschappen: info. */
export function PropertiesIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M8 7.5v4" />
    </Svg>
  )
}

/** Data (tabelgegevens). */
export function DataIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M2 6h12" />
      <circle cx="4.2" cy="8.6" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="4.2" cy="11" r="0.6" fill="currentColor" stroke="none" />
      <path d="M6 8.6h6M6 11h6" />
    </Svg>
  )
}

/** Schema-objecten (programmability): koffer met code. */
export function ProgrammabilityIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="1.8" y="4" width="12.4" height="9" rx="1" />
      <path d="M5.5 4V3a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 10.5 3v1" />
      <path d="M6 7.2 4.2 9 6 10.8M10 7.2 11.8 9 10 10.8" />
    </Svg>
  )
}

/** Security: schild. */
export function SecurityIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 1.8 13.5 4v4.2c0 3.4-2.4 5.4-5.5 6.5C4.9 13.6 2.5 11.6 2.5 8.2V4z" />
      <path d="M6.2 8l1.3 1.3 2.6-2.8" />
    </Svg>
  )
}

/** Mappings: kind → icon-component. */
export const OBJECT_ICONS: Record<string, (props: IconProps) => React.JSX.Element> = {
  server: ServerIcon,
  folder: FolderIcon,
  database: DatabaseIcon,
  schema: SchemaIcon,
  table: TableIcon,
  view: ViewIcon,
  procedure: ProcedureIcon,
  function: FunctionIcon,
  trigger: TriggerIcon,
  sequence: SequenceIcon,
  synonym: SynonymIcon,
  user: UserIcon,
  role: RoleIcon,
  column: ColumnIcon,
  key: KeyIcon,
  constraint: ConstraintIcon,
  index: IndexIcon,
  programmability: ProgrammabilityIcon,
  security: SecurityIcon
}
