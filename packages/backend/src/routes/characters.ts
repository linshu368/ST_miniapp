import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { ok, fail } from '@miniapp/shared';
import type {
  GetCharactersData,
  GetCharacterByIdData,
  CharacterSummary,
  CharacterDetail,
} from '@miniapp/shared';

export default async function characterRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/characters', async (request, reply) => {
    const characters = await prisma.character.findMany({
      where: { enabled: true },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
    });

    const charactersSummary: CharacterSummary[] = characters.map(
      (c: (typeof characters)[number]) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        avatar_url: c.avatar_url,
        personality_tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
        author_name: c.creator,
      })
    );

    return reply.send(ok<GetCharactersData>({ characters: charactersSummary }));
  });

  // @frontend-ready: true
  app.get('/api/characters/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const character = await prisma.character.findFirst({
      where: { id, enabled: true },
    });

    if (!character) {
      return reply.status(404).send(fail('NOT_FOUND', 'Character not found'));
    }

    const characterDetail: CharacterDetail = {
      id: character.id,
      name: character.name,
      description: character.description,
      avatar_url: character.avatar_url,
      personality_tags: Array.isArray(character.tags) ? (character.tags as string[]) : [],
      author_name: character.creator,
      greeting: character.first_mes,
      creator_notes: character.creator_notes,
    };

    return reply.send(ok<GetCharacterByIdData>({ character: characterDetail }));
  });
}
