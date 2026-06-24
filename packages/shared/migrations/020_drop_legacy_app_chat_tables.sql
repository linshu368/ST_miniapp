-- Drop legacy phase-one MiniApp self-hosted chat tables.
--
-- Phase two uses SillyTavern as the runtime source of truth and mirrors user chat
-- history through st_users.user_st_chats. The old miniapp.app_sessions /
-- miniapp.app_messages tables must not remain as a new-code dependency.

DROP TABLE IF EXISTS miniapp.app_messages CASCADE;
DROP TABLE IF EXISTS miniapp.app_sessions CASCADE;
