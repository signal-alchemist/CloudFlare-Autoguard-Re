/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleCompatGateRequest } from "../lib/http/compat-gate.ts";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GUARD_SITE_ID?: string;
  GUARD_ENVIRONMENT?: "staging" | "production";
  CMS_GATE_SERVICE_TOKEN?: string;
  CMS_GATE_SIGNING_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/compat/v1/gate") {
      if (
        !env.GUARD_SITE_ID ||
        !env.GUARD_ENVIRONMENT ||
        !env.CMS_GATE_SERVICE_TOKEN ||
        !env.CMS_GATE_SIGNING_SECRET
      ) {
        return Response.json(
          { error: "service_unavailable" },
          {
            status: 503,
            headers: { "cache-control": "no-store" },
          },
        );
      }
      return handleCompatGateRequest(
        request,
        {
          siteId: env.GUARD_SITE_ID,
          environment: env.GUARD_ENVIRONMENT,
          serviceToken: env.CMS_GATE_SERVICE_TOKEN,
          signingSecret: env.CMS_GATE_SIGNING_SECRET,
          clock: Date.now,
        },
        {
          async read({ siteId, environment, nowSeconds }) {
            return {
              siteId,
              environment,
              gates: {
                contentPublish: "deny",
                siteDeploy: "deny",
              },
              checkedAt: nowSeconds,
              freshUntil: nowSeconds + 30,
              freeze: false,
            };
          },
        },
      );
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
