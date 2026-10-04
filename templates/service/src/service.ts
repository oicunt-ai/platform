import { createServer, type Server } from 'node:http';
import type { Logger } from '@oicunt/logging';
import { MemoryLogger } from '@oicunt/logging';
import type { Tracer } from '@oicunt/observability';
import { NoopTracer } from '@oicunt/observability';
import { loadServiceConfig, type ServiceConfig } from './config.js';
import { createHttpRouter } from './interfaces/index.js';

export interface ServiceDependencies {
  readonly config?: ServiceConfig;
  readonly logger?: Logger;
  readonly tracer?: Tracer;
}

export class ServiceInstance {
  private readonly config: ServiceConfig;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private server: Server | null = null;
  private ready = false;

  constructor(dependencies: ServiceDependencies = {}) {
    this.config = dependencies.config ?? loadServiceConfig();
    this.logger = dependencies.logger ?? new MemoryLogger({ service: this.config.serviceName });
    this.tracer = dependencies.tracer ?? new NoopTracer();
  }

  getConfig(): ServiceConfig {
    return this.config;
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    this.logger.info(`Initializing service ${this.config.serviceName}...`, {
      environment: this.config.environment,
      version: this.config.version,
    });

    const router = createHttpRouter({
      serviceName: this.config.serviceName,
      version: this.config.version,
      isReady: () => this.ready,
      logger: this.logger,
      tracer: this.tracer,
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.logger.warn(`Forced shutdown after ${this.config.shutdownTimeoutMs}ms timeout`);
        resolve();
      }, this.config.shutdownTimeoutMs);

      this.server?.close((err) => {
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
    });
  }
}
