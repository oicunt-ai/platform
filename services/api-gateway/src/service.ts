import { createServer, type Server } from 'node:http';
import type { Logger } from '@oicunt/logging';
import { MemoryLogger } from '@oicunt/logging';
import type { Tracer } from '@oicunt/observability';
import { NoopTracer } from '@oicunt/observability';
import {
  AuthenticateTokenUseCase,
  GetContextUseCase,
  ForwardCompletionUseCase,
  type TokenVerifierPort,
  type OrchestratorClientPort,
  type UsageAdmissionPort,
} from './application/index.js';
import { loadServiceConfig, type GatewayConfig } from './config.js';
import {
  JwksTokenVerifier,
  HttpOrchestratorClient,
  HttpUsageAdmissionClient,
} from './infrastructure/index.js';
import {
  createHttpRouter,
  ContextController,
  CompletionController,
  ResourcesController,
} from './interfaces/index.js';

export interface GatewayServiceDependencies {
  readonly config?: GatewayConfig;
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly tokenVerifier?: TokenVerifierPort;
  readonly orchestratorClient?: OrchestratorClientPort;
  readonly usageAdmissionClient?: UsageAdmissionPort;
}

export class GatewayServiceInstance {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly tokenVerifier: TokenVerifierPort;
  private readonly orchestratorClient: OrchestratorClientPort;
  private readonly usageAdmissionClient: UsageAdmissionPort | undefined;
  private server: Server | null = null;
  private ready = false;

  constructor(dependencies: GatewayServiceDependencies = {}) {
    this.config = dependencies.config ?? loadServiceConfig();
    this.logger = dependencies.logger ?? new MemoryLogger({ service: this.config.serviceName });
    this.tracer = dependencies.tracer ?? new NoopTracer();

    this.tokenVerifier =
      dependencies.tokenVerifier ??
      new JwksTokenVerifier({
        jwksUri: this.config.jwksUri,
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
        clockSkewSeconds: this.config.clockSkewSeconds,
      });

    this.orchestratorClient =
      dependencies.orchestratorClient ??
      new HttpOrchestratorClient({
        orchestratorBaseUrl: this.config.orchestratorBaseUrl,
        internalServiceSecret: this.config.orchestratorInternalSecret,
      });
    this.usageAdmissionClient =
      dependencies.usageAdmissionClient ??
      (this.config.enableUsageAdmission
        ? new HttpUsageAdmissionClient(this.config.usageBaseUrl, this.config.usageInternalSecret)
        : undefined);
  }

  getConfig(): GatewayConfig {
    return this.config;
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    this.logger.info(`Initializing service ${this.config.serviceName}...`, {
      environment: this.config.environment,
      version: this.config.version,
      orchestratorBaseUrl: this.config.orchestratorBaseUrl,
    });

    const authenticateUseCase = new AuthenticateTokenUseCase(this.tokenVerifier);
    const getContextUseCase = new GetContextUseCase();
    const forwardCompletionUseCase = new ForwardCompletionUseCase(this.orchestratorClient);

    const contextController = new ContextController(authenticateUseCase, getContextUseCase);
    const completionController = new CompletionController(
      authenticateUseCase,
      forwardCompletionUseCase,
      this.config.enableUsageAdmission ? this.usageAdmissionClient : undefined,
    );

    const router = createHttpRouter({
      serviceName: this.config.serviceName,
      version: this.config.version,
      isReady: async () => {
        if (!this.ready) return false;
        const [orchestratorReady, usageReady] = await Promise.all([
          this.orchestratorClient.checkHealth?.() ?? Promise.resolve(true),
          this.config.enableUsageAdmission
            ? (this.usageAdmissionClient?.checkHealth?.() ?? Promise.resolve(false))
            : Promise.resolve(true),
        ]);
        return orchestratorReady && usageReady;
      },
      logger: this.logger,
      tracer: this.tracer,
      contextController,
      completionController,
      resourcesController: new ResourcesController(authenticateUseCase, this.orchestratorClient),
    });

    this.server = createServer((req, res) => {
      void router(req, res);
    });

    this.ready = true;
    this.logger.info(`Service ${this.config.serviceName} initialized successfully.`);
  }

  async start(): Promise<number> {
    if (!this.server) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not initialized'));
        return;
      }

      this.server.listen(this.config.port, this.config.host, () => {
        const address = this.server?.address();
        const actualPort =
          typeof address === 'object' && address !== null ? address.port : this.config.port;

        this.logger.info(
          `Service ${this.config.serviceName} listening on http://${this.config.host}:${actualPort}`,
        );
        resolve(actualPort);
      });

      this.server.on('error', (err) => {
        this.ready = false;
        this.logger.error('Server encountered an error during listen', err);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.logger.info(`Stopping service ${this.config.serviceName}...`);

    if (!this.server) {
      return;
    }

    const server = this.server;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.closeAllConnections();
        this.logger.warn(`Forced shutdown after ${this.config.shutdownTimeoutMs}ms timeout`);
        resolve();
      }, this.config.shutdownTimeoutMs);

      server.close((err) => {
        clearTimeout(timeout);
        this.server = null;
        if (err) {
          this.logger.error('Error while closing server', err);
          reject(err);
        } else {
          this.logger.info(`Service ${this.config.serviceName} stopped gracefully.`);
          resolve();
        }
      });
      server.closeIdleConnections();
      server.closeAllConnections();
    });
  }
}
