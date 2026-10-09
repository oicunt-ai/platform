export interface UsageAdmissionPort {
  checkHealth?(): Promise<boolean>;
  acquire(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly stream: boolean;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly leaseId?: string | undefined }>;
  release(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly leaseId: string;
  }): Promise<void>;
}
