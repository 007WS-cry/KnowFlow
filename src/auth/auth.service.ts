import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const KEY_LENGTH = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'createdAt'>;

function deriveKey(password: string, salt: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      length,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterDto) {
    const salt = randomBytes(16).toString('hex');
    const passwordHash = await this.hashPassword(input.password, salt);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            passwordHash,
            name: input.name?.trim() || null,
          },
        });

        await tx.session.create({ data: { userId: created.id, tokenHash, expiresAt } });
        return created;
      });

      return this.sessionResponse(user, token, expiresAt);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该邮箱已注册');
      }
      throw error;
    }
  }

  async login(input: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.passwordHash || !(await this.verifyPassword(input.password, user.passwordHash))) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.session.create({
      data: { userId: user.id, tokenHash: this.hashToken(token), expiresAt },
    });

    return this.sessionResponse(user, token, expiresAt);
  }

  async logout(sessionId: string): Promise<{ success: true }> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
    return { success: true };
  }

  private async hashPassword(password: string, salt: string): Promise<string> {
    const derivedKey = await deriveKey(password, salt, KEY_LENGTH);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derivedKey.toString('hex')}`;
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [algorithm, nText, rText, pText, salt, keyHex] = stored.split('$');
    if (algorithm !== 'scrypt' || !salt || !keyHex) return false;

    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== KEY_LENGTH) return false;

    if (
      Number(nText) !== SCRYPT_N ||
      Number(rText) !== SCRYPT_R ||
      Number(pText) !== SCRYPT_P
    ) {
      return false;
    }
    const derivedKey = await deriveKey(password, salt, expected.length);

    return timingSafeEqual(derivedKey, expected);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sessionResponse(user: User, accessToken: string, expiresAt: Date) {
    const publicUser: PublicUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    };

    return { accessToken, tokenType: 'Bearer', expiresAt, user: publicUser };
  }
}
