/**
 * omp-task-group — hand-written public API surface.
 *
 * Every type here mirrors a DOCUMENTED OMP public contract (docs/extensions.md,
 * docs/tools/eval.md, docs/tools/hub.md at v18.1.x). Nothing imports host
 * internals; nothing depends on @oh-my-pi packages at runtime. When OMP
 * evolves a shape, only this file needs review.
 */

// ── Public tool result contract ──────────────────────────────────────

/** Standard OMP tool result (documented in docs/extensions.md). */
export interface ToolTextContent {
  type: "text";
  text: string;
}

export type ToolImageContent = { type: "image"; data: string; mimeType: string };

export type ToolContent = ToolTextContent | ToolImageContent;

export interface AgentToolResult<TDetails = unknown> {
  content: ToolContent[];
  details?: TDetails;
  isError?: boolean;
}

export type ToolUpdateCallback = (update: {
  content: ToolContent[];
  details?: unknown;
}) => void;

// ── Extension context (subset we consume) ────────────────────────────

/** Extension run mode (documented: "tui" | "rpc" | "json" | "print"). */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionUIContext {
  /** Footer/status text. Pass undefined to clear. Emits extension_ui_request in RPC mode. */
  setStatus(key: string, text: string | undefined): void;
  /** Widget above/below editor; string-array content is RPC-safe. */
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(
    title: string,
    options: Array<string | { label: string; description?: string }>,
  ): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  theme?: {
    fg(color: string, text: string): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
  };
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: ExtensionMode;
  hasUI: boolean;
  cwd: string;
  sessionManager: {
    getSessionId(): string | undefined;
    getBranch(): unknown[];
  };
  /** Contained timers (throw-safe, cleared on session_shutdown). */
  setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown;
  setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown;
  clearTimer(timer: unknown): void;
  /**
   * Delegate to the NATIVE built-in tool of the SAME name. Present only when
   * this extension's registered tool shadows a built-in (docs/extensions.md).
   */
  invokeTool?<TDetails = unknown>(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: ToolUpdateCallback },
  ): Promise<AgentToolResult<TDetails>>;

  /** Abort the current agent operation. */
  abort(): void;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
}

// ── Extension API (subset we consume) ────────────────────────────────

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: unknown[];
  systemPrompt: string[];
}

export interface BeforeAgentStartResult {
  systemPrompt?: string[];
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolBlockResult {
  block: true;
  reason: string;
}

/** Revision returned by a public `tool_call` handler. */
export interface ToolInputRewriteResult {
  input: Record<string, unknown>;
}

export type ToolCallResult = ToolBlockResult | ToolInputRewriteResult;

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
  intent?: string;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

/** Public `tool_result` event; handlers may patch its final result. */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  /** Effective, schema-validated execution input. */
  input: Record<string, unknown>;
  content: ToolContent[];
  details: unknown;
  isError: boolean;
}

/** Patch returned by a public `tool_result` handler. */
export interface ToolResultPatch {
  content?: ToolContent[];
  details?: unknown;
  isError?: boolean;
}

export interface TurnStartEvent {
  type: "turn_start";
}

export interface TurnEndEvent {
  type: "turn_end";
}

export interface SessionLifecycleEvent {
  type:
    | "session_start"
    | "session_switch"
    | "session_branch"
    | "session_tree"
    | "session_shutdown";
}

export type ExtensionEventMap = {
  before_agent_start: BeforeAgentStartEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_end: ToolExecutionEndEvent;
  turn_start: TurnStartEvent;
  turn_end: TurnEndEvent;
  session_start: SessionLifecycleEvent;
  session_switch: SessionLifecycleEvent;
  session_branch: SessionLifecycleEvent;
  session_tree: SessionLifecycleEvent;
  session_shutdown: SessionLifecycleEvent;
};

export type ExtensionEventHandler<E extends keyof ExtensionEventMap> = (
  event: ExtensionEventMap[E],
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

/**
 * Minimal structural view of the host-injected schema builder (`pi.zod`,
 * omptype-backed zod-compatible surface documented in docs/extensions.md).
 * Methods return opaque schema nodes that only flow back into registerTool.
 */
export interface SchemaNode {
  optional(): SchemaNode;
  describe(text: string): SchemaNode;
  default(value: unknown): SchemaNode;
}

export interface SchemaBuilder {
  object(shape: Record<string, SchemaNode>): SchemaNode;
  string(): SchemaNode;
  number(): SchemaNode;
  boolean(): SchemaNode;
  literal(value: string | number | boolean): SchemaNode;
  unknown(): SchemaNode;
  array(items: SchemaNode): SchemaNode;
}

/** The pi/omp extension API surface used by this plugin (documented subset). */
export interface ExtensionAPI {
  on<E extends keyof ExtensionEventMap>(event: E, handler: ExtensionEventHandler<E>): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
    },
  ): void;
  /** Injected schema builder for tool parameter schemas. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zod: any;
  /** Append a custom session entry (package-qualified customType required). */
  appendEntry<T = unknown>(customType: string, data?: T): void;
  /** Contained logger from the host. */
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

export interface ToolRenderOptions {
  expanded: boolean;
  isPartial: boolean;
  spinnerFrame?: number;
}

/** pi-tui Component contract (docs/tui.md): render returns immutable rows. */
export interface TuiComponent {
  render(width: number): readonly string[];
  invalidate?(): void;
  dispose?(): void;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  /** Schema built with pi.zod (host-injected); opaque on this side. */
  parameters: unknown;
  hidden?: boolean;
  loadMode?: "essential" | "discoverable";
  approval?: "read" | "write" | "exec";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult>;
  onSession?(event: { reason: string }, ctx: ExtensionContext): void | Promise<void>;
  renderCall?(args: Record<string, unknown>, options: ToolRenderOptions, theme: unknown): TuiComponent;
  renderResult?(
    result: AgentToolResult,
    options: ToolRenderOptions,
    theme: unknown,
    args?: Record<string, unknown>,
  ): TuiComponent;
}
