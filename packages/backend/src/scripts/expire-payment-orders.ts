import '../platform/config.js';
import { getSupabaseClient } from '../lib/supabase.js';

const db = getSupabaseClient().schema('miniapp');

const { data, error } = await db.rpc('expire_payment_orders', {
  p_user_id: null,
});

if (error) {
  console.error(`Expire payment orders failed: ${error.message}`);
  process.exit(1);
}

console.log(`Expired payment orders: ${typeof data === 'number' ? data : 0}`);
