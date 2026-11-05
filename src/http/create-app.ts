/**
 * Gate 0: Express 앱 조립 지점.
 *
 * 라우터는 각 모듈이 소유하고, 이 파일은 공통 미들웨어(요청 ID·JSON·인증·오류 봉투)만
 * 붙인다. 라우터가 하나도 없어도 앱이 뜨도록 만들어 통합 전에도 계약 테스트가 가능하다.
 */
import { randomUUID } from 'node:crypto';

import express, { type Express, type Router } from 'express';

import { requireActor, type AuthVerifier } from './auth.js';
import { corsMiddleware } from './cors.js';
import { HttpError, errorHandler } from './envelope.js';

export const API_BASE_PATH = '/api/v1';

export interface MountedRouter {
  readonly basePath: string;
  readonly router: Router;
}

export interface AppOptions {
  readonly auth: AuthVerifier;
  readonly routers?: readonly MountedRouter[];
  readonly bodyLimit?: string;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware);
  app.use(express.json({ limit: options.bodyLimit ?? '1mb' }));

  app.use((request, response, next) => {
    const requestId = request.header('x-request-id') ?? randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    next();
  });

  app.get('/health', (_request, response) => {
    response.status(200).json({ data: { status: 'ok' } });
  });

  const authenticated = requireActor(options.auth);
  for (const mounted of options.routers ?? []) {
    app.use(`${API_BASE_PATH}${mounted.basePath}`, authenticated, mounted.router);
  }

  app.use((_request, _response, next) => {
    next(new HttpError(404, 'NOT_FOUND', '요청한 경로를 찾을 수 없습니다.'));
  });

  app.use(errorHandler);
  return app;
}
