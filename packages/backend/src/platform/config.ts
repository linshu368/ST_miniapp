import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV || 'development',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
} as const;
