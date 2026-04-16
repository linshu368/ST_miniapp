import type { FastifyInstance } from 'fastify';
import { getCharacters, getCharacterById } from './character.usecase.js';

export async function characterRoutes(app: FastifyInstance) {
  app.get('/characters', async () => {
    return getCharacters();
  });

  app.get<{ Params: { id: string } }>('/characters/:id', async (request, reply) => {
    const { id } = request.params;
    const result = await getCharacterById(id);

    if (!result) {
      reply.status(404);
      return { success: false, error: { code: 'NOT_FOUND', message: 'Character not found' } };
    }

    return result;
  });
}