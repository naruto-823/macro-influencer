import { describe, expect, it } from 'vitest';
import { parseJson } from './client.js';

describe('parseJson 容错', () => {
  it('解析干净 JSON', () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥离 ```json 代码块', () => {
    expect(parseJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('丢弃 JSON 前后的解释文字', () => {
    expect(parseJson<{ a: number }>('好的，结果如下：{"a":1} 完毕')).toEqual({ a: 1 });
  });

  it('修复字符串内部的裸换行（LLM 写正文常见）', () => {
    const malformed = '{"title":"标题","body":"第一行\n第二行\n第三行"}';
    expect(parseJson<{ title: string; body: string }>(malformed)).toEqual({
      title: '标题',
      body: '第一行\n第二行\n第三行',
    });
  });

  it('已正确转义的 \\n 不被破坏', () => {
    expect(parseJson<{ body: string }>('{"body":"a\\nb"}')).toEqual({ body: 'a\nb' });
  });
});
