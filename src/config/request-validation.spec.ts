import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../auth/dto/register.dto';
import { LoginDto } from '../auth/dto/login.dto';
import { CreateWorkspaceDto } from '../workspaces/dto/create-workspace.dto';
import { UpdateWorkspaceDto } from '../workspaces/dto/update-workspace.dto';
import { CreateKnowledgeBaseDto } from '../knowledge-bases/dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from '../knowledge-bases/dto/update-knowledge-base.dto';

describe('request validation', () => {
  async function invalidProperties<T extends object>(type: new () => T, input: object) {
    const errors = await validate(plainToInstance(type, input), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map(({ property }) => property);
  }

  it('rejects invalid registration and login input', async () => {
    expect(await invalidProperties(RegisterDto, { email: 'bad-email', password: 'short' })).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
    expect(await invalidProperties(LoginDto, { email: 'bad-email', password: '' })).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
  });

  it('normalizes auth email and rejects unexpected fields', async () => {
    const registration = plainToInstance(RegisterDto, {
      email: ' USER@EXAMPLE.COM ',
      password: 'secure-password',
    });
    expect(registration.email).toBe('user@example.com');
    expect(
      await invalidProperties(RegisterDto, {
        email: 'user@example.com',
        password: 'secure-password',
        admin: true,
      }),
    ).toContain('admin');
  });

  it('rejects empty and invalid workspace names', async () => {
    expect(await invalidProperties(CreateWorkspaceDto, { name: '   ' })).toContain('name');
    expect(await invalidProperties(UpdateWorkspaceDto, {})).toContain('name');
    expect(await invalidProperties(UpdateWorkspaceDto, { name: null })).toContain('name');
  });

  it('rejects invalid knowledge base names and descriptions', async () => {
    expect(await invalidProperties(CreateKnowledgeBaseDto, { name: '' })).toContain('name');
    expect(
      await invalidProperties(CreateKnowledgeBaseDto, { name: 'OK', description: 42 }),
    ).toContain('description');
    expect(await invalidProperties(UpdateKnowledgeBaseDto, { name: null })).toContain('name');
  });
});
