import type { PricingCalculationResult } from "../pricing/index.ts";

export interface ApiIssue {
  path: string;
  message: string;
}

export interface ApiSuccessBody {
  ok: true;
  data: PricingCalculationResult;
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    issues?: ApiIssue[];
  };
}

export type ApiResponseBody = ApiSuccessBody | ApiErrorBody;

export interface ApiResult {
  status: number;
  body: ApiResponseBody;
}
