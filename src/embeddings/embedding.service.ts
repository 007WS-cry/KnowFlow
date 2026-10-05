import { Injectable } from '@nestjs/common';
import { VECTOR_DIMENSIONS } from './vector.constants';

@Injectable()
export class EmbeddingService {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
    const normalized = text.normalize('NFKC').toLowerCase();

    for (const word of normalized.match(/[\p{L}\p{N}_]+/gu) ?? []) {
      if (!/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(word)) {
        this.addFeature(vector, `w:${word}`, 1.5);
        continue;
      }

      const characters = Array.from(word);
      for (let index = 0; index < characters.length; index += 1) {
        this.addFeature(vector, `c:${characters[index]}`, 0.35);
        if (index + 1 < characters.length) {
          this.addFeature(vector, `b:${characters[index]}${characters[index + 1]}`, 1.25);
        }
        if (index + 2 < characters.length) {
          this.addFeature(
            vector,
            `t:${characters[index]}${characters[index + 1]}${characters[index + 2]}`,
            1,
          );
        }
      }
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude === 0) return vector;
    return vector.map((value) => value / magnitude);
  }

  toPgVector(vector: number[]): string {
    if (vector.length !== VECTOR_DIMENSIONS) {
      throw new Error(`Expected a ${VECTOR_DIMENSIONS}-dimension embedding`);
    }
    return `[${vector.map((value) => (Number.isFinite(value) ? value.toFixed(8) : '0')).join(',')}]`;
  }

  private addFeature(vector: number[], feature: string, weight: number): void {
    let hash = 2_166_136_261;
    for (let index = 0; index < feature.length; index += 1) {
      hash = Math.imul(hash ^ feature.charCodeAt(index), 16_777_619);
    }
    const unsignedHash = hash >>> 0;
    const bucket = unsignedHash % VECTOR_DIMENSIONS;
    vector[bucket] =
      (vector[bucket] ?? 0) + ((unsignedHash & 0x8000_0000) === 0 ? weight : -weight);
  }
}
