import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('authentication', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const tx = {
    user: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'user-1',
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash,
        createdAt: now,
        updatedAt: now,
      })),
    },
    session: { create: jest.fn().mockResolvedValue({}) },
  };
  const prismaMock = {
    $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    user: { findUnique: jest.fn() },
    session: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn(),
    },
  };
  const prisma = prismaMock as unknown as PrismaService;
  const auth = new AuthService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    );
    tx.user.create.mockImplementation(async ({ data }) => ({
      id: 'user-1',
      email: data.email,
      name: data.name,
      passwordHash: data.passwordHash,
      createdAt: now,
      updatedAt: now,
    }));
  });

  it('registers a user with a password hash and creates a bearer session', async () => {
    const result = await auth.register({
      email: 'user@example.com',
      name: 'User',
      password: 'secure-password',
    });

    expect(result.accessToken).toBeTruthy();
    expect(result.tokenType).toBe('Bearer');
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      createdAt: now,
    });
    const userData = tx.user.create.mock.calls[0]![0].data;
    expect(userData.passwordHash).toMatch(/^scrypt\$/);
    expect(userData.passwordHash).not.toBe('secure-password');
    expect(tx.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  it('rejects duplicate email and invalid login credentials', async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });
    prismaMock.$transaction.mockImplementationOnce(async () => {
      throw uniqueError;
    });
    await expect(
      auth.register({ email: 'user@example.com', password: 'secure-password' }),
    ).rejects.toBeInstanceOf(ConflictException);

    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      auth.login({ email: 'user@example.com', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logs in with the registered password and revokes the session on logout', async () => {
    await auth.register({ email: 'user@example.com', password: 'secure-password' });
    const passwordHash = tx.user.create.mock.calls[0]![0].data.passwordHash as string;
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      passwordHash,
      createdAt: now,
    });

    const login = await auth.login({ email: 'user@example.com', password: 'secure-password' });
    expect(login.accessToken).toBeTruthy();
    expect(prismaMock.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1' }),
    });

    await expect(auth.logout('session-1')).resolves.toEqual({ success: true });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { id: 'session-1' } });
  });

  it('requires a live bearer session for protected requests', async () => {
    const guard = new AuthGuard(prisma);
    const request: { headers: { authorization?: string }; [key: string]: unknown } = {
      headers: { authorization: 'Bearer valid-token' },
    };
    prismaMock.session.findFirst.mockResolvedValue({
      id: 'session-1',
      user: { id: 'user-1', email: 'user@example.com', name: null },
    });
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toMatchObject({ sessionId: 'session-1', user: { id: 'user-1' } });

    prismaMock.session.findFirst.mockResolvedValueOnce(null);
    request.headers.authorization = 'Bearer expired-token';
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    request.headers.authorization = undefined;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
