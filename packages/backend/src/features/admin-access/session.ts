import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../platform/config.js';
import { getSupabaseClient } from '../../lib/supabase.js';

export type AdminRole = 'owner' | 'operator' | 'viewer';
export type AdminAccess = 'read' | 'write';

export interface AdminActor {
  userId: string;
  role: AdminRole;
  canAccessTest: boolean;
  canAccessProd: boolean;
}

export class AdminSessionError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'AdminSessionError';
  }
}

function canAccessCurrentEnvironment(
  actor: Pick<AdminActor, 'canAccessTest' | 'canAccessProd'>
): boolean {
  return config.database.target === 'production' ? actor.canAccessProd : actor.canAccessTest;
}

function roleAllows(role: string, access: AdminAccess): role is AdminRole {
  if (access === 'read') return role === 'owner' || role === 'operator' || role === 'viewer';
  return role === 'owner' || role === 'operator';
}

/**
 * 当前部署环境上的 admin Bearer session。
 * 写操作只允许 owner/operator；读操作额外允许 viewer。环境权限不跨 TEST/Production。
 */
export async function requireAdminActor(
  authorization: string | undefined,
  access: AdminAccess
): Promise<AdminActor> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    throw new AdminSessionError(401, 'Admin session is required');
  }

  const supabase = getSupabaseClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) {
    throw new AdminSessionError(401, 'Admin session is invalid');
  }

  const { data: adminUser, error: adminError } = await supabase
    .schema('admin')
    .from('admin_users')
    .select('role,can_access_test,can_access_prod')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = adminUser?.role;
  if (
    adminError ||
    !adminUser ||
    typeof role !== 'string' ||
    !roleAllows(role, access) ||
    !canAccessCurrentEnvironment({
      canAccessTest: adminUser.can_access_test === true,
      canAccessProd: adminUser.can_access_prod === true,
    })
  ) {
    throw new AdminSessionError(
      403,
      access === 'write' ? 'Operator access is required' : 'Admin read access is required'
    );
  }

  return {
    userId: user.id,
    role,
    canAccessTest: adminUser.can_access_test === true,
    canAccessProd: adminUser.can_access_prod === true,
  };
}

export async function authorizeAdminOperator(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  try {
    await requireAdminActor(request.headers.authorization, 'write');
    return true;
  } catch (error) {
    if (error instanceof AdminSessionError) {
      await reply.status(error.statusCode).send({ message: error.message });
      return false;
    }
    throw error;
  }
}
