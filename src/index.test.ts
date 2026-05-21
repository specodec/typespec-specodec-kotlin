import { describe, it, expect } from 'vitest';
import { mkScalar, mkArray } from '@specodec/typespec-emitter-core/test-utils';
import { typeToKotlin, readExpr, writeExpr, writeLines, defaultValue } from './index.js';

describe('typeToKotlin', () => {
  it('string → String', () => expect(typeToKotlin(mkScalar('string') as any)).toBe('String'));
  it('boolean → Boolean', () => expect(typeToKotlin(mkScalar('boolean') as any)).toBe('Boolean'));
  it('int32 → Int', () => expect(typeToKotlin(mkScalar('int32') as any)).toBe('Int'));
  it('int64 → Long', () => expect(typeToKotlin(mkScalar('int64') as any)).toBe('Long'));
  it('float32 → Float', () => expect(typeToKotlin(mkScalar('float32') as any)).toBe('Float'));
  it('float64 → Double', () => expect(typeToKotlin(mkScalar('float64') as any)).toBe('Double'));
  it('bytes → ByteArray', () => expect(typeToKotlin(mkScalar('bytes') as any)).toBe('ByteArray'));
  it('model → model name', () => expect(typeToKotlin({ kind: 'Model', name: 'User' } as any)).toBe('User'));
});

describe('readExpr', () => {
  it('int32', () => expect(readExpr(mkScalar('int32') as any)).toContain('readInt32'));
  it('string', () => expect(readExpr(mkScalar('string') as any)).toContain('readString'));
  it('bool', () => expect(readExpr(mkScalar('boolean') as any)).toContain('readBool'));
  it('float32', () => expect(readExpr(mkScalar('float32') as any)).toContain('readFloat32'));
  it('bytes', () => expect(readExpr(mkScalar('bytes') as any)).toContain('readBytes'));
});
