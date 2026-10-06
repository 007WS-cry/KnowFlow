export interface ParsedBlock {
  text: string;
  pageNumber?: number;
  headingPath: string[];
  paragraphIndex: number;
  blockType: 'heading' | 'paragraph' | 'table';
  tableIndex?: number;
  rowIndex?: number;
}

export interface StructuredChunk {
  content: string;
  metadata: {
    pageNumber: number | null;
    headingPath: string[];
    paragraphStart: number;
    paragraphEnd: number;
    paragraphPositions: number[];
    tableInfo: Array<{ tableIndex: number; rowIndex: number }>;
  };
}

export function chunkStructuredBlocks(
  blocks: ParsedBlock[],
  maxCharacters = 1_200,
  overlapCharacters = 160,
): StructuredChunk[] {
  const normalized = blocks
    .map((block) => ({ ...block, text: block.text.replaceAll('\u0000', '').trim() }))
    .filter((block) => block.text.length > 0);
  const result: StructuredChunk[] = [];
  let current: ParsedBlock[] = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    const paragraphPositions = [...new Set(current.map(({ paragraphIndex }) => paragraphIndex))];
    const pages = [
      ...new Set(
        current
          .map(({ pageNumber }) => pageNumber)
          .filter((value): value is number => value !== undefined),
      ),
    ];
    const latestPath =
      [...current].reverse().find(({ headingPath }) => headingPath.length)?.headingPath ?? [];
    result.push({
      content: current.map(({ text }) => text).join('\n\n'),
      metadata: {
        pageNumber: pages.length === 1 ? pages[0]! : null,
        headingPath: latestPath,
        paragraphStart: Math.min(...paragraphPositions),
        paragraphEnd: Math.max(...paragraphPositions),
        paragraphPositions,
        tableInfo: current
          .filter(
            (block): block is ParsedBlock & { tableIndex: number; rowIndex: number } =>
              block.blockType === 'table' &&
              block.tableIndex !== undefined &&
              block.rowIndex !== undefined,
          )
          .map(({ tableIndex, rowIndex }) => ({ tableIndex, rowIndex })),
      },
    });
    current = [];
    currentLength = 0;
  };

  for (const block of normalized) {
    if (block.text.length > maxCharacters) {
      flush();
      for (let start = 0; start < block.text.length; start += maxCharacters - overlapCharacters) {
        const text = block.text.slice(start, start + maxCharacters).trim();
        if (!text) continue;
        current = [{ ...block, text }];
        currentLength = text.length;
        flush();
      }
      continue;
    }
    const addedLength = block.text.length + (current.length ? 2 : 0);
    if (currentLength + addedLength > maxCharacters) {
      const previous = current;
      flush();
      const tail: ParsedBlock[] = [];
      let tailLength = 0;
      for (let index = previous.length - 1; index >= 0; index -= 1) {
        const item = previous[index]!;
        if (tailLength + item.text.length > overlapCharacters) break;
        tail.unshift(item);
        tailLength += item.text.length + 2;
      }
      current = tail;
      currentLength = tailLength;
    }
    current.push(block);
    currentLength += addedLength;
  }
  flush();
  return result;
}
