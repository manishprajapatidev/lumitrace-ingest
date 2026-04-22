import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

export const emailService = {
  async sendOtp(email: string, code: string, expiresInSec: number): Promise<void> {
    if (config.AUTH_LOG_OTPS) {
      logger.info({ email, code, expiresInSec }, 'stub otp email sent');
      return;
    }
    logger.info({ email, expiresInSec }, 'stub otp email suppressed');
  },
};
