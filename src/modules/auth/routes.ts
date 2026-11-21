import { Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { clientIp } from '../../middleware/rateLimit.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { createLogger } from '../../shared/logger.ts';
import { unauthorized } from '../../shared/problem.ts';
import {
  type ForgotPasswordInput,
  forgotPasswordSchema,
  type LoginInput,
  loginSchema,
  type RefreshInput,
  type RegisterInput,
  type ResetPasswordInput,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from '../schemas.ts';
import {
  createUser,
  normalizeEmail,
  requestPasswordReset,
  resetPassword,
  TokenService,
  verifyPassword,
} from './service.ts';

const logger = createLogger('auth');

export const createAuthRouter = (deps: AppDeps): Router => {
  const router = Router();
  const tokens = new TokenService(deps.env, deps.collections);

  router.post('/register', validate({ body: registerSchema }), async (req, res, next) => {
    try {
      const body = validated<RegisterInput>(req, 'body');
      const user = await createUser({
        collections: deps.collections,
        email: body.email,
        password: body.password,
      });
      const accessToken = await tokens.signAccessToken({ userId: user.id, role: user.role });
      const refreshToken = await tokens.issueRefreshToken({ userId: user.id });
      res.status(201).json(
        buildEnvelope({
          data: {
            user: { id: user.id, email: user.email, role: user.role },
            accessToken,
            refreshToken,
            tokenType: 'Bearer',
            expiresIn: deps.env.JWT_ACCESS_TTL,
          },
          self: '/v1/auth/register',
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/login',
    deps.rateLimiters.middleware('login', (req) => {
      const email =
        typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : 'unknown';
      return `${clientIp(req)}:${email}`;
    }),
    validate({ body: loginSchema }),
    async (req, res, next) => {
      try {
        const body = validated<LoginInput>(req, 'body');
        const lockKey = `lockout:${clientIp(req)}:${body.email}`;
        const locked = await deps.redis.get(lockKey);
        if (locked) {
          logger.warn({ email: body.email }, 'login blocked by lockout');
          throw unauthorized('Account temporarily locked due to repeated failed logins');
        }

        // The literal identifier "admin" is an alias for the seeded admin
        // account, so the admin can log in without typing the full email.
        const user =
          body.email === 'admin'
            ? await deps.collections.users.findOne({ role: 'admin', deletedAt: null })
            : await deps.collections.users.findOne({
                email: body.email,
                deletedAt: null,
              });
        const valid = user ? await verifyPassword(body.password, user.passwordHash) : false;
        if (!user || !valid) {
          const failures = await deps.redis.incr(`login:fail:${clientIp(req)}:${body.email}`);
          if (failures === 1)
            await deps.redis.expire(`login:fail:${clientIp(req)}:${body.email}`, 3600);
          if (failures >= deps.env.RATE_LIMIT_LOGIN_LOCKOUT_FAILURES) {
            await deps.redis.set(lockKey, '1', 'EX', deps.env.RATE_LIMIT_LOGIN_LOCKOUT_SECONDS);
          }
          throw unauthorized('Invalid email or password');
        }

        await deps.redis.del(`login:fail:${clientIp(req)}:${body.email}`);
        const accessToken = await tokens.signAccessToken({ userId: user._id, role: user.role });
        const refreshToken = await tokens.issueRefreshToken({ userId: user._id });
        res.json(
          buildEnvelope({
            data: {
              user: { id: user._id, email: user.email, role: user.role },
              accessToken,
              refreshToken,
              tokenType: 'Bearer',
              expiresIn: deps.env.JWT_ACCESS_TTL,
            },
            self: '/v1/auth/login',
            limit: 1,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/refresh', validate({ body: refreshSchema }), async (req, res, next) => {
    try {
      const body = validated<RefreshInput>(req, 'body');
      const rotated = await tokens.rotateRefreshToken(body.refreshToken);
      const user = await deps.collections.users.findOne({ _id: rotated.userId, deletedAt: null });
      if (!user) throw unauthorized('User no longer exists');
      const accessToken = await tokens.signAccessToken({ userId: user._id, role: user.role });
      res.json(
        buildEnvelope({
          data: {
            accessToken,
            refreshToken: rotated.refreshToken,
            tokenType: 'Bearer',
            expiresIn: deps.env.JWT_ACCESS_TTL,
          },
          self: '/v1/auth/refresh',
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', validate({ body: refreshSchema }), async (req, res, next) => {
    try {
      const body = validated<RefreshInput>(req, 'body');
      await tokens.revokeRefreshToken(body.refreshToken);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/forgot-password',
    deps.rateLimiters.middleware('login', (req) => {
      const email =
        typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : 'unknown';
      return `${clientIp(req)}:${email}`;
    }),
    validate({ body: forgotPasswordSchema }),
    async (req, res, next) => {
      try {
        const body = validated<ForgotPasswordInput>(req, 'body');
        await requestPasswordReset({
          collections: deps.collections,
          mailer: deps.notifications,
          email: body.email,
          webUrl: deps.env.WEB_URL,
          ttlSeconds: deps.env.PASSWORD_RESET_TTL_SECONDS,
          requestId: req.requestId,
        });
        res.json(
          buildEnvelope({
            data: {
              message: 'If an account exists for this email, a password reset link has been sent.',
            },
            self: '/v1/auth/forgot-password',
            limit: 1,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/reset-password',
    deps.rateLimiters.middleware('login', (req) => clientIp(req)),
    validate({ body: resetPasswordSchema }),
    async (req, res, next) => {
      try {
        const body = validated<ResetPasswordInput>(req, 'body');
        const result = await resetPassword({
          collections: deps.collections,
          token: body.token,
          password: body.password,
        });
        await tokens.revokeAllForUser(result.userId);
        res.json(
          buildEnvelope({
            data: { message: 'Password has been reset. You can now log in.' },
            self: '/v1/auth/reset-password',
            limit: 1,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
