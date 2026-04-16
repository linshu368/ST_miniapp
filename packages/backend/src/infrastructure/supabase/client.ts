import { createClient } from '@supabase/supabase-js';
import { config } from '../../platform/config.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseKey);