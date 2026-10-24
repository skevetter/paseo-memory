import type { BridgeErrorCode } from "../shared/bridge";
import { ToolError } from "./mcp";

const STATUS: Record<BridgeErrorCode, number> = {
  unauthorized: 401,
  scope_denied: 403,
  lease_expired: 409,
  lease_conflict: 409,
  request_conflict: 409,
  context_invalidated: 409,
  revision_conflict: 409,
  budget_exhausted: 422,
  unavailable: 503,
  unsupported_version: 422,
};

export class BridgeFailure extends ToolError {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly bridgeCode: BridgeErrorCode,
    message: string,
    retryable = false,
  ) {
    super(bridgeCode, message);
    this.status = bridgeCode === "budget_exhausted" && retryable ? 503 : STATUS[bridgeCode];
    this.retryable = retryable;
  }
}
