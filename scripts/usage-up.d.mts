/** Types for scripts/usage-up.mjs (plain-JS Usage launcher). */
import type { ChildRef } from './dev-up-lib.mjs';

export interface UsageSettingRef {
  readonly name: string;
  readonly value: string;
}

export interface UsageDbSettings {
  readonly host: UsageSettingRef | null;
  readonly port: UsageSettingRef | null;
  readonly user: UsageSettingRef | null;
  readonly password: UsageSettingRef | null;
}

export interface UsageSettings {
  readonly nodeEnv: string;
  readonly token: UsageSettingRef | null;
  readonly db: UsageDbSettings;
  readonly rabbitUrl: UsageSettingRef | null;
  readonly bindHost: string | undefined;
  readonly bindPort: number | undefined;
  readonly useDatabase: string | undefined;
  readonly useRabbitMq: string | undefined;
  readonly autoMigrate: string | undefined;
}

export interface UsageValidationResult {
  readonly ok: boolean;
  readonly problems: string[];
}

export interface UsageSpec {
  readonly name: string;
  readonly port: number;
  readonly entry: string;
}

export interface UsageChildRef extends ChildRef {
  readonly stdout?:
    { on(event: string, listener: (...args: unknown[]) => void): void } | null | undefined;
  readonly stderr?:
    { on(event: string, listener: (...args: unknown[]) => void): void } | null | undefined;
}

export interface UsageRecord {
  readonly spec: UsageSpec;
  readonly child: UsageChildRef;
}

export type UsageSpawnFn = (
  entry: string,
  env: Record<string, string>,
) => UsageChildRef | Promise<UsageChildRef>;

export interface StartUsageDeps {
  readonly exists: (path: string) => boolean;
  readonly checkPort: (port: number) => boolean | Promise<boolean>;
  readonly spawn: UsageSpawnFn;
  readonly probe: (url: string) => number | null | Promise<number | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly now?: (() => number) | undefined;
  readonly intervalMs?: number | undefined;
  readonly timeouts: { readonly health: number; readonly ready: number };
}

export interface StartUsageCtx {
  readonly entry: string;
  readonly env: Record<string, string | undefined>;
}

export interface SuperviseUsageDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly now?: (() => number) | undefined;
  readonly graceMs?: number | undefined;
  readonly onExit?: ((code: number) => void) | undefined;
}

export interface UsageSupervisor {
  stop(force?: boolean): Promise<void>;
  isStopping(): boolean;
}

export declare const REPO_ROOT: string;
export declare const USAGE_HOST: string;
export declare const USAGE_PORT: number;
export declare const USAGE_ENTRYPOINT: string;
export declare const USAGE_TOKEN_NAMES: readonly string[];
export declare const USAGE_DB_NAMES: Readonly<
  Record<'host' | 'port' | 'user' | 'password', readonly [string, string]>
>;

export declare function cleanValue(value: string | undefined): string | undefined;
export declare function firstNameValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): UsageSettingRef | null;
export declare function parsePortValue(value: string | undefined): number | undefined;
export declare function isBrokerUrl(value: string | undefined): boolean;
export declare function resolveUsageSettings(
  env: Record<string, string | undefined>,
): UsageSettings;
export declare function validateUsageSettings(settings: UsageSettings): UsageValidationResult;
export declare function validateUsageEnv(
  env: Record<string, string | undefined>,
): UsageValidationResult;
export declare function buildUsageChildEnv(
  env: Record<string, string | undefined>,
): Record<string, string>;
export declare function startUsage(deps: StartUsageDeps, ctx: StartUsageCtx): Promise<UsageRecord>;
export declare function superviseUsage(
  record: UsageRecord,
  deps: SuperviseUsageDeps,
): UsageSupervisor;
