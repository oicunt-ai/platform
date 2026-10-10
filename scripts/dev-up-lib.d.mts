/** Types for scripts/dev-up-lib.mjs (plain-JS launcher core). */

export interface ServiceSpec {
  readonly name: string;
  readonly packageDir: string;
  readonly entry: string;
  readonly port: number;
}

export interface ChildRef {
  readonly pid?: number | undefined;
  exitCode: number | null | undefined;
  kill(signal: string): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface StartedService {
  readonly spec: ServiceSpec;
  readonly child: ChildRef;
}

export type SpawnFn = (
  spec: ServiceSpec,
  env: Record<string, string>,
) => ChildRef | Promise<ChildRef>;
export type CheckPortFn = (port: number) => boolean | Promise<boolean>;
export type ProbeFn = (url: string) => number | null | Promise<number | null>;
export type SleepFn = (ms: number) => Promise<void>;
export type LogFn = (line: string) => void;
export type NowFn = () => number;

export interface StartAllDeps {
  readonly spawn: SpawnFn;
  readonly checkPort: CheckPortFn;
  readonly probe: ProbeFn;
  readonly sleep: SleepFn;
  readonly log: LogFn;
  readonly now?: NowFn | undefined;
  readonly services?: readonly ServiceSpec[] | undefined;
  readonly timeouts: { readonly health: number; readonly ready: number };
  readonly intervalMs?: number | undefined;
}

export interface StartCtx {
  readonly env: Record<string, string | undefined>;
  readonly tokens: Record<string, string>;
  readonly orchestratorUrl: string;
}

export interface ShutdownDeps {
  readonly sleep: SleepFn;
  readonly log: LogFn;
  readonly now?: NowFn | undefined;
  readonly graceMs?: number | undefined;
}

export interface WaitOptions<T> {
  readonly check: () => T | null | undefined | Promise<T | null | undefined>;
  readonly sleep: SleepFn;
  readonly timeoutMs: number;
  readonly intervalMs?: number | undefined;
  readonly isAlive?: (() => boolean) | null | undefined;
  readonly now?: NowFn | undefined;
}

export type WaitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'timeout' | 'exited' };

export interface PrefixResult {
  readonly lines: string[];
  readonly carry: string;
}

export declare const LOOPBACK_HOST: string;
export declare const HEALTH_PATH: string;
export declare const READY_PATH: string;
export declare const ORCHESTRATOR_DEV_URL: string;
export declare const DEV_SERVICES: readonly ServiceSpec[];
export declare const REQUIRED_ENV: readonly string[];
export declare const TOKEN_NAMES: readonly string[];

export declare function serviceBaseUrl(port: number): string;
export declare function orchestratorReadyUrl(base: string): string;
export declare function healthUrl(port: number): string;
export declare function readyUrl(port: number): string;
export declare function parseDotEnv(text: string): Record<string, string>;
export declare function missingEnv(
  env: Record<string, string | undefined>,
  names?: readonly string[],
): string[];
export declare function mergeEnv(
  fileEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined>;
export declare function resolveTokenEnv(
  env: Record<string, string | undefined>,
):
  | { readonly ok: true; readonly mapping: Record<string, string> }
  | { readonly ok: false; readonly missing: string[] };
export declare function resolveOrchestratorUrl(
  env: Record<string, string | undefined>,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };
export declare function admissionRequested(env: Record<string, string | undefined>): boolean;
export declare function buildChildEnv(spec: ServiceSpec, ctx: StartCtx): Record<string, string>;
export declare function checkTcpOpen(
  host: string,
  port: number,
  timeoutMs?: number,
): Promise<boolean>;
export declare function probeOnce(
  url: string,
  options?: { readonly fetchFn?: typeof fetch; readonly timeoutMs?: number },
): Promise<number | null>;
export declare function waitFor<T>(options: WaitOptions<T>): Promise<WaitResult<T>>;
export declare function prefixLines(
  service: string,
  chunk: string | Uint8Array,
  carry?: string,
): PrefixResult;
export declare function shutdownOrder<T>(records: readonly T[]): T[];
export declare function formatMissingEnv(names: readonly string[]): string;
export declare function formatPortConflict(spec: ServiceSpec, health: number | null): string;
export declare function startAll(deps: StartAllDeps, ctx: StartCtx): Promise<StartedService[]>;
export declare function shutdownAll(
  records: readonly StartedService[],
  deps: ShutdownDeps,
): Promise<void>;
export declare function watchChildren(
  records: readonly StartedService[],
  onDeath: (spec: ServiceSpec, code: unknown, signal: unknown) => void,
): () => void;
