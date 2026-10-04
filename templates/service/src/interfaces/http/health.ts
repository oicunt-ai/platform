import type { ServerResponse } from 'node:http';
import { HttpStatus, type ApiResponse, type ApiErrorResponse } from '@oicunt/contracts';

export interface HealthStatusData {
  readonly status: 'alive' | 'ready' | 'not_ready';
  readonly serviceName: string;
  readonly version: string;
  readonly timestamp: string;
}

export function sendLivenessResponse(
  res: ServerResponse,
  serviceName: string,
  version: string,
): void {
  const payload: ApiResponse<HealthStatusData> = {
    success: true,
    data: {
      status: 'alive',
      serviceName,
      version,
      timestamp: new Date().toISOString(),
    },
  };

  res.writeHead(HttpStatus.OK, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

export function sendReadinessResponse(
  res: ServerResponse,
  isReady: boolean,
  serviceName: string,
  version: string,
): void {
  if (isReady) {
    const payload: ApiResponse<HealthStatusData> = {
      success: true,
      data: {
        status: 'ready',
        serviceName,
        version,
        timestamp: new Date().toISOString(),
      },
    };

    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(payload));
  } else {
    const errorPayload: ApiErrorResponse = {
      success: false,
      error: {
        code: 'SERVICE_NOT_READY',
        message: 'The service is initializing or dependencies are not reachable',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    };

    res.writeHead(HttpStatus.SERVICE_UNAVAILABLE, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(errorPayload));
  }
}
