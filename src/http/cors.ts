import type { NextFunction, Request, Response } from 'express';

function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const configured = [process.env.ALLOWED_ORIGINS, process.env.FRONTEND_URL]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes('*') || configured.includes(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return origin;
  return null;
}

export function corsMiddleware(request: Request, response: Response, next: NextFunction): void {
  const origin = request.headers.origin;
  const allow = allowedOrigin(origin);
  if (allow) {
    response.setHeader('Access-Control-Allow-Origin', allow);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  response.setHeader('Access-Control-Max-Age', '86400');
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  next();
}