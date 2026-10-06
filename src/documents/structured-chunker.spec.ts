import { chunkStructuredBlocks, ParsedBlock } from './structured-chunker';

describe('chunkStructuredBlocks', () => {
  it('keeps page, heading, paragraph, and table row locations in metadata', () => {
    const blocks: ParsedBlock[] = [
      {
        text: '请假制度',
        pageNumber: 12,
        headingPath: ['员工手册', '请假制度'],
        paragraphIndex: 8,
        blockType: 'heading',
      },
      {
        text: '员工应提前申请年假。',
        pageNumber: 12,
        headingPath: ['员工手册', '请假制度'],
        paragraphIndex: 9,
        blockType: 'paragraph',
      },
      {
        text: '年假 | 10 天',
        pageNumber: 12,
        headingPath: ['员工手册', '请假制度'],
        paragraphIndex: 10,
        blockType: 'table',
        tableIndex: 0,
        rowIndex: 1,
      },
    ];
    const [chunk] = chunkStructuredBlocks(blocks);
    expect(chunk).toMatchObject({
      metadata: {
        pageNumber: 12,
        headingPath: ['员工手册', '请假制度'],
        paragraphStart: 8,
        paragraphEnd: 10,
        paragraphPositions: [8, 9, 10],
        tableInfo: [{ tableIndex: 0, rowIndex: 1 }],
      },
    });
    expect(chunk?.content).toContain('年假 | 10 天');
  });

  it('splits oversized paragraphs while retaining their source location', () => {
    const [first, second] = chunkStructuredBlocks(
      [
        {
          text: '甲'.repeat(40),
          pageNumber: 3,
          headingPath: ['A'],
          paragraphIndex: 2,
          blockType: 'paragraph',
        },
      ],
      24,
      4,
    );
    expect(first?.content).toHaveLength(24);
    expect(second?.content).toHaveLength(20);
    expect(second?.metadata).toMatchObject({
      pageNumber: 3,
      headingPath: ['A'],
      paragraphPositions: [2],
    });
  });
});
