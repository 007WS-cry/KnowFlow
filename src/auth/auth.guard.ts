import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from './auth.types';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      throw new UnauthorizedException('请先登录');
    }

    const tokenHash = createHash('sha256').update(match[1]!).digest('hex');
    const session = await this.prisma.session.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        user: { select: { id: true, email: true, name: true } },
      },
    });

    if (!session) {
      throw new UnauthorizedException('登录已过期或凭证无效');
    }

    request.user = session.user;
    request.sessionId = session.id;
    return true;
  }
}
