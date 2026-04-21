import { TelegramUser } from '../middleware/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: TelegramUser;
  }
}
