import { repairFilenameEncoding } from './filename-encoding';

describe('repairFilenameEncoding', () => {
  it('repairs UTF-8 filenames that were decoded as Latin-1', () => {
    const filename = 'KnowFlow 企业知识库平台使用手册.md';
    const mojibake = Buffer.from(filename, 'utf8').toString('latin1');

    expect(repairFilenameEncoding(mojibake)).toBe(filename);
  });

  it('preserves correctly decoded Unicode and ordinary ASCII filenames', () => {
    expect(repairFilenameEncoding('研发部门信息安全规范.md')).toBe('研发部门信息安全规范.md');
    expect(repairFilenameEncoding('product-notes-v2.md')).toBe('product-notes-v2.md');
  });

  it('leaves invalid byte sequences unchanged instead of introducing replacement characters', () => {
    expect(repairFilenameEncoding('ä\u0081.md')).toBe('ä\u0081.md');
  });
});
