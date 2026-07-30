import type {
  SignedMaintenanceReceipt,
  VerifiedMaintenanceRequest,
} from "../contracts/maintenance-request.ts";
import type { D1MaintenanceRequestRepository } from "../repositories/maintenance-requests.ts";

export interface ProcessMaintenanceRequestDependencies {
  repository: D1MaintenanceRequestRepository;
  signingSecret: string;
}

export interface ProcessMaintenanceRequestResult {
  status: "accepted" | "duplicate";
  receipt: SignedMaintenanceReceipt;
}

export async function processMaintenanceRequest(
  verified: VerifiedMaintenanceRequest,
  dependencies: ProcessMaintenanceRequestDependencies,
): Promise<ProcessMaintenanceRequestResult> {
  return dependencies.repository.record(
    verified,
    dependencies.signingSecret,
  );
}
